/**
 * Execution is two halves, and both modes use them.
 *
 * `size*` resolves how many shares or contracts to trade and touches only
 * read-only broker calls, so approval mode can run it to show the user what
 * they are about to approve. `submitOrder` is the only function here that
 * places anything, and it works from the already-sized SubmittedOrder — which
 * is what lets the approve endpoint submit a trade that was sized hours ago
 * without re-deriving it.
 */
import { createLogger } from '../../shared/logger.js';
import {
  optionLabel,
  type Callout,
  type OptionContract,
  type OrderSide,
  type RiskCheck,
  type SubmittedOrder,
} from '../../shared/types.js';
import type { RobinhoodTools } from '../rh/tools.js';
import type { OptionPosition, PlaceOrderResult } from '../rh/types.js';

const log = createLogger('trader:pipeline');

/** The allow=true branch of a risk check — the shape execution paths consume. */
export type RiskAllow = Extract<RiskCheck, { allow: true }>;

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

/** Resolve the share count for an equity order. Read-only broker calls. */
export async function sizeEquityOrder(
  symbol: string,
  side: OrderSide,
  risk: RiskAllow,
  callout: Callout,
  buyingPower: number,
  tools: RobinhoodTools
): Promise<number> {
  const price =
    risk.limitPrice !== null
      ? risk.limitPrice
      : await tools.getQuote(symbol).then((q) => q.price);
  if (price === null) throw new Error(`could not determine price for ${symbol}`);

  // Same add-gate as the options path: an "averaging down" buy needs shares
  // already held, otherwise it silently becomes a fresh entry.
  if (side === 'buy' && callout.isAddition) {
    const { positions } = await tools.getPositions();
    const held = positions.find((p) => p.symbol.toUpperCase() === symbol && p.quantity > 0);
    if (!held) {
      throw new CapitalConstraintError(
        `averaging-down add skipped — no open ${symbol} position to add to`
      );
    }
  }

  // Sanity: an equity buy limit wildly below the live quote is a misparse
  // (e.g. an option premium taken as a share price), not a bargain order.
  // ponytail: a stale or absent quote skips the check. Upgrade path:
  // quote-check at risk-filter time.
  if (side === 'buy' && risk.limitPrice !== null) {
    const quote = await tools.getQuote(symbol).then((q) => q.price);
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

  return quantity;
}

/** Resolve the contract count for an options order. Read-only broker calls. */
export async function sizeOptionsOrder(
  symbol: string,
  side: OrderSide,
  risk: RiskAllow,
  callout: Callout,
  buyingPower: number,
  tools: RobinhoodTools
): Promise<number> {
  const option = callout.option!;

  if (side === 'sell') {
    return sizeOptionExit(symbol, risk, callout, tools);
  }

  // Adds ("averaging down") extend a position; with none held there is
  // nothing to add to, and mirroring the caller's add would open a fresh
  // position off a status update. Mirrors the sell-side "no open position to
  // trim" guard, so the rule holds for every caller regardless of format.
  if (callout.isAddition) {
    const position = await findOpenOptionPosition(tools, symbol, option);
    if (!position || Math.floor(position.quantity) < 1) {
      throw new CapitalConstraintError(
        `averaging-down add skipped — no open ${symbol} ${optionLabel(option)} position to add to`
      );
    }
  }

  // ---- Resolve premium ----------------------------------------------------
  // limitPrice from the callout takes precedence; otherwise fetch mark price.
  const premium: number | null =
    risk.limitPrice !== null
      ? risk.limitPrice
      : await tools
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

  // ---- Hard cap: never exceed the options ceiling (optionsFullPct) --------
  // Applies regardless of whether contracts came from a hint or budget math.
  if (contractCost !== null) {
    const hardMax = Math.max(1, Math.floor(buyingPower * risk.optionsFullPct / 100 / contractCost));
    if (contracts > hardMax) {
      log.warn('capping contracts to hard max', {
        symbol, requested: contracts, capped: hardMax,
        hardMaxPct: `${risk.optionsFullPct}%`,
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

  return contracts;
}

async function sizeOptionExit(
  symbol: string,
  risk: RiskAllow,
  callout: Callout,
  tools: RobinhoodTools
): Promise<number> {
  const option = callout.option!;
  const position = await findOpenOptionPosition(tools, symbol, option);
  const heldContracts = Math.floor(position?.quantity ?? 0);

  if (heldContracts < 1) {
    throw new CapitalConstraintError(
      `no open ${symbol} ${optionLabel(option)} position to trim`
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

  return contracts;
}

/**
 * Place an already-sized order. The only function in this module that writes
 * to the broker, and the only one the approve endpoint needs — everything it
 * requires is on the SubmittedOrder the sizing half produced.
 */
export async function submitOrder(
  order: SubmittedOrder,
  tools: RobinhoodTools
): Promise<PlaceOrderResult> {
  if (order.assetType === 'option') {
    if (order.option === null) {
      throw new Error(`options order for ${order.symbol} is missing its contract details`);
    }
    return tools.placeOptionsOrder({
      symbol: order.symbol,
      optionType: order.option.optionType,
      strike: order.option.strike,
      expiration: order.option.expiration,
      contracts: order.quantity,
      side: order.side,
      orderType: order.orderType,
      ...(order.limitPrice !== null ? { limitPremium: order.limitPrice } : {}),
    });
  }

  return tools.placeOrder({
    symbol: order.symbol,
    side: order.side,
    orderType: order.orderType,
    quantity: order.quantity,
    ...(order.limitPrice !== null ? { limitPrice: order.limitPrice } : {}),
  });
}

async function findOpenOptionPosition(
  tools: RobinhoodTools,
  symbol: string,
  option: OptionContract
): Promise<OptionPosition | null> {
  const result = await tools.getOptionPositions();
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
