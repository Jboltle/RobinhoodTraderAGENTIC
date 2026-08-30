/**
 * Analytics invariants: soft trades never count, the 20-trade floor gates
 * awards, and the cumulative series carries every caller on every row.
 */

import { describe, expect, it } from 'vitest';

import type { StoredRecap } from '../../db.js';
import { MIN_TRADES_FOR_AWARDS, computeRecapPerformance } from '../analytics.js';
import type { RecapParse, RecapTrade } from '../parser.js';

function makeTrade(overrides: Partial<RecapTrade> & { caller: string; pctGain: number }): RecapTrade {
  return {
    ticker: 'SPY',
    expiration: '0DTE',
    strike: 500,
    optionType: 'call',
    entryPrice: 1,
    exitPrice: 2,
    isWin: overrides.pctGain > 0,
    isSoft: false,
    note: null,
    lineRaw: 'synthetic',
    ...overrides,
  };
}

function makeRecap(recapDate: string, trades: RecapTrade[]): StoredRecap {
  const parse: RecapParse = {
    recapDate,
    trades,
    futures: [],
    claimed: {
      totalTrades: trades.length,
      winRatePct: null,
      winners: null,
      losers: null,
      totalOptionsGainPct: null,
      avgGainPerOptionsCallPct: null,
    },
    checksum: {
      parsedTotal: trades.length,
      claimedTotal: trades.length,
      totalMatches: true,
      parsedWinners: trades.filter((t) => t.isWin).length,
      claimedWinners: null,
      winnersMatch: null,
    },
    unparsedLines: [],
  };
  return {
    messageId: `msg-${recapDate}`,
    channelId: 'recap-chan',
    postedAt: `${recapDate}T21:00:00.000Z`,
    recapDate,
    content: 'synthetic',
    contentHash: 'hash',
    parse,
    parseStatus: 'parsed',
    parserVersion: 1,
  };
}

/** N recaps of one trade/day for `caller`, alternating +20 / -10 from `wins`. */
function dailyTrades(caller: string, days: number, winEvery = 1): StoredRecap[] {
  return Array.from({ length: days }, (_, i) => {
    const day = String(i + 1).padStart(2, '0');
    const win = i % winEvery === 0;
    return makeRecap(
      `2026-07-${day}`,
      [makeTrade({ caller, pctGain: win ? 20 : -10 })]
    );
  });
}

describe('computeRecapPerformance', () => {
  it('excludes soft trades from every stat but reports the count', () => {
    const recaps = [
      makeRecap('2026-08-19', [
        makeTrade({ caller: 'Demon', pctGain: 726.5, isSoft: true }),
        makeTrade({ caller: 'Demon', pctGain: 100 }),
      ]),
    ];
    const perf = computeRecapPerformance(recaps, 90);

    expect(perf.softExcluded).toBe(1);
    expect(perf.tradeCount).toBe(1);
    expect(perf.leaderboard[0]).toMatchObject({ caller: 'Demon', trades: 1, avgPct: 100 });
    expect(perf.awards.bestTrade?.pctGain).toBe(100); // not the soft +726.5
  });

  it('gates awards behind the trade floor but keeps everyone in the table', () => {
    const steady = dailyTrades('Steady', MIN_TRADES_FOR_AWARDS); // 20 wins of +20
    const hotshot = [
      makeRecap('2026-07-30', [makeTrade({ caller: 'Hotshot', pctGain: 999 })]),
    ];
    const perf = computeRecapPerformance([...steady, ...hotshot], 90);

    const hotshotRow = perf.leaderboard.find((c) => c.caller === 'Hotshot')!;
    expect(hotshotRow.qualifies).toBe(false);
    // Hotshot's 999% avg would win on raw numbers; the floor keeps it out.
    expect(perf.awards.bestPerformer?.caller).toBe('Steady');
    expect(perf.awards.highestWinRate?.caller).toBe('Steady');
    // Raw-count award ignores the floor by design.
    expect(perf.awards.mostWins?.caller).toBe('Steady');
    // Best single trade is any non-soft trade, floor or not.
    expect(perf.awards.bestTrade?.caller).toBe('Hotshot');
  });

  it('only profitable callers can be "most consistent"', () => {
    // SteadyLoser: 20 identical -5% trades — std dev 0 but negative avg.
    const loser = Array.from({ length: MIN_TRADES_FOR_AWARDS }, (_, i) =>
      makeRecap(`2026-06-${String(i + 1).padStart(2, '0')}`, [
        makeTrade({ caller: 'SteadyLoser', pctGain: -5 }),
      ])
    );
    const winner = dailyTrades('Grinder', MIN_TRADES_FOR_AWARDS, 2); // mixed +20/-10
    const perf = computeRecapPerformance([...loser, ...winner], 90);

    expect(perf.awards.mostConsistent?.caller).toBe('Grinder');
  });

  it('builds a cumulative series with every caller on every row', () => {
    const recaps = [
      makeRecap('2026-08-01', [makeTrade({ caller: 'A', pctGain: 50 })]),
      makeRecap('2026-08-02', [makeTrade({ caller: 'B', pctGain: 30 })]),
      makeRecap('2026-08-03', [makeTrade({ caller: 'A', pctGain: -20 })]),
    ];
    const perf = computeRecapPerformance(recaps, 90);

    expect(perf.series).toEqual([
      { date: '2026-08-01', A: 50, B: 0 },
      { date: '2026-08-02', A: 50, B: 30 },
      { date: '2026-08-03', A: 30, B: 30 },
    ]);
  });
});
