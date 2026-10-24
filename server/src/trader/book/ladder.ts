/**
 * The tracked-callout book: every Caller entry priced against live marks
 * with a simulated trim ladder, independent of whether anyone traded it.
 *
 * Pure functions over TrackedPosition. The monitor (book/monitor.ts) feeds
 * marks in, the pipeline feeds Caller exits in, and the API reads the derived
 * numbers out. Nothing here touches the broker or the database.
 *
 * The model is Swift's: an entry with no stated size is a nominal $5,000
 * position; the body of the position is sold in four slices at +25/50/75/100%
 * and one contract per runner level is carved out first. A ladder level
 * "fills" when the mark crosses its price, at the level price (what a resting
 * limit sell would get). A Caller's Trim sells the stated portion of what is
 * left at the Caller's price; a full Sell closes the rest; an expired contract
 * settles at its last mark.
 *
 * ponytail: fills are at the mark, not the bid (the MCP quote has no bid), and
 * recorded as such on each level so the UI can label them. Upgrade path:
 * read bid_price in parseOptionsQuote and change FillBasis to 'bid'.
 */
import type { Callout, ExitPortion, OptionContract } from '../../shared/types.js';
import { OPTION_MULTIPLIER } from '../maxLoss.js';

/** What a Caller's entry with no stated size is tracked as (Swift's rule). */
export const NOMINAL_POSITION_USD = 5000;
/** The body of the position is split evenly across these gain levels. */
export const BODY_LEVELS_PCT: readonly number[] = [25, 50, 75, 100];
/** One contract each, reserved before the body is split. */
export const RUNNER_LEVELS_PCT: readonly number[] = [150, 200, 500, 1000, 2500, 5000, 10000];

export type FillBasis = 'mark';
export type FillSource = 'ladder' | 'caller' | 'expiry';
export type ClosedBy = 'caller_exit' | 'ladder' | 'expiry';
export type TrackedResult = 'win' | 'loss' | 'be';

export interface LadderLevel {
  readonly pct: number;
  readonly qty: number;
  readonly price: number;
  /** "+25%" */
  readonly label: string;
  readonly isRunner: boolean;
  readonly filledAt: string | null;
  readonly fillBasis: FillBasis | null;
}

/** One sale out of the tracked position, simulated or Caller-stated. */
export interface TrackedFill {
  readonly at: string;
  readonly qty: number;
  readonly price: number;
  readonly pctGain: number;
  readonly source: FillSource;
  /** The Caller's exit message for source 'caller'; null otherwise. */
  readonly messageId: string | null;
}

export interface TrackedPosition {
  /** The opening Buy's Discord message id: the row key. */
  readonly messageId: string;
  readonly authorId: string;
  readonly ticker: string;
  readonly option: OptionContract;
  /** The Caller's stated premium, or the first mark seen when none was stated. */
  readonly entryPrice: number | null;
  /** 0 until an entry price exists. */
  readonly nominalQty: number;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly closedBy: ClosedBy | null;
  /** Price of the fill that closed the last contract. */
  readonly exitPrice: number | null;
  readonly lastMark: number | null;
  readonly lastMarkAt: string | null;
  readonly highestPct: number | null;
  readonly highestPrice: number | null;
  readonly ladder: readonly LadderLevel[];
  readonly fills: readonly TrackedFill[];
  readonly result: TrackedResult | null;
}

export interface OpenArgs {
  readonly messageId: string;
  readonly authorId: string;
  readonly ticker: string;
  readonly option: OptionContract;
  readonly entryPrice: number | null;
  readonly sizeHint: Callout['sizeHint'];
  readonly openedAt: string;
}

