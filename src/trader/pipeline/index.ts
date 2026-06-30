import { config } from '../../shared/config.js';
import { createLogger } from '../../shared/logger.js';
import type {
  Callout,
  CalloutParser,
  Decision,
  DecisionKind,
  DiscordEnvelope,
  OptionContract,
  PostReceipt,
  SubmittedOrder,
} from '../../shared/types.js';
import type { RobinhoodTools } from '../rh/tools.js';
import type { DecisionLog } from '../decisionLog.js';
import { checkRisk, recordTrade } from './riskFilter.js';

const log = createLogger('trader:pipeline');

export interface PipelineDeps {
  readonly parser: CalloutParser;
  readonly tools: RobinhoodTools;
  readonly decisions: DecisionLog;
  readonly postReceipt: PostReceipt;
}

/**
 * Thrown when the current account balance makes a trade unviable (e.g. even
 * one contract would exceed the single-contract cap). Surfaces as
 * `risk_rejected` in the decision log rather than `execution_failed`.
 */
class CapitalConstraintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapitalConstraintError';
  }
}

/**
 * Full pipeline for one Discord message:
 *  1. LLM parse  → structured Callout
 *  2. Risk check → deterministic guards + portfolio-percentage sizing
 *  3. Fetch buying power (always — needed for capital validation even when qty is explicit)
 *  4. Submit     → place equity or options order via Robinhood MCP
 */
export async function runPipeline(
  envelope: DiscordEnvelope,
  deps: PipelineDeps
): Promise<Decision> {
  const at = new Date().toISOString();

  // ---- 1. Parse -----------------------------------------------------------
  let callout: Callout;
  try {
    callout = await deps.parser.parse(envelope);
  } catch (err) {
    return finalize(deps, { at, envelope, callout: null, kind: 'parser_error', reason: errMsg(err), order: null });
  }

  if (!callout.isCallout) {
    return finalize(deps, { at, envelope, callout, kind: 'not_callout', reason: callout.rationale || 'not a callout', order: null });
  }

  // ---- 2. Risk check ------------------------------------------------------
  const risk = await checkRisk(callout);
  if (!risk.allow) {
    return finalize(deps, { at, envelope, callout, kind: 'risk_rejected', reason: risk.reason, order: null });
  }

  const symbol = callout.ticker!.toUpperCase();
  const side   = callout.action!;

  // ---- 3. Fetch buying power ----------------------------------------------
  // Always fetched: even explicit quantities are validated against capital so
  // we never exceed the configured percentage limits.
  let buyingPower: number;
  try {
    const bp = await deps.tools.getBuyingPower();
    buyingPower = bp.amountUsd;
  } catch (err) {
    return finalize(deps, { at, envelope, callout, kind: 'execution_failed', reason: `buying power fetch failed: ${errMsg(err)}`, order: null });
  }

  if (buyingPower <= 0) {
    return finalize(deps, { at, envelope, callout, kind: 'risk_rejected', reason: 'buying power is zero — no capital available', order: null });
  }

  // ---- 4. Execute ---------------------------------------------------------
  try {
    const placed =
      risk.assetType === 'option'
        ? await executeOptions(symbol, side, risk, callout, buyingPower, deps)
        : await executeEquity(symbol, side, risk, callout, buyingPower, deps);

    await recordTrade(symbol);

    const order: SubmittedOrder = {
      symbol,
      side,
      assetType: risk.assetType,
      quantity: placed.quantity,
      orderType: risk.orderType,
      limitPrice: risk.limitPrice,
      option: risk.assetType === 'option' ? callout.option : null,
      orderId: placed.orderId,
      status: placed.status ?? 'submitted',
    };

    return finalize(deps, { at, envelope, callout, kind: 'submitted', reason: summarize(order, envelope.authorName), order });
  } catch (err) {
    const kind = err instanceof CapitalConstraintError ? 'risk_rejected' : 'execution_failed';
    return finalize(deps, { at, envelope, callout, kind, reason: errMsg(err), order: null });
  }
}

