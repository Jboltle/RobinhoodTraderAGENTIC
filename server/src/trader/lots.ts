/**
 * Whose contracts a sell may touch, and how an own-target ladder splits a lot.
 *
 * A lot is one filled buy. Its id is that row's trades.id. A sell records the
 * lots it closed; open quantity is filled quantity minus those links. Caller
 * is the buy message's author, so one Caller's trim cannot reach another's
 * contracts in the same symbol.
 */
import type { ExitPortion, OptionContract, SubmittedOrder } from '../shared/types.js';

export interface LotLink {
  readonly lotId: string;
  readonly quantity: number;
  /** Set when an own-target level sold these contracts. */
  readonly gainPct?: number;
}

export interface LotRow {
  readonly id: string;
  readonly messageId: string;
  readonly action: 'buy' | 'sell' | null;
  readonly authorId: string | null;
  readonly at: string;
  readonly order: SubmittedOrder | null;
}

export interface OpenOptionLot {
  readonly lotId: string;
  readonly messageId: string;
  readonly authorId: string;
  readonly symbol: string;
  readonly option: OptionContract;
  readonly openQty: number;
  readonly originalQty: number;
  readonly entryPrice: number;
  readonly openedAt: string;
  readonly stopOrderId: string | null;
  readonly buyOrder: SubmittedOrder;
  /** Contracts already sold at each own-target gain, including working sells. */
  readonly soldAtGain: Readonly<Record<number, number>>;
}

export interface TrimLevel {
  readonly gainPct: number;
  readonly portionPct: number;
}

/**
 * Index and ETF underlyings use the tight strike band. Everything else is a
 * single name. ponytail: fixed bands, not fit to the archive. Upgrade path:
 * per-user settings.
 */
const TIGHT_UNDERLYINGS = new Set(['SPX', 'SPXW', 'XSP', 'NDX', 'RUT', 'SPY', 'QQQ', 'IWM']);
const TIGHT_STRIKE_BAND = 0.05;
const NAME_STRIKE_BAND = 0.15;
const PREMIUM_BAND = 0.3;

const DEAD_SELL = new Set(['cancelled', 'canceled', 'rejected', 'failed', 'expired']);

function countsAsSold(order: SubmittedOrder): boolean {
  const status = order.status?.toLowerCase() ?? '';
  return !DEAD_SELL.has(status);
}

function buyFilledQty(order: SubmittedOrder): number {
  const status = order.status?.toLowerCase() ?? '';
  if (status !== 'filled' && status !== 'partially_filled') return 0;
  if (order.filledQuantity != null && order.filledQuantity > 0) return Math.floor(order.filledQuantity);
  return status === 'filled' ? Math.floor(order.quantity) : 0;
}

/** Open option lots for one user, oldest first. */
export function openOptionLots(rows: readonly LotRow[]): OpenOptionLot[] {
  const consumed = new Map<string, number>();
  const byGain = new Map<string, Map<number, number>>();
  for (const row of rows) {
    if (row.action === 'buy' || !row.order?.lots || !countsAsSold(row.order)) continue;
    for (const link of row.order.lots) {
      consumed.set(link.lotId, (consumed.get(link.lotId) ?? 0) + link.quantity);
      if (link.gainPct === undefined) continue;
      const gains = byGain.get(link.lotId) ?? new Map<number, number>();
      gains.set(link.gainPct, (gains.get(link.gainPct) ?? 0) + link.quantity);
      byGain.set(link.lotId, gains);
    }
  }

  const lots: OpenOptionLot[] = [];
  for (const row of rows) {
    const order = row.order;
    if (row.action !== 'buy' || !order?.option || !row.authorId) continue;
    const originalQty = buyFilledQty(order);
    const openQty = originalQty - (consumed.get(row.id) ?? 0);
    if (openQty < 1) continue;
    const entry = order.averageFillPrice ?? order.limitPrice ?? 0;
    const gains = byGain.get(row.id);
    lots.push({
      lotId: row.id,
      messageId: row.messageId,
      authorId: row.authorId,
      symbol: order.symbol.toUpperCase(),
      option: order.option,
      openQty,
      originalQty,
      entryPrice: entry,
      openedAt: row.at,
      stopOrderId: order.stopOrderId ?? null,
      buyOrder: order,
      soldAtGain: gains ? Object.fromEntries(gains) : {},
    });
  }
  return lots.sort((a, b) => a.openedAt.localeCompare(b.openedAt) || a.lotId.localeCompare(b.lotId));
}