export interface CallerExit {
  readonly at: string;
  /** The Caller's stated exit premium; null falls back to the last mark. */
  readonly price: number | null;
  readonly portion: ExitPortion;
  readonly messageId: string;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Contracts a Caller's entry is tracked as: their stated count, else the $5k rule. */
export function nominalQty(entryPrice: number, sizeHint: Callout['sizeHint']): number {
  if (sizeHint?.kind === 'contracts') return Math.max(1, Math.round(sizeHint.value));
  return Math.max(1, Math.round(NOMINAL_POSITION_USD / (entryPrice * OPTION_MULTIPLIER)));
}

/**
 * Runners first, one contract each; the body splits what is left across the
 * body levels, remainder to the nearest levels. A position too small for
 * every rung drops the furthest rungs first, down to a single +25% level.
 */
export function buildLadder(entryPrice: number, qty: number): LadderLevel[] {
  if (!(entryPrice > 0) || qty < 1) return [];
  const bodyCount = BODY_LEVELS_PCT.length;
  const runnerCount = Math.min(RUNNER_LEVELS_PCT.length, Math.max(0, qty - bodyCount));
  const bodyQty = qty - runnerCount;
  const bodyLevels = BODY_LEVELS_PCT.slice(0, Math.min(bodyCount, bodyQty));
  const perLevel = Math.floor(bodyQty / bodyLevels.length);
  let remainder = bodyQty - perLevel * bodyLevels.length;

  const level = (pct: number, levelQty: number, isRunner: boolean): LadderLevel => ({
    pct,
    qty: levelQty,
    price: round2(entryPrice * (1 + pct / 100)),
    label: `+${pct}%`,
    isRunner,
    filledAt: null,
    fillBasis: null,
  });

  const body = bodyLevels.map((pct) => level(pct, perLevel + (remainder-- > 0 ? 1 : 0), false));
  const runners = RUNNER_LEVELS_PCT.slice(0, runnerCount).map((pct) => level(pct, 1, true));
  return [...body, ...runners];
}

export function openPosition(args: OpenArgs): TrackedPosition {
  const entryPrice = args.entryPrice !== null && args.entryPrice > 0 ? args.entryPrice : null;
  const qty = entryPrice === null ? 0 : nominalQty(entryPrice, args.sizeHint);
  return {
    messageId: args.messageId,
    authorId: args.authorId,
    ticker: args.ticker.toUpperCase(),
    option: args.option,
    entryPrice,
    nominalQty: qty,
    openedAt: args.openedAt,
    closedAt: null,
    closedBy: null,
    exitPrice: null,
    lastMark: null,
    lastMarkAt: null,
    highestPct: null,
    highestPrice: null,
    ladder: entryPrice === null ? [] : buildLadder(entryPrice, qty),
    fills: [],
    result: null,
  };
}

export const remainingQty = (position: TrackedPosition): number =>
  Math.max(0, position.nominalQty - position.fills.reduce((sum, fill) => sum + fill.qty, 0));

/** Dollars realized by every fill so far (×100 per contract). 0 without an entry. */
export function realizedPnl(position: TrackedPosition): number {
  const entry = position.entryPrice;
  if (entry === null) return 0;
  return position.fills.reduce(
    (sum, fill) => sum + (fill.price - entry) * fill.qty * OPTION_MULTIPLIER,
    0
  );
}

/** Dollars the open remainder is up or down at the last mark; null when unpriced. */
export function unrealizedPnl(position: TrackedPosition): number | null {
  const { entryPrice, lastMark } = position;
  if (entryPrice === null || lastMark === null || position.closedAt !== null) return null;
  return (lastMark - entryPrice) * remainingQty(position) * OPTION_MULTIPLIER;
}

export const pctChange = (entry: number, price: number): number => ((price - entry) / entry) * 100;

/**
 * A mark for an open position: peak tracking, ladder fills at crossed levels,
 * and the entry itself when the Caller stated none.
 */
export function applyMark(position: TrackedPosition, mark: number, at: string): TrackedPosition {
  if (position.closedAt !== null || !(mark > 0)) return position;

  let next: TrackedPosition = { ...position, lastMark: mark, lastMarkAt: at };
  if (next.entryPrice === null) {
    const qty = nominalQty(mark, null);
    next = { ...next, entryPrice: mark, nominalQty: qty, ladder: buildLadder(mark, qty) };
  }
  const entry = next.entryPrice!;
  const pct = pctChange(entry, mark);
  if (next.highestPct === null || pct > next.highestPct) {
    next = { ...next, highestPct: pct, highestPrice: mark };
  }

  let remaining = remainingQty(next);
  const fills = [...next.fills];
  const ladder = next.ladder.map((level) => {
    if (level.filledAt !== null || level.price > mark || remaining <= 0) return level;
    const qty = Math.min(level.qty, remaining);
    remaining -= qty;
    fills.push({ at, qty, price: level.price, pctGain: level.pct, source: 'ladder', messageId: null });
    return { ...level, filledAt: at, fillBasis: 'mark' as const };
  });
  next = { ...next, ladder, fills };
  return remaining === 0 && fills.length > position.fills.length
    ? close(next, at, 'ladder', fills.at(-1)!.price)
    : next;
}

/**
 * The Caller's own Trim or Sell: sells the stated portion of what is left at
 * the Caller's price (else the last mark). A Sell with nothing left to sell
 * is a no-op; a position still unpriced closes without a fill.
 */
export function applyCallerExit(position: TrackedPosition, exit: CallerExit): TrackedPosition {
  if (position.closedAt !== null) return position;
  const remaining = remainingQty(position);
  const price = exit.price ?? position.lastMark ?? position.entryPrice;
  const qty = portionQty(exit.portion, remaining);

  if (price === null || position.entryPrice === null) {
    return exit.portion.kind === 'all' ? close(position, exit.at, 'caller_exit', null) : position;
  }
  if (qty === 0) return position;

  const fill: TrackedFill = {
    at: exit.at,
    qty,
    price,
    pctGain: pctChange(position.entryPrice, price),
    source: 'caller',
    messageId: exit.messageId,
  };
  const next = { ...position, fills: [...position.fills, fill] };
  return remaining - qty === 0 ? close(next, exit.at, 'caller_exit', price) : next;
}

function portionQty(portion: ExitPortion, remaining: number): number {
  switch (portion.kind) {
    case 'all':
      return remaining;
    case 'all_but_one':
      return Math.max(0, remaining - 1);
    case 'fraction':
      return remaining === 0 ? 0 : Math.min(remaining, Math.max(1, Math.round(remaining * portion.value)));
  }
}

/** True once the contract's expiration day is behind `todayIsoEt`. */
export const isExpired = (position: TrackedPosition, todayIsoEt: string): boolean =>
  position.option.expiration < todayIsoEt;

/**
 * 4:00 PM New York on an ISO date, as an ISO instant: when an expired
 * contract settles, so the close lands on its expiration day's session and
 * not on whichever sweep noticed it.
 */
export function marketCloseIso(isoDate: string): string {
  const hourEt = (iso: string): number =>
    Number(
      new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }).format(
        new Date(iso)
      )
    );
  // 20:00Z is 4 PM during daylight time; 21:00Z is 4 PM during standard time.
  const daylight = `${isoDate}T20:00:00.000Z`;
  return hourEt(daylight) === 16 ? daylight : `${isoDate}T21:00:00.000Z`;
}

