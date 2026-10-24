import { describe, expect, it } from 'vitest';

import {
  applyCallerExit,
  applyMark,
  buildLadder,
  isExpired,
  isoDateEt,
  marketCloseIso,
  mondayOf,
  nominalQty,
  openPosition,
  realizedPnl,
  remainingQty,
  settle,
  unrealizedPnl,
  type TrackedPosition,
} from '../ladder.js';

const T0 = '2026-10-21T14:00:00.000Z';
const T1 = '2026-10-21T15:00:00.000Z';
const T2 = '2026-10-21T16:00:00.000Z';

const open = (entryPrice: number | null = 0.5): TrackedPosition =>
  openPosition({
    messageId: 'm-1',
    authorId: 'harvey',
    ticker: 'spy',
    option: { optionType: 'call', strike: 680, expiration: '2026-10-21' },
    entryPrice,
    sizeHint: null,
    openedAt: T0,
  });

describe('nominalQty', () => {
  it('uses the $5k rule when the Caller stated no size', () => {
    expect(nominalQty(0.5, null)).toBe(100);
    expect(nominalQty(2.0, null)).toBe(25);
    expect(nominalQty(80, null)).toBe(1);
  });
  it('takes a stated contract count as is', () => {
    expect(nominalQty(0.5, { kind: 'contracts', value: 3 })).toBe(3);
  });
});

describe('buildLadder', () => {
  it('reserves one contract per runner first and splits the body across four levels', () => {
    const ladder = buildLadder(1, 100);
    expect(ladder.map((l) => [l.pct, l.qty, l.isRunner])).toEqual([
      [25, 24, false],
      [50, 23, false],
      [75, 23, false],
      [100, 23, false],
      [150, 1, true],
      [200, 1, true],
      [500, 1, true],
      [1000, 1, true],
      [2500, 1, true],
      [5000, 1, true],
      [10000, 1, true],
    ]);
    expect(ladder.reduce((sum, l) => sum + l.qty, 0)).toBe(100);
    expect(ladder[0]!.price).toBe(1.25);
  });
  it('drops the furthest rungs when the position is too small', () => {
    expect(buildLadder(1, 10).map((l) => l.pct)).toEqual([25, 50, 75, 100, 150, 200, 500, 1000, 2500, 5000]);
    expect(buildLadder(1, 3).map((l) => [l.pct, l.qty])).toEqual([[25, 1], [50, 1], [75, 1]]);
    expect(buildLadder(1, 1).map((l) => [l.pct, l.qty])).toEqual([[25, 1]]);
  });
});

describe('applyMark', () => {
  it('tracks the peak and fills every level the mark crossed, at the level price', () => {
    const position = applyMark(open(0.5), 0.8, T1);
    expect(position.lastMark).toBe(0.8);
    expect(position.highestPct).toBeCloseTo(60);
    expect(position.highestPrice).toBe(0.8);
    expect(position.ladder.filter((l) => l.filledAt !== null).map((l) => l.pct)).toEqual([25, 50]);
    expect(position.fills.map((f) => [f.qty, f.price, f.source])).toEqual([
      [24, 0.63, 'ladder'],
      [23, 0.75, 'ladder'],
    ]);
    expect(position.ladder[0]!.fillBasis).toBe('mark');
    expect(remainingQty(position)).toBe(53);
    expect(realizedPnl(position)).toBeCloseTo(24 * 0.13 * 100 + 23 * 0.25 * 100);
    expect(unrealizedPnl(position)).toBeCloseTo(53 * 0.3 * 100);
  });
  it('keeps the peak when the mark falls back', () => {
    const position = applyMark(applyMark(open(0.5), 0.8, T1), 0.4, T2);
    expect(position.highestPct).toBeCloseTo(60);
    expect(position.lastMark).toBe(0.4);
    expect(unrealizedPnl(position)).toBeCloseTo(53 * -0.1 * 100);
  });
  it('prices an entry the Caller never stated from the first mark', () => {
    const position = applyMark(open(null), 0.25, T1);
    expect(position.entryPrice).toBe(0.25);
    expect(position.nominalQty).toBe(200);
    expect(position.ladder).toHaveLength(11);
  });
  it('closes by ladder once every level has filled', () => {
    const position = applyMark(open(1), 200, T1);
    expect(remainingQty(position)).toBe(0);
    expect(position.closedBy).toBe('ladder');
    expect(position.result).toBe('win');
  });
});

