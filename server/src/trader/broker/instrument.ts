import type { AssetType, OptionContract, OrderSide } from '../../shared/types.js';
import type { OptionMinTicks } from '../robinhood/types.js';
import type { Instrument } from './types.js';

/** The instrument a stored order, lot or position row names. */
export function instrumentOf(order: {
  readonly symbol: string;
  readonly assetType: AssetType;
  readonly option: OptionContract | null;
}): Instrument {
  if (order.assetType !== 'option') return { kind: 'equity', symbol: order.symbol };
  if (order.option === null) {
    throw new Error(`options order for ${order.symbol} is missing its contract details`);
  }
  return {
    kind: 'option',
    symbol: order.symbol,
    optionType: order.option.optionType,
    strike: order.option.strike,
    expiration: order.option.expiration,
  };
}

/** One string per instrument: the same contract always yields the same key. */
export function instrumentKey(instrument: Instrument): string {
  const symbol = instrument.symbol.toUpperCase();
  if (instrument.kind === 'equity') return `eq:${symbol}`;
  return `opt:${symbol}:${instrument.optionType}:${instrument.strike}:${instrument.expiration}`;
}

// =============================================================================
// Price grid rounding
// =============================================================================

/**
 * The standard US options grid (penny below $3, nickel above), used when the
 * instrument row carries no `min_ticks`. Exact for penny-program symbols and
 * never produces sub-penny prices, which is the failure seen in the wild.
 */
const DEFAULT_MIN_TICKS: OptionMinTicks = { aboveTick: 0.05, belowTick: 0.01, cutoffPrice: 3 };

const TICK_EPSILON = 1e-9;

/**
 * Snap a per-contract premium onto the instrument's price grid. Buys round up
 * and sells round down so the rounded order is always at least as marketable
 * as the requested one (cost: under one tick per contract).
 */
export function roundPremiumToTick(
  premium: number,
  side: OrderSide,
  minTicks: OptionMinTicks | null
): number {
  const grid = minTicks ?? DEFAULT_MIN_TICKS;
  const tick = premium < grid.cutoffPrice ? grid.belowTick : grid.aboveTick;
  const steps =
    side === 'buy'
      ? Math.ceil(premium / tick - TICK_EPSILON)
      : Math.floor(premium / tick + TICK_EPSILON);
  // A sell floored to zero is off-grid too; the smallest valid price is one tick.
  const snapped = Math.max(tick, steps * tick);
  return Number(snapped.toFixed(4));
}
