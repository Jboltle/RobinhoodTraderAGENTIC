import { describe, expect, it } from 'vitest';

import { allocateFifo, contractsAtLevel, entryMismatch, heldByLot, openOptionLots, stopTrigger, type LotRow } from '../lots.js';
import type { SubmittedOrder } from '../../shared/types.js';

const OPTION = { optionType: 'call' as const, strike: 707, expiration: '2026-06-11' };

function buy(id: string, authorId: string, qty: number, at: string): LotRow {
  const order: SubmittedOrder = {
    symbol: 'QQQ',
    side: 'buy',
    assetType: 'option',
    quantity: qty,
    orderType: 'limit',
    limitPrice: 1,
    option: OPTION,
    orderId: id,
    status: 'filled',
    filledQuantity: qty,
    averageFillPrice: 1,
  };
  return { id, messageId: id, action: 'buy', authorId, at, order };
}

const LEVELS = [
  { gainPct: 25, portionPct: 25 },
  { gainPct: 50, portionPct: 25 },
  { gainPct: 75, portionPct: 25 },
  { gainPct: 100, portionPct: 25 },
];

describe('contractsAtLevel', () => {
  it('rolls a 2-lot onto +50% and +100%, and a 1-lot onto the last level', () => {
    expect(contractsAtLevel(2, LEVELS).map((level) => level.contracts)).toEqual([0, 1, 0, 1]);
    expect(contractsAtLevel(1, LEVELS).map((level) => level.contracts)).toEqual([0, 0, 0, 1]);
    expect(contractsAtLevel(4, LEVELS).map((level) => level.contracts)).toEqual([1, 1, 1, 1]);
  });
});

describe('open lots', () => {
  it('keeps two callers side by side and only consumes the lot a sell names', () => {
    const rows: LotRow[] = [
      buy('swift', 'swift', 3, '2026-10-21T14:00:00.000Z'),
      buy('shyamal', 'shyamal', 2, '2026-10-21T15:00:00.000Z'),
      {
        id: 'trim',
        messageId: 'trim',
        action: 'sell',
        authorId: 'shyamal',
        at: '2026-10-21T16:00:00.000Z',
        order: {
          symbol: 'QQQ',
          side: 'sell',
          assetType: 'option',
          quantity: 1,
          orderType: 'market',
          limitPrice: null,
          option: OPTION,
          orderId: 'trim-order',
          status: 'filled',
          lots: [{ lotId: 'shyamal', quantity: 1 }],
        },
      },
    ];
    const open = openOptionLots(rows);
    expect(open.map((lot) => [lot.authorId, lot.openQty])).toEqual([
      ['swift', 3],
      ['shyamal', 1],
    ]);
    expect(allocateFifo(open.filter((lot) => lot.authorId === 'shyamal'), 1)).toEqual([
      { lotId: 'shyamal', quantity: 1 },
    ]);
  });

  it('allocates oldest first inside one caller', () => {
    const lots = openOptionLots([
      buy('second', 'swift', 1, '2026-10-21T15:00:00.000Z'),
      buy('first', 'swift', 1, '2026-10-21T14:00:00.000Z'),
    ]);
    expect(allocateFifo(lots, 1).map((link) => link.lotId)).toEqual(['first']);
  });
});

describe('entryMismatch', () => {
  it('parks a strike outside 5% for an index or ETF and 15% for a name', () => {
    expect(entryMismatch({ ticker: 'SPY', strike: 652, spot: 752.1, callerPremium: null, mark: null })).toMatch(
      /652/
    );
    expect(entryMismatch({ ticker: 'SPY', strike: 740, spot: 752, callerPremium: null, mark: null })).toBeNull();
    expect(entryMismatch({ ticker: 'AAPL', strike: 100, spot: 180, callerPremium: null, mark: null })).toMatch(/100/);
    expect(entryMismatch({ ticker: 'AAPL', strike: 170, spot: 180, callerPremium: null, mark: null })).toBeNull();
  });

  it('parks a premium more than 30% from the mark and skips the check when the mark is missing', () => {
    expect(entryMismatch({ ticker: 'SPY', strike: 752, spot: 752, callerPremium: 1, mark: 2 })).toMatch(/premium/);
    expect(entryMismatch({ ticker: 'SPY', strike: 752, spot: 752, callerPremium: 1.8, mark: 2 })).toBeNull();
    expect(entryMismatch({ ticker: 'SPX', strike: 7520, spot: null, callerPremium: 3, mark: null })).toBeNull();
  });
});

describe('stopTrigger', () => {
  it('sets an 80% max loss at 20% of the fill', () => {
    expect(stopTrigger(1.34, 80)).toBeCloseTo(0.268);
  });
});

describe('heldByLot', () => {
  const lots = openOptionLots([
    buy('old', 'caller-1', 2, '2026-06-10T13:00:00.000Z'),
    buy('new', 'caller-1', 3, '2026-06-11T13:00:00.000Z'),
  ]);
  const position = (quantity: number, strike = 707) => ({ symbol: 'QQQ', ...OPTION, strike, quantity, raw: {} });
  const heldQty = (...positions: ReturnType<typeof position>[]) => Object.fromEntries(heldByLot(lots, positions));

  it('covers every lot when the account holds at least what the lots claim', () => {
    expect(heldQty(position(5))).toEqual({ old: 2, new: 3 });
    expect(heldQty(position(9))).toEqual({ old: 2, new: 3 });
  });

  it('hands a short position to the newest lot first, never more than held in total', () => {
    expect(heldQty(position(4))).toEqual({ old: 1, new: 3 });
    expect(heldQty(position(3))).toEqual({ old: 0, new: 3 });
    expect(heldQty(position(1))).toEqual({ old: 0, new: 1 });
  });

  it('gives nothing to lots of a contract the account does not hold', () => {
    expect(heldQty()).toEqual({ old: 0, new: 0 });
    expect(heldQty(position(5, 708))).toEqual({ old: 0, new: 0 });
    expect(heldQty(position(0))).toEqual({ old: 0, new: 0 });
  });
});
