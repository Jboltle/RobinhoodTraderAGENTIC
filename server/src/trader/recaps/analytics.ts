/**
 * Performance metrics over parsed recap trades. Pure functions, no I/O — the
 * numbers on the Performance & Metrix tab all come from here, computed
 * per-request (a year of daily recaps is a few thousand trades; formatting
 * costs more than the math).
 *
 * Exclusions, per product decision: soft trades (the recap's own "if held" /
 * "already exited" hedges) and futures callers (points-based, incomparable to
 * options percentages) are parsed and checksummed but never counted in stats.
 */
import type { StoredRecap } from '../db.js';
import type { RecapTrade } from './parser.js';

/** Window choices offered by the dashboard filter. */
export const RECAP_WINDOW_DAYS_CHOICES: readonly number[] = [7, 30, 90, 180, 365];
export const DEFAULT_RECAP_WINDOW_DAYS = 90;
/** Callers below this trade count appear in the table but win no awards. */
export const MIN_TRADES_FOR_AWARDS = 20;
const TOP_TRADES_LIMIT = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface CallerStats {
  readonly caller: string;
  readonly trades: number;
  readonly wins: number;
  readonly losses: number;
  readonly winRatePct: number;
  readonly avgPct: number;
  readonly medianPct: number;
  readonly totalPct: number;
  readonly bestPct: number;
  readonly worstPct: number;
  readonly stdDevPct: number;
  /** trades >= MIN_TRADES_FOR_AWARDS — award eligibility. */
  readonly qualifies: boolean;
}

/** A single trade lifted out for the top-trades list and award cards. */
export interface HighlightTrade extends RecapTrade {
  readonly recapDate: string;
}

/**
 * One chart row: { date: '2026-08-19', Demon: 1029.2, Waxui: 105, ... }.
 * Every caller key is present on every row (running totals carried forward)
 * so line charts render without gaps.
 */
export type CumulativeGainPoint = Record<string, number | string>;

export interface RecapPerformance {
  readonly windowDays: number;
  /** Award floor, echoed so the client renders the real threshold. */
  readonly minTradesForAwards: number;
  readonly fromDate: string | null;
  readonly toDate: string | null;
  readonly recapCount: number;
  /** Trades included in stats (soft results excluded). */
  readonly tradeCount: number;
  readonly softExcluded: number;
  /**
   * Every options trade in the window, soft ones included (flagged via
   * isSoft) — the leaderboard's expandable per-caller history. Stats above
   * never count the soft ones.
   */
  readonly trades: readonly HighlightTrade[];
  readonly totals: {
    readonly wins: number;
    readonly losses: number;
    readonly winRatePct: number;
    readonly avgPct: number;
    readonly totalPct: number;
  };
  readonly leaderboard: readonly CallerStats[];
  readonly awards: {
    readonly bestPerformer: CallerStats | null;
    readonly worstPerformer: CallerStats | null;
    readonly mostWins: CallerStats | null;
    readonly highestWinRate: CallerStats | null;
    readonly mostConsistent: CallerStats | null;
    readonly bestTrade: HighlightTrade | null;
  };
  readonly topTrades: readonly HighlightTrade[];
  readonly series: readonly CumulativeGainPoint[];
  readonly parseHealth: {
    readonly parsed: number;
    readonly partial: number;
    readonly failed: number;
    readonly lastPostedAt: string | null;
  };
}

export const isoDateDaysAgo = (days: number, now: Date = new Date()): string =>
  new Date(now.getTime() - days * DAY_MS).toISOString().slice(0, 10);

