/**
 * Recap parser tests against a verbatim production recap. The fixture's own
 * STATS footer is the ground truth the checksum must reproduce: 12 options
 * lines + 5 futures trades = 17 claimed, 14 winners.
 */

import { describe, expect, it } from 'vitest';

import { isDailyRecap, parseRecap, parseRecapDate } from '../parser.js';

export const SAMPLE_RECAP = ` OPTIONALITY PRO DAILY RECAP | AUGUST 19, 2026

💎 TODAY'S PRO PLAYS:

DEMON CALLS:
🟩 $AAPL - 8/19 312.50C @ 0.74 --> 6.12 | +726.50% (Previously opened swing trade, most members already exited.)
🟩 $TSLA - 8/19 350C @ 0.52 --> 1.56 | +200.00%
🟩 $GOOGL - 8/19 345C @ 0.90 --> 1.82 | +102.70%

WAXUI CALLS:
🟩 $SPY - 0DTE 771C @ 1.00 --> 2.05 | +105.00%

SHYAMAL CALLS:
🟩 $SPX - 0DTE 7750C @ 1.80 --> 3.25 | +80.56%

VINCENT CALLS:
🟩 $TMUS - 9/18 185C | +83.00% (Closed last contract.)
🟩 $AAPL - 10/16 330C | +85.00% (If held. No more alerts, should be down to runners or profits taken.)

BISHOP CALLS:
🟩 $SHEL - 9/04 93C @ 1.30 --> 2.20 | +69.23%
🟥 $UBER - 9/04 74P @ 1.75 --> 1.33 | -24.00%
🟥 $GE - 9/11 385C @ 7.00 --> 4.00 | -42.86%
🟥 $HWM - 9/18 300C @ 7.10 --> 4.85 | -31.69%

NAMROOD CALLS:
🟩 $AAPL - 8/21 310P @ 0.92 --> 1.03 | +11.96% | $11.00

🔥 TODAY'S FUTURES PLAYS:

MITRO CALLS:
🟩 Wins: 3 | Losses: 0 | Avg. Points Per Trade: +31.00 POINTS

STORMZY CALLS:
🟩 Wins: 2 | Losses: 0 | Avg. Points Per Trade: +10.88 POINTS

📊 STATS:
🎯 Total Trades: 17
🏆 Today's Win Rate: 82.35%
🟢 Winners: 14
🔴 Losers: 3
📈 Total Options Gain: +1,365.40%
📊 Average Gain per Options Call: +113.78%
──────────────────────────────

PRO MONTHLY MEMBERSHIP NOW AUTOMATICALLY COMES WITH A 7 DAY TRIAL FOR $1!

You can see if it is a good fit for you for $1.

Join Pro TODAY → https://0ptions.com/upgrade ←

Gain full access to trades from top trading analysts and more! 🚀

⁠💎・pro-upgrade

@everyone hope you guys were able to get in on the free trade : )`;

describe('isDailyRecap', () => {
  it('accepts the daily recap header', () => {
    expect(isDailyRecap(SAMPLE_RECAP)).toBe(true);
  });

  it('rejects morning updates and other channel chatter', () => {
    expect(isDailyRecap('Good morning! Earnings this week: NVDA, CRM...')).toBe(false);
  });
});

describe('parseRecapDate', () => {
  it('reads the trading day from the header, not the message timestamp', () => {
    expect(parseRecapDate(SAMPLE_RECAP)).toBe('2026-08-19');
  });
});