// =============================================================================
// Execution paths
// =============================================================================

type RiskAllow = Extract<Awaited<ReturnType<typeof checkRisk>>, { allow: true }>;

interface PlacedResult {
  readonly orderId: string | null;
  readonly status: string | null;
  readonly quantity: number;
}

async function executeEquity(
  symbol: string,
  side: 'buy' | 'sell',
  risk: RiskAllow,
  callout: Callout,
  buyingPower: number,
  deps: PipelineDeps
): Promise<PlacedResult> {
  const price =
    risk.limitPrice !== null
      ? risk.limitPrice
      : await deps.tools.getQuote(symbol).then((q) => q.price);
  if (price === null) throw new Error(`could not determine price for ${symbol}`);

  let quantity: number;

  if (risk.quantityHint !== null) {
    quantity = risk.quantityHint;
  } else {
    const maxNotional = buyingPower * risk.portfolioPct / 100;
    const targetNotional =
      callout.sizeHint?.kind === 'usd'
        ? Math.min(callout.sizeHint.value, maxNotional)
        : maxNotional;
    quantity = Math.floor(targetNotional / price);
  }

  if (quantity < 1) {
    const shareCostPct = (price / buyingPower * 100).toFixed(1);
    throw new CapitalConstraintError(
      `1 share of ${symbol} costs $${price.toFixed(2)} (${shareCostPct}% of $${buyingPower.toFixed(0)} buying power) ` +
      `— insufficient capital for target allocation`
    );
  }

  const result = await deps.tools.placeOrder({
    symbol, side, orderType: risk.orderType, quantity,
    ...(risk.limitPrice !== null ? { limitPrice: risk.limitPrice } : {}),
  });
  return { orderId: result.orderId, status: result.status, quantity };
}

async function executeOptions(
  symbol: string,
  side: 'buy' | 'sell',
  risk: RiskAllow,
  callout: Callout,
  buyingPower: number,
  deps: PipelineDeps
): Promise<PlacedResult> {
  const option = callout.option!;

  // ---- Resolve premium ----------------------------------------------------
  // limitPrice from the callout takes precedence; otherwise fetch mark price.
  const premium: number | null =
    risk.limitPrice !== null
      ? risk.limitPrice
      : await deps.tools
          .getOptionsMarkPrice(symbol, option.optionType, option.strike, option.expiration)
          .then((q) => q?.markPrice ?? null);

  // Cost in USD to enter one contract (each controls 100 shares).
  const contractCost = premium !== null ? premium * 100 : null;

  // ---- Gate: is this trade viable at all? ---------------------------------
  // If we know the cost, reject outright when even 1 contract would exceed
  // the single-contract cap. This prevents entering tiny but over-weighted
  // positions (e.g. a $3 premium on a $5,000 account = 6% per contract).
  if (contractCost !== null) {
    const singleContractPct = (contractCost / buyingPower) * 100;
    if (singleContractPct > config.maxSingleContractPct) {
      throw new CapitalConstraintError(
        `1 ${symbol} contract costs $${contractCost.toFixed(2)} ` +
        `(${singleContractPct.toFixed(1)}% of $${buyingPower.toFixed(0)} buying power), ` +
        `exceeds MAX_SINGLE_CONTRACT_PCT (${config.maxSingleContractPct}%) — trade skipped`
      );
    }
  }

  // ---- Resolve contract count ---------------------------------------------
  let contracts: number;

  if (risk.quantityHint !== null) {
    // Explicit count from message — accept it, but cap to the hard maximum.
    contracts = risk.quantityHint;
  } else if (contractCost !== null) {
    const notionalBudget = buyingPower * risk.portfolioPct / 100;
    contracts = Math.floor(notionalBudget / contractCost);

    if (contracts < 1) {
      // Target budget is smaller than one contract. The viability gate above
      // already confirmed 1 contract is within the absolute cap, so fall back
      // to the minimum viable position rather than skipping.
      log.info('target budget sub-threshold: falling back to 1 contract', {
        symbol,
        strike: option.strike,
        notionalBudget: `$${notionalBudget.toFixed(2)}`,
        contractCost: `$${contractCost.toFixed(2)}`,
        portfolioPct: `${risk.portfolioPct.toFixed(2)}%`,
      });
      contracts = 1;
    }
  } else {
    // Premium is unknown (market order, quote unavailable) — minimum safe size.
    log.warn('options premium unknown, defaulting to 1 contract', {
      symbol, strike: option.strike, expiration: option.expiration,
    });
    contracts = 1;
  }

  // ---- Hard cap: never exceed maxOptionsNotionalPct -----------------------
  // Applies regardless of whether contracts came from a hint or budget math.
  if (contractCost !== null) {
    const hardMax = Math.max(1, Math.floor(buyingPower * config.maxOptionsNotionalPct / 100 / contractCost));
    if (contracts > hardMax) {
      log.warn('capping contracts to hard max', {
        symbol, requested: contracts, capped: hardMax,
        hardMaxPct: `${config.maxOptionsNotionalPct}%`,
      });
      contracts = hardMax;
    }

    // Log actual capital allocation for this trade.
    const actualCost = contracts * contractCost;
    const actualPct  = (actualCost / buyingPower * 100).toFixed(2);
    log.info('options position sized', {
      symbol,
      contracts,
      premium: premium?.toFixed(2),
      totalCost: `$${actualCost.toFixed(2)}`,
      portfolioAllocation: `${actualPct}%`,
      buyingPower: `$${buyingPower.toFixed(0)}`,
    });
  }

  const result = await deps.tools.placeOptionsOrder({
    symbol, optionType: option.optionType, strike: option.strike,
    expiration: option.expiration, contracts, side, orderType: risk.orderType,
    ...(risk.limitPrice !== null ? { limitPremium: risk.limitPrice } : {}),
  });
  return { orderId: result.orderId, status: result.status, quantity: contracts };
}