/** An expired contract with no Caller exit: the remainder goes at the last mark, else worthless. */
export function settle(position: TrackedPosition, at: string): TrackedPosition {
  if (position.closedAt !== null) return position;
  const remaining = remainingQty(position);
  const price = position.lastMark ?? 0;
  if (remaining === 0 || position.entryPrice === null) return close(position, at, 'expiry', null);
  const fill: TrackedFill = {
    at,
    qty: remaining,
    price,
    pctGain: pctChange(position.entryPrice, price),
    source: 'expiry',
    messageId: null,
  };
  return close({ ...position, fills: [...position.fills, fill] }, at, 'expiry', price);
}

function close(
  position: TrackedPosition,
  at: string,
  closedBy: ClosedBy,
  exitPrice: number | null
): TrackedPosition {
  const closed = { ...position, closedAt: at, closedBy, exitPrice };
  const pnl = realizedPnl(closed);
  return { ...closed, result: pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'be' };
}

/** A position plus the numbers the dashboard shows, derived once at read time. */
export interface TrackedPositionView extends TrackedPosition {
  readonly remainingQty: number;
  readonly realizedPnl: number;
  readonly unrealizedPnl: number | null;
  /** The last mark against entry, in %; null while unpriced. */
  readonly pctNow: number | null;
}

export function viewOf(position: TrackedPosition): TrackedPositionView {
  const { entryPrice, lastMark } = position;
  return {
    ...position,
    remainingQty: remainingQty(position),
    realizedPnl: realizedPnl(position),
    unrealizedPnl: unrealizedPnl(position),
    pctNow: entryPrice !== null && lastMark !== null ? pctChange(entryPrice, lastMark) : null,
  };
}

export const BOOK_PERIODS = ['today', 'week', 'all'] as const;
export type BookPeriod = (typeof BOOK_PERIODS)[number];

/** The first ET trading day a period covers; null = no lower bound. */
export function periodStartDate(period: BookPeriod, todayIsoEt: string): string | null {
  switch (period) {
    case 'today':
      return todayIsoEt;
    case 'week':
      return mondayOf(todayIsoEt);
    case 'all':
      return null;
  }
}

/** YYYY-MM-DD of `date` in New York time: the trading day a timestamp belongs to. */
export function isoDateEt(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** The Monday on or before an ISO date. */
export function mondayOf(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  const sinceMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - sinceMonday);
  return date.toISOString().slice(0, 10);
}
