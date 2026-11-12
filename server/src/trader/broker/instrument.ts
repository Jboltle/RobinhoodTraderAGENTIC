import type { AssetType, OptionContract, OrderSide } from '../../shared/types.js';
import type { OptionMinTicks } from '../robinhood/types.js';
import type { Instrument, OptionInstrument } from './types.js';

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
// OCC option symbols
// =============================================================================

const OCC_ROOT_WIDTH = 6;
const OCC_STRIKE_DIGITS = 8;
/** An OCC strike is written in thousandths of a dollar. */
const OCC_STRIKE_SCALE = 1000;
/** An OCC date carries two year digits; every listed contract expires in this century. */
const OCC_CENTURY = '20';
const OCC_ROOT = /^[A-Z0-9]{1,6}$/;
/** Root, YYMMDD, C or P, strike. Brokers return the root with or without its padding. */
const OCC_SYMBOL = /^([A-Z0-9]{1,6}) *(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;

/** The contract an OCC symbol spells out; `symbol` is the OCC root. */
export type OptionContractFields = Omit<OptionInstrument, 'kind'>;

/** False for a date the calendar does not have (2026-02-30) or one not written YYYY-MM-DD. */
function isRealDate(isoDate: string): boolean {
  const date = new Date(`${isoDate}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === isoDate;
}

/**
 * The 21-character OCC symbol: root padded to 6 with spaces, YYMMDD, C or P,
 * strike in thousandths padded to 8 digits. `AAPL  251114C00240000` is the
 * AAPL 2025-11-14 240 call. Throws on a contract the format cannot hold.
 *
 * ponytail: the root is the ticker as given. A contract whose OCC root is not
 * its underlying's ticker (SPXW weeklies on SPX, BRKB for BRK.B, an adjusted
 * AAPL1) needs that root passed as `symbol`. Upgrade path: carry the root on
 * the Instrument.
 */
export function occSymbol(contract: OptionContractFields): string {
  const root = contract.symbol.trim().toUpperCase();
  if (!OCC_ROOT.test(root)) {
    throw new Error(`option root must be 1 to ${OCC_ROOT_WIDTH} letters or digits, got "${contract.symbol}"`);
  }
  if (!contract.expiration.startsWith(OCC_CENTURY) || !isRealDate(contract.expiration)) {
    throw new Error(`expiration must be a real date as ${OCC_CENTURY}YY-MM-DD, got "${contract.expiration}"`);
  }
  const thousandths = Math.round(contract.strike * OCC_STRIKE_SCALE);
  const strikeFits = thousandths > 0 && String(thousandths).length <= OCC_STRIKE_DIGITS;
  if (!strikeFits || Math.abs(contract.strike * OCC_STRIKE_SCALE - thousandths) > 1e-6) {
    throw new Error(`strike must be positive with at most 3 decimals, got ${contract.strike}`);
  }
  const yymmdd = contract.expiration.slice(OCC_CENTURY.length).replaceAll('-', '');
  const side = contract.optionType === 'call' ? 'C' : 'P';
  return `${root.padEnd(OCC_ROOT_WIDTH)}${yymmdd}${side}${String(thousandths).padStart(OCC_STRIKE_DIGITS, '0')}`;
}

/** The contract an OCC symbol names, padded or not. Null when the text is not one. */
export function parseOccSymbol(text: string): OptionInstrument | null {
  const match = OCC_SYMBOL.exec(text.trim().toUpperCase());
  if (!match) return null;
  const [, root, year, month, day, side, thousandths] = match;
  const expiration = `${OCC_CENTURY}${year}-${month}-${day}`;
  const strike = Number(thousandths) / OCC_STRIKE_SCALE;
  if (!isRealDate(expiration) || !(strike > 0)) return null;
  return {
    kind: 'option',
    symbol: root!,
    optionType: side === 'C' ? 'call' : 'put',
    strike,
    expiration,
  };
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