export function computeRecapPerformance(
  recaps: readonly StoredRecap[],
  windowDays: number
): RecapPerformance {
  const allTrades: HighlightTrade[] = [];

  for (const recap of recaps) {
    if (!recap.parse || !recap.recapDate) continue;
    for (const trade of recap.parse.trades) {
      allTrades.push({ ...trade, recapDate: recap.recapDate });
    }
  }

  const included = allTrades.filter((t) => !t.isSoft);
  const softExcluded = allTrades.length - included.length;

  const leaderboard = buildLeaderboard(included);
  const qualifying = leaderboard.filter((c) => c.qualifies);
  const topTrades = [...included]
    .sort((a, b) => b.pctGain - a.pctGain)
    .slice(0, TOP_TRADES_LIMIT);

  const wins = included.filter((t) => t.isWin).length;
  const totalPct = sum(included.map((t) => t.pctGain));
  const dates = recaps.map((r) => r.recapDate).filter((d): d is string => d !== null);

  return {
    windowDays,
    minTradesForAwards: MIN_TRADES_FOR_AWARDS,
    fromDate: dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : null,
    toDate: dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null,
    recapCount: recaps.length,
    tradeCount: included.length,
    softExcluded,
    trades: allTrades,
    totals: {
      wins,
      losses: included.length - wins,
      winRatePct: round(included.length ? (wins / included.length) * 100 : 0),
      avgPct: round(included.length ? totalPct / included.length : 0),
      totalPct: round(totalPct),
    },
    leaderboard,
    awards: {
      bestPerformer: maxBy(qualifying, (c) => c.avgPct),
      worstPerformer: maxBy(qualifying, (c) => -c.avgPct),
      mostWins: maxBy(leaderboard, (c) => c.wins),
      highestWinRate: maxBy(qualifying, (c) => c.winRatePct),
      // Consistency only means something for profitable callers: a steady
      // loser has a low std dev too.
      mostConsistent: maxBy(
        qualifying.filter((c) => c.avgPct > 0),
        (c) => -c.stdDevPct
      ),
      bestTrade: topTrades[0] ?? null,
    },
    topTrades,
    series: buildCumulativeSeries(included),
    parseHealth: {
      parsed: recaps.filter((r) => r.parseStatus === 'parsed').length,
      partial: recaps.filter((r) => r.parseStatus === 'parsed_partial').length,
      failed: recaps.filter((r) => r.parseStatus === 'failed').length,
      lastPostedAt: recaps.length
        ? recaps.map((r) => r.postedAt).reduce((a, b) => (a > b ? a : b))
        : null,
    },
  };
}

function buildLeaderboard(trades: readonly HighlightTrade[]): CallerStats[] {
  const byCaller = new Map<string, HighlightTrade[]>();
  for (const trade of trades) {
    const list = byCaller.get(trade.caller) ?? [];
    list.push(trade);
    byCaller.set(trade.caller, list);
  }

  return [...byCaller.entries()]
    .map(([caller, callerTrades]) => {
      const pcts = callerTrades.map((t) => t.pctGain);
      const wins = callerTrades.filter((t) => t.isWin).length;
      const total = sum(pcts);
      const avg = total / pcts.length;
      return {
        caller,
        trades: callerTrades.length,
        wins,
        losses: callerTrades.length - wins,
        winRatePct: round((wins / callerTrades.length) * 100),
        avgPct: round(avg),
        medianPct: round(median(pcts)),
        totalPct: round(total),
        bestPct: round(Math.max(...pcts)),
        worstPct: round(Math.min(...pcts)),
        stdDevPct: round(stdDev(pcts, avg)),
        qualifies: callerTrades.length >= MIN_TRADES_FOR_AWARDS,
      };
    })
    .sort((a, b) => b.avgPct - a.avgPct);
}

/** Per-date running total of gain % per caller, every caller on every row. */
function buildCumulativeSeries(trades: readonly HighlightTrade[]): CumulativeGainPoint[] {
  const byDate = new Map<string, HighlightTrade[]>();
  for (const trade of trades) {
    const list = byDate.get(trade.recapDate) ?? [];
    list.push(trade);
    byDate.set(trade.recapDate, list);
  }

  const running = new Map<string, number>();
  for (const trade of trades) running.set(trade.caller, 0);

  return [...byDate.keys()].sort().map((date) => {
    for (const trade of byDate.get(date)!) {
      running.set(trade.caller, (running.get(trade.caller) ?? 0) + trade.pctGain);
    }
    const point: CumulativeGainPoint = { date };
    for (const [caller, total] of running) point[caller] = round(total);
    return point;
  });
}

function maxBy<T>(items: readonly T[], score: (item: T) => number): T | null {
  let best: T | null = null;
  let bestScore = -Infinity;
  for (const item of items) {
    const s = score(item);
    if (s > bestScore) {
      best = item;
      bestScore = s;
    }
  }
  return best;
}

const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Population std dev — describes the observed window, not a sample estimate. */
function stdDev(values: readonly number[], mean: number): number {
  if (values.length === 0) return 0;
  return Math.sqrt(sum(values.map((v) => (v - mean) ** 2)) / values.length);
}

const round = (value: number): number => Math.round(value * 100) / 100;