describe('parseRecap on the production sample', () => {
  const result = parseRecap(SAMPLE_RECAP);
  const parse = result.parse!;

  it('parses every options line', () => {
    expect(parse.trades).toHaveLength(12);
    expect(parse.unparsedLines).toEqual([]);
  });

  it('checksum reproduces the recap footer exactly, so status is parsed', () => {
    expect(parse.checksum).toEqual({
      parsedTotal: 17,
      claimedTotal: 17,
      totalMatches: true,
      parsedWinners: 14,
      claimedWinners: 14,
      winnersMatch: true,
    });
    expect(result.status).toBe('parsed');
  });

  it('parses a full entry/exit line with a note', () => {
    const aapl = parse.trades[0]!;
    expect(aapl).toMatchObject({
      caller: 'Demon',
      ticker: 'AAPL',
      expiration: '8/19',
      strike: 312.5,
      optionType: 'call',
      entryPrice: 0.74,
      exitPrice: 6.12,
      pctGain: 726.5,
      isWin: true,
      isSoft: true, // "most members already exited" — theoretical result
    });
  });

  it('parses lines with no entry/exit, keeping the percent', () => {
    const tmus = parse.trades.find((t) => t.ticker === 'TMUS')!;
    expect(tmus).toMatchObject({
      caller: 'Vincent',
      expiration: '9/18',
      strike: 185,
      entryPrice: null,
      exitPrice: null,
      pctGain: 83,
      isSoft: false, // "Closed last contract." is a real close
    });
  });

  it('flags "If held" results as soft', () => {
    const soft = parse.trades.filter((t) => t.isSoft);
    expect(soft.map((t) => `${t.caller} ${t.ticker}`)).toEqual(['Demon AAPL', 'Vincent AAPL']);
  });

  it('tolerates trailing "| $11.00" segments (Namrood line)', () => {
    const namrood = parse.trades.find((t) => t.caller === 'Namrood')!;
    expect(namrood).toMatchObject({
      ticker: 'AAPL',
      expiration: '8/21',
      strike: 310,
      optionType: 'put',
      entryPrice: 0.92,
      exitPrice: 1.03,
      pctGain: 11.96,
      note: null,
    });
  });

  it('parses losses with negative percents', () => {
    const uber = parse.trades.find((t) => t.ticker === 'UBER')!;
    expect(uber).toMatchObject({ optionType: 'put', pctGain: -24, isWin: false });
  });

  it('captures futures aggregates for the checksum only', () => {
    expect(parse.futures).toEqual([
      { caller: 'Mitro', wins: 3, losses: 0, avgPointsPerTrade: 31 },
      { caller: 'Stormzy', wins: 2, losses: 0, avgPointsPerTrade: 10.88 },
    ]);
  });

  it('captures the claimed STATS footer verbatim', () => {
    expect(parse.claimed).toEqual({
      totalTrades: 17,
      winRatePct: 82.35,
      winners: 14,
      losers: 3,
      totalOptionsGainPct: 1365.4,
      avgGainPerOptionsCallPct: 113.78,
    });
  });
});

describe('parseRecap degradation', () => {
  it('reports not_recap for non-recap channel posts', () => {
    expect(parseRecap('Morning update: watch $NVDA into earnings.')).toEqual({
      status: 'not_recap',
      parse: null,
    });
  });

  it('downgrades to parsed_partial when a marker line does not parse', () => {
    const mangled = SAMPLE_RECAP.replace(
      '🟩 $TSLA - 8/19 350C @ 0.52 --> 1.56 | +200.00%',
      '🟩 $TSLA somebody changed the format | +200.00%'
    );
    const result = parseRecap(mangled);
    expect(result.status).toBe('parsed_partial');
    expect(result.parse!.unparsedLines).toHaveLength(1);
    expect(result.parse!.checksum.totalMatches).toBe(false); // 16 parsed vs 17 claimed
  });

  it('downgrades to parsed_partial when the footer disagrees with parsed lines', () => {
    const inflated = SAMPLE_RECAP.replace('Total Trades: 17', 'Total Trades: 99');
    const result = parseRecap(inflated);
    expect(result.status).toBe('parsed_partial');
    expect(result.parse!.checksum.totalMatches).toBe(false);
  });

  it('handles a recap with markdown emphasis around headers', () => {
    const bolded = SAMPLE_RECAP.replace('DEMON CALLS:', '**DEMON CALLS:**');
    const result = parseRecap(bolded);
    expect(result.parse!.trades.filter((t) => t.caller === 'Demon')).toHaveLength(3);
  });
});