/** Oldest lot first. Stops once `quantity` is covered. */
export function allocateFifo(lots: readonly OpenOptionLot[], quantity: number): LotLink[] {
  const links: LotLink[] = [];
  let left = quantity;
  for (const lot of lots) {
    if (left <= 0) break;
    const take = Math.min(lot.openQty, left);
    if (take < 1) continue;
    links.push({ lotId: lot.lotId, quantity: take });
    left -= take;
  }
  return links;
}

/**
 * Contracts each level sells, of the original lot. A level that rounds to
 * zero rolls its fraction into the next, so a 2-lot sells 1 at +50% and 1 at
 * +100%, and a 1-lot sells at the last level.
 */
export function contractsAtLevel(
  originalQty: number,
  levels: readonly TrimLevel[]
): { gainPct: number; contracts: number }[] {
  let debt = 0;
  return levels.map((level) => {
    const exact = (originalQty * level.portionPct) / 100 + debt;
    const contracts = Math.floor(exact + 1e-9);
    debt = exact - contracts;
    return { gainPct: level.gainPct, contracts };
  });
}

export function sameOption(lot: OpenOptionLot, symbol: string, option: OptionContract): boolean {
  return (
    lot.symbol === symbol.toUpperCase() &&
    lot.option.optionType === option.optionType &&
    lot.option.strike === option.strike &&
    lot.option.expiration === option.expiration
  );
}

/**
 * Why an entry should wait for approval, or null when the strike and premium
 * sit inside the bands. No spot skips the strike check (an index has no equity
 * quote). No mark skips the premium check.
 */
export function entryMismatch(args: {
  readonly ticker: string;
  readonly strike: number;
  readonly spot: number | null;
  readonly callerPremium: number | null;
  readonly mark: number | null;
}): string | null {
  const ticker = args.ticker.toUpperCase();
  if (args.spot !== null && args.spot > 0) {
    const band = TIGHT_UNDERLYINGS.has(ticker) ? TIGHT_STRIKE_BAND : NAME_STRIKE_BAND;
    const gap = Math.abs(args.strike - args.spot) / args.spot;
    if (gap > band) {
      const pct = ((args.strike - args.spot) / args.spot) * 100;
      const sign = pct > 0 ? '+' : '';
      return `caller ${args.strike} strike, ${ticker} at ${args.spot.toFixed(2)} (${sign}${pct.toFixed(1)}%)`;
    }
  }
  if (args.callerPremium !== null && args.callerPremium > 0 && args.mark !== null && args.mark > 0) {
    const gap = Math.abs(args.callerPremium - args.mark) / args.mark;
    if (gap > PREMIUM_BAND) {
      const pct = ((args.callerPremium - args.mark) / args.mark) * 100;
      const sign = pct > 0 ? '+' : '';
      return `caller premium ${args.callerPremium}, mark ${args.mark} (${sign}${pct.toFixed(1)}%)`;
    }
  }
  return null;
}

/** Trigger for a broker stop: `maxLossPct` of 80 on a 1.00 fill is 0.20. */
export function stopTrigger(fill: number, maxLossPct: number): number {
  return fill * (1 - maxLossPct / 100);
}

/** True when this exit closes the position rather than trimming it. */
export function isFullClose(exitPortion: ExitPortion | null | undefined, tickerOnlyExit: boolean | undefined): boolean {
  return tickerOnlyExit === true || exitPortion?.kind === 'all';
}