describe('applyCallerExit', () => {
  const exit = (portion: Parameters<typeof applyCallerExit>[1]['portion'], price: number | null = 1.0) => ({
    at: T2,
    price,
    portion,
    messageId: 'm-exit',
  });
  it('a Trim sells the stated fraction of the remainder at the Caller price', () => {
    // 0.7 crosses only the +25% level (24 of 100), leaving 76 to halve.
    const position = applyCallerExit(applyMark(open(0.5), 0.7, T1), exit({ kind: 'fraction', value: 0.5 }));
    expect(position.closedAt).toBeNull();
    expect(position.fills.at(-1)).toMatchObject({ qty: 38, price: 1.0, source: 'caller', messageId: 'm-exit' });
    expect(remainingQty(position)).toBe(38);
  });
  it('a Sell closes the remainder and grades the result', () => {
    const position = applyCallerExit(open(0.5), exit({ kind: 'all' }, 0.4));
    expect(position.closedBy).toBe('caller_exit');
    expect(position.exitPrice).toBe(0.4);
    expect(remainingQty(position)).toBe(0);
    expect(realizedPnl(position)).toBeCloseTo(-0.1 * 100 * 100);
    expect(position.result).toBe('loss');
  });
  it('all-but-one leaves a runner', () => {
    const position = applyCallerExit(open(0.5), exit({ kind: 'all_but_one' }));
    expect(remainingQty(position)).toBe(1);
    expect(position.closedAt).toBeNull();
  });
  it('a Sell without any price closes an unpriced entry without a fill', () => {
    const position = applyCallerExit(open(null), exit({ kind: 'all' }, null));
    expect(position.closedBy).toBe('caller_exit');
    expect(position.fills).toEqual([]);
    expect(position.result).toBe('be');
  });
  it('is a no-op on a closed position', () => {
    const closed = applyCallerExit(open(0.5), exit({ kind: 'all' }));
    expect(applyCallerExit(closed, exit({ kind: 'all' }, 9))).toBe(closed);
  });
});

describe('settle', () => {
  it('sells the remainder at the last mark on expiry', () => {
    const position = settle(applyMark(open(0.5), 0.1, T1), T2);
    expect(position.closedBy).toBe('expiry');
    expect(position.fills.at(-1)).toMatchObject({ qty: 100, price: 0.1, source: 'expiry' });
    expect(position.result).toBe('loss');
  });
  it('expires worthless when no mark was ever seen', () => {
    const position = settle(open(0.5), T2);
    expect(position.exitPrice).toBe(0);
    expect(realizedPnl(position)).toBeCloseTo(-5000);
  });
  it('isExpired compares the expiration against the ET trading day', () => {
    expect(isExpired(open(), '2026-10-21')).toBe(false);
    expect(isExpired(open(), '2026-10-22')).toBe(true);
  });
});

describe('ET dates', () => {
  it('isoDateEt lands late-UTC timestamps on the New York day', () => {
    expect(isoDateEt(new Date('2026-10-22T02:30:00Z'))).toBe('2026-10-21');
    expect(isoDateEt(new Date('2026-10-21T14:00:00Z'))).toBe('2026-10-21');
  });
  it('mondayOf', () => {
    expect(mondayOf('2026-10-21')).toBe('2026-10-19');
    expect(mondayOf('2026-10-19')).toBe('2026-10-19');
    expect(mondayOf('2026-10-25')).toBe('2026-10-19');
  });
  it('marketCloseIso is 4 PM New York in both daylight and standard time', () => {
    expect(marketCloseIso('2026-10-16')).toBe('2026-10-16T20:00:00.000Z');
    expect(marketCloseIso('2026-12-18')).toBe('2026-12-18T21:00:00.000Z');
  });
});
