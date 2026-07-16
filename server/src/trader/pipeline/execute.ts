import { createLogger } from '../../shared/logger.js';
import type {
  Callout,
  CalloutParser,
  OptionContract,
  PostReceipt,
  RiskCheck,
} from '../../shared/types.js';
import type { OptionPosition, RobinhoodTools } from '../rh/tools.js';
import type { DecisionLog } from '../decisionLog.js';

const log = createLogger('trader:pipeline');

export interface PipelineDeps {
  readonly parser: CalloutParser;
  readonly tools: RobinhoodTools;
  readonly decisions: DecisionLog;
  readonly postReceipt: PostReceipt;
}

/** The allow=true branch of a risk check — the shape execution paths consume. */
export type RiskAllow = Extract<RiskCheck, { allow: true }>;

export interface PlacedResult {
  readonly orderId: string | null;
  readonly status: string | null;
  readonly quantity: number;
}

/**
 * Thrown when the current account balance makes a trade unviable (e.g. even
 * one contract would exceed the single-contract cap). Surfaces as
 * `risk_rejected` in the decision log rather than `execution_failed`.
 */
export class CapitalConstraintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapitalConstraintError';
  }
}

/**
 * Thrown when the parsed order contradicts market reality (e.g. an equity
 * limit price that is a small fraction of the live quote — almost certainly
 * an option premium misread as a share price). Surfaces as `risk_rejected`
 * with code `parse_inconsistent` in the decision log.
 */
export class ParseInconsistencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseInconsistencyError';
  }
}

// Equity limit buys priced below this fraction of the live quote are treated
// as misparses rather than aggressive orders.
const EQUITY_LIMIT_MIN_QUOTE_FRACTION = 0.2;

export async function executeEquity(
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

  // Sanity: an equity buy limit wildly below the live quote is a misparse
  // (e.g. an option premium taken as a share price), not a bargain order.
  // ponytail: only guards immediate-mode buys with a limit; approval-mode
  // parses rely on the pipeline's options-language veto, and a stale/absent
  // quote skips the check. Upgrade path: quote-check at risk-filter time.
  if (side === 'buy' && risk.limitPrice !== null) {
    const quote = await deps.tools.getQuote(symbol).then((q) => q.price);
    if (quote !== null && risk.limitPrice < quote * EQUITY_LIMIT_MIN_QUOTE_FRACTION) {
      throw new ParseInconsistencyError(
        `equity limit $${risk.limitPrice.toFixed(2)} is <${EQUITY_LIMIT_MIN_QUOTE_FRACTION * 100}% of ${symbol} quote $${quote.toFixed(2)} — likely an option premium misread as a share price`
      );
    }
  }

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

export async function executeOptions(
  symbol: string,
  side: 'buy' | 'sell',
  risk: RiskAllow,
  callout: Callout,
  buyingPower: number,
  deps: PipelineDeps
): Promise<PlacedResult> {
  const option = callout.option!;

  if (side === 'sell') {
    return executeOptionExit(symbol, risk, callout, deps);
  }

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
    if (singleContractPct > risk.maxSingleContractPct) {
      throw new CapitalConstraintError(
        `1 ${symbol} contract costs $${contractCost.toFixed(2)} ` +
        `(${singleContractPct.toFixed(1)}% of $${buyingPower.toFixed(0)} buying power), ` +
        `exceeds MAX_SINGLE_CONTRACT_PCT (${risk.maxSingleContractPct}%) — trade skipped`
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
    const hardMax = Math.max(1, Math.floor(buyingPower * risk.maxOptionsNotionalPct / 100 / contractCost));
    if (contracts > hardMax) {
      log.warn('capping contracts to hard max', {
        symbol, requested: contracts, capped: hardMax,
        hardMaxPct: `${risk.maxOptionsNotionalPct}%`,
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

async function executeOptionExit(
  symbol: string,
  risk: RiskAllow,
  callout: Callout,
  deps: PipelineDeps
): Promise<PlacedResult> {
  const option = callout.option!;
  const position = await findOpenOptionPosition(deps, symbol, option);
  const heldContracts = Math.floor(position?.quantity ?? 0);

  if (heldContracts < 1) {
    throw new CapitalConstraintError(
      `no open ${symbol} ${option.strike}${option.optionType[0]?.toUpperCase()} ${option.expiration} position to trim`
    );
  }

  const requested = resolveExitContracts(callout, risk, heldContracts);
  const contracts = Math.min(requested, heldContracts);

  if (contracts < 1) {
    throw new CapitalConstraintError(
      `resolved trim size was 0 for ${heldContracts} open ${symbol} contract(s)`
    );
  }

  log.info('options exit sized from open position', {
    symbol,
    strike: option.strike,
    expiration: option.expiration,
    optionType: option.optionType,
    heldContracts,
    contracts,
    positionSize: callout.positionSize ?? 'default',
  });

  const result = await deps.tools.placeOptionsOrder({
    symbol,
    optionType: option.optionType,
    strike: option.strike,
    expiration: option.expiration,
    contracts,
    side: 'sell',
    orderType: risk.orderType,
    ...(risk.limitPrice !== null ? { limitPremium: risk.limitPrice } : {}),
  });

  return { orderId: result.orderId, status: result.status, quantity: contracts };
}

async function findOpenOptionPosition(
  deps: PipelineDeps,
  symbol: string,
  option: OptionContract
): Promise<OptionPosition | null> {
  const result = await deps.tools.getOptionPositions();
  return (
    result.positions.find(
      (p) =>
        p.symbol.toUpperCase() === symbol &&
        p.optionType === option.optionType &&
        p.expiration === option.expiration &&
        Math.abs(p.strike - option.strike) < 0.0001 &&
        p.quantity > 0
    ) ?? null
  );
}

function resolveExitContracts(callout: Callout, risk: RiskAllow, heldContracts: number): number {
  if (risk.quantityHint !== null) return Math.floor(risk.quantityHint);

  switch (callout.positionSize) {
    case 'full':
      return heldContracts > 1 ? heldContracts - 1 : 1;
    case 'medium':
    case 'small':
    case null:
      return 1;
  }
}