// =============================================================================
// Helpers
// =============================================================================

async function finalize(deps: PipelineDeps, decision: Decision): Promise<Decision> {
  await deps.decisions.append(decision);
  log.info('pipeline complete', { messageId: decision.envelope.messageId, kind: decision.kind, reason: decision.reason });
  if (shouldNotify(decision.kind)) {
    await deps.postReceipt(decision.envelope.channelId, decision.reason).catch((err) =>
      log.warn('postReceipt failed', { error: errMsg(err) })
    );
  }
  return decision;
}

const shouldNotify = (kind: DecisionKind): boolean =>
  kind === 'risk_rejected' || kind === 'submitted' || kind === 'execution_failed';

const errMsg = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

function summarize(order: SubmittedOrder, authorName: string): string {
  const verb = order.side === 'buy' ? 'Bought' : 'Sold';
  const orderRef = order.orderId ? `, order ${order.orderId}` : '';

  if (order.assetType === 'option' && order.option) {
    const { optionType, strike, expiration } = order.option;
    const priceText =
      order.orderType === 'limit' && order.limitPrice !== null
        ? `limit $${order.limitPrice.toFixed(2)}/contract`
        : 'market';
    return (
      `${verb} ${order.quantity}x ${order.symbol} ${strike}${optionType[0]?.toUpperCase()} ${expiration} (${priceText}). ` +
      `Status: ${order.status ?? 'submitted'}${orderRef}. From @${authorName}.`
    );
  }

  const priceText =
    order.orderType === 'limit' && order.limitPrice !== null
      ? `limit $${order.limitPrice.toFixed(2)}`
      : 'market';
  return (
    `${verb} ${order.quantity} ${order.symbol} (${priceText}). ` +
    `Status: ${order.status ?? 'submitted'}${orderRef}. From @${authorName}.`
  );
}

// OptionContract is imported for type completeness — used via callout.option
void (null as unknown as OptionContract);
