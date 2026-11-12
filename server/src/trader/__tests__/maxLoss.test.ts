import { describe, expect, it, vi } from 'vitest';

import type { Decision, SubmittedOrder, TradeExecutionMode } from '../../shared/types.js';
import { TradeSettingsSchema } from '../../shared/types.js';
import { TraderEvents } from '../events.js';
import {
  EQUITY_MULTIPLIER,
  FLATTEN_RETRY_MS,
  OPTION_MULTIPLIER,
  lossBreached,
  lossEnabled,
  normalizeOptionPremium,
  sweepMaxLoss,
  weightedAverageEntry,
  type MaxLossDeps,
} from '../maxLoss.js';
import { BrokerUnavailableError } from '../broker/errors.js';
import type { BrokerOrder } from '../broker/types.js';
import type { RobinhoodMcpClient } from '../robinhood/mcpClient.js';
import { createFakeDb, fakeAccount, fakeTokens, type FakeDb } from './fakeDb.js';
import {
  equityPosition,
  makeFakeBroker,
  makeFakeRegistry,
  optionPosition,
  placedOrders,
} from './harness.js';

const USER = 'user-1';

/** Tuesday 2026-09-08 10:30 ET — inside regular US hours. */
const RTH = new Date('2026-09-08T14:30:00.000Z');

describe('lossBreached', () => {
  const optionTwoLots = {
    entry: 1.5,
    mark: 0.75,
    quantity: 2,
    multiplier: OPTION_MULTIPLIER,
  };

  it('trips $150 total P&L on 2 contracts @ $1.50 → $0.75', () => {
    expect(lossBreached({ ...optionTwoLots, maxLossPct: null, maxLossUsd: 150 })).toBe(true);
  });

  it('trips −50% on the same move', () => {
    expect(lossBreached({ ...optionTwoLots, maxLossPct: 50, maxLossUsd: null })).toBe(true);
  });

  it('does not trip sibling numbers still inside both limits', () => {
    expect(
      lossBreached({
        entry: 1.5,
        mark: 1.0,
        quantity: 2,
        multiplier: OPTION_MULTIPLIER,
        maxLossPct: 50,
        maxLossUsd: 150,
      })
    ).toBe(false);
  });

  it('never trips when both settings are off', () => {
    expect(lossBreached({ ...optionTwoLots, maxLossPct: null, maxLossUsd: null })).toBe(false);
    expect(lossBreached({ ...optionTwoLots, maxLossPct: 0, maxLossUsd: 0 })).toBe(false);
  });

  it('trips equity total P&L: 10 shares @ $100 → $85 is −$150', () => {
    expect(
      lossBreached({
        entry: 100,
        mark: 85,
        quantity: 10,
        multiplier: EQUITY_MULTIPLIER,
        maxLossPct: null,
        maxLossUsd: 150,
      })
    ).toBe(true);
  });

  it('OR: percent alone is enough when the dollar side is off', () => {
    expect(lossBreached({ ...optionTwoLots, maxLossPct: 40, maxLossUsd: null })).toBe(true);
  });
});

describe('lossEnabled / normalizeOptionPremium', () => {
  it('treats null and 0 as off', () => {
    expect(lossEnabled(null, null)).toBe(false);
    expect(lossEnabled(0, 0)).toBe(false);
    expect(lossEnabled(50, null)).toBe(true);
    expect(lossEnabled(null, 150)).toBe(true);
  });

  it('divides a cents-scale average when it is ≥20× the mark', () => {
    expect(normalizeOptionPremium(159, 1.59)).toBe(1.59);
    expect(normalizeOptionPremium(1.59, 1.5)).toBe(1.59);
  });
});

describe('weightedAverageEntry', () => {
  it('averages the newest lots covering the open quantity', () => {
    // Averaged down: add 2 @ $1.00 after 2 @ $2.00 (newest-first) → basis $1.50.
    expect(
      weightedAverageEntry([{ price: 1, quantity: 2 }, { price: 2, quantity: 2 }], 4)
    ).toBe(1.5);
  });

  it('ignores lots older than the covering set', () => {
    // Only 2 contracts open: the older $2.00 lot was sold and must not dilute.
    expect(
      weightedAverageEntry([{ price: 1, quantity: 2 }, { price: 2, quantity: 2 }], 2)
    ).toBe(1);
  });

  it('averages what exists when history covers less than the open quantity', () => {
    expect(weightedAverageEntry([{ price: 1.2, quantity: 1 }], 5)).toBe(1.2);
  });

  it('returns null with no usable lots', () => {
    expect(weightedAverageEntry([], 3)).toBe(null);
    expect(weightedAverageEntry([{ price: 0, quantity: 2 }], 2)).toBe(null);
  });
});

describe('sweepMaxLoss', () => {
  it('reconnects a cold session from stored tokens before scanning', async () => {
    const ensureReady = vi.fn().mockResolvedValue(undefined);
    const { db, broker, flattening, deps } = setupMonitor({
      maxLossPct: 50,
      optionPositions: [
        { symbol: 'QQQ', optionType: 'call', strike: 707, expiration: '2026-06-11', quantity: 2 },
      ],
      markFor: () => 0.75,
      ensureReady,
    });
    db.seedDecision(USER, submittedBuy('QQQ', 1.5, { optionType: 'call', strike: 707, expiration: '2026-06-11' }));

    await sweepMaxLoss(deps, flattening);

    expect(ensureReady).toHaveBeenCalled();
    expect(placedOrders(broker, 'option')).toHaveLength(1);
  });

  // The deployment kill switch: a read-only process observes the breach and
  // never reaches the broker. Max Loss is protection the user opted into, so
  // `approval` does not hold it — only `read_only` does.
  it('read_only deployment logs the breach and places nothing', async () => {
    const { db, broker, flattening, deps } = setupMonitor({
      maxLossPct: 50,
      optionPositions: [
        { symbol: 'QQQ', optionType: 'call', strike: 707, expiration: '2026-06-11', quantity: 2 },
      ],
      markFor: () => 0.75,
      executionMode: 'read_only',
    });
    db.seedDecision(USER, submittedBuy('QQQ', 1.5, { optionType: 'call', strike: 707, expiration: '2026-06-11' }));

    await sweepMaxLoss(deps, flattening);
    await sweepMaxLoss(deps, flattening);

    expect(placedOrders(broker, 'option')).toHaveLength(0);
    expect((await db.listDecisions(USER, 10)).filter((d) => d.kind === 'max_loss_exit')).toHaveLength(0);
    // The in-flight key stays set, so the breach is not re-logged every sweep.
    expect(flattening.size).toBe(1);
  });

  it('approval deployment still flattens: Max Loss is protection, not an entry', async () => {
    const { broker, flattening, deps } = setupMonitor({
      maxLossPct: 50,
      optionPositions: [
        { symbol: 'QQQ', optionType: 'call', strike: 707, expiration: '2026-06-11', quantity: 2 },
      ],
      markFor: () => 0.75,
      executionMode: 'approval',
    });
    deps.db.seedDecision(USER, submittedBuy('QQQ', 1.5, { optionType: 'call', strike: 707, expiration: '2026-06-11' }));

    await sweepMaxLoss(deps, flattening);

    expect(placedOrders(broker, 'option')).toHaveLength(1);
  });

  it('skips a user whose session needs OAuth consent', async () => {
    const { broker, flattening, deps } = setupMonitor({
      maxLossPct: 50,
      ensureReady: vi.fn().mockRejectedValue(new BrokerUnavailableError('authorization required')),
    });

    await sweepMaxLoss(deps, flattening);

    expect(broker.getPositions).not.toHaveBeenCalled();
    expect(placedOrders(broker, 'option')).toHaveLength(0);
  });

  it('market-sells a 50% down option and leaves a sibling position untouched', async () => {
    const { db, broker, enqueue, flattening, deps } = setupMonitor({
      maxLossPct: 50,
      optionPositions: [
        { symbol: 'QQQ', optionType: 'call', strike: 707, expiration: '2026-06-11', quantity: 2 },
        { symbol: 'NVDA', optionType: 'call', strike: 180, expiration: '2026-06-20', quantity: 3 },
      ],
      markFor: (symbol) => (symbol === 'QQQ' ? 0.75 : 4.5),
    });
    db.seedDecision(USER, submittedBuy('QQQ', 1.5, { optionType: 'call', strike: 707, expiration: '2026-06-11' }));
    db.seedDecision(USER, submittedBuy('NVDA', 5, { optionType: 'call', strike: 180, expiration: '2026-06-20' }));

    await sweepMaxLoss(deps, flattening);

    expect(placedOrders(broker, 'option')).toHaveLength(1);
    expect(broker.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        instrument: {
          kind: 'option',
          symbol: 'QQQ',
          optionType: 'call',
          strike: 707,
          expiration: '2026-06-11',
        },
        quantity: 2,
        side: 'sell',
        type: 'market',
      })
    );
    expect(placedOrders(broker, 'equity')).toHaveLength(0);
    const rows = await db.listDecisions(USER, 10);
    expect(rows.some((d) => d.kind === 'max_loss_exit' && d.ticker === 'QQQ')).toBe(true);
    expect(enqueue).toHaveBeenCalled();
  });

  it('skips a position whose lot has a resting stop, so it is not closed twice', async () => {
    const { db, broker, flattening, deps } = setupMonitor({
      maxLossPct: 50,
      optionPositions: [
        { symbol: 'QQQ', optionType: 'call', strike: 707, expiration: '2026-06-11', quantity: 2 },
        { symbol: 'NVDA', optionType: 'call', strike: 180, expiration: '2026-06-20', quantity: 3 },
      ],
      // Both are down 50% or more; only QQQ's lot has a stop resting at the broker.
      markFor: (symbol) => (symbol === 'QQQ' ? 0.75 : 2),
    });
    const stopped = submittedBuy('QQQ', 1.5, { optionType: 'call', strike: 707, expiration: '2026-06-11' });
    db.seedMessage({ messageId: stopped.messageId, sentAt: stopped.at });
    db.seedDecision(USER, { ...stopped, order: { ...stopped.order!, stopOrderId: 'stop-1' } });
    db.seedDecision(USER, submittedBuy('NVDA', 5, { optionType: 'call', strike: 180, expiration: '2026-06-20' }));

    await sweepMaxLoss(deps, flattening);

    expect(placedOrders(broker, 'option')).toMatchObject([
      { instrument: { symbol: 'NVDA' }, side: 'sell', quantity: 3 },
    ]);
    const exits = (await db.listDecisions(USER, 10)).filter((d) => d.kind === 'max_loss_exit');
    expect(exits.map((d) => d.ticker)).toEqual(['NVDA']);
  });

  describe('entry price from broker fills', () => {
    const SPY_CALL = { kind: 'option', symbol: 'SPY', optionType: 'call', strike: 772, expiration: '2026-10-21' } as const;
    const buyOrder = (order: Pick<BrokerOrder, 'orderId' | 'status' | 'fillPrice' | 'createdAt'>): BrokerOrder => ({
      instrument: SPY_CALL,
      side: 'buy',
      quantity: 2,
      ...order,
    });
    // Robinhood reports this fill per contract: the premium paid was 1.59.
    const FILLED = buyOrder({ orderId: 'ord-1', status: 'filled', fillPrice: 159, createdAt: '2026-09-08T14:00:00Z' });
    // Newer, never filled, and priced where it would look like a 90% loss if counted.
    const UNFILLED = [
      buyOrder({ orderId: 'ord-2', status: 'cancelled', fillPrice: 15, createdAt: '2026-09-08T14:10:00Z' }),
      buyOrder({ orderId: 'ord-3', status: 'queued', fillPrice: 15, createdAt: '2026-09-08T14:20:00Z' }),
    ];
    const held = [{ symbol: 'SPY', optionType: 'call' as const, strike: 772, expiration: '2026-10-21', quantity: 2 }];

    it('reads a fill reported as 159 as 1.59, ignores unfilled buys, and does not sell inside the limit', async () => {
      const { db, broker, flattening, deps } = setupMonitor({
        maxLossPct: 50,
        optionPositions: held,
        markFor: () => 1.5,
        orders: [...UNFILLED, FILLED],
      });

      await sweepMaxLoss(deps, flattening);

      expect(broker.getOrders).toHaveBeenCalledOnce();
      expect(placedOrders(broker, 'option')).toHaveLength(0);
      expect((await db.listDecisions(USER, 10)).some((d) => d.kind === 'max_loss_exit')).toBe(false);
    });

    it('sells on that 1.59 entry once the mark is 50% below it', async () => {
      const { db, broker, flattening, deps } = setupMonitor({
        maxLossPct: 50,
        optionPositions: held,
        markFor: () => 0.75,
        orders: [...UNFILLED, FILLED],
      });

      await sweepMaxLoss(deps, flattening);

      expect(placedOrders(broker, 'option')).toMatchObject([{ side: 'sell', quantity: 2, type: 'market' }]);
      const [exit] = (await db.listDecisions(USER, 10)).filter((d) => d.kind === 'max_loss_exit');
      expect(exit!.reason).toContain('(entry $1.59)');
    });
  });

  it('does not sell when entry is unknown', async () => {
    const { broker, flattening, deps } = setupMonitor({
      maxLossPct: 50,
      optionPositions: [
        { symbol: 'QQQ', optionType: 'call', strike: 707, expiration: '2026-06-11', quantity: 2 },
      ],
      markFor: () => 0.3,
    });

    await sweepMaxLoss(deps, flattening);

    expect(placedOrders(broker, 'option')).toHaveLength(0);
  });

  it('writes nothing when both thresholds are off', async () => {
    const { broker, flattening, deps } = setupMonitor({
      optionPositions: [
        { symbol: 'QQQ', optionType: 'call', strike: 707, expiration: '2026-06-11', quantity: 2 },
      ],
      markFor: () => 0.3,
    });

    await sweepMaxLoss(deps, flattening);

    expect(broker.getPositions).not.toHaveBeenCalled();
    expect(placedOrders(broker, 'option')).toHaveLength(0);
    expect(placedOrders(broker, 'equity')).toHaveLength(0);
  });

  it('does not double-fire a position already flattening', async () => {
    const { broker, flattening, deps } = setupMonitor({
      maxLossPct: 50,
      optionPositions: [
        { symbol: 'QQQ', optionType: 'call', strike: 707, expiration: '2026-06-11', quantity: 2 },
      ],
      markFor: () => 0.75,
    });
    deps.db.seedDecision(
      USER,
      submittedBuy('QQQ', 1.5, { optionType: 'call', strike: 707, expiration: '2026-06-11' })
    );

    await sweepMaxLoss(deps, flattening);
    await sweepMaxLoss(deps, flattening);

    expect(placedOrders(broker, 'option')).toHaveLength(1);
  });

  it('stops out on the averaged-down basis, not the latest add price', async () => {
    const contract = { optionType: 'call' as const, strike: 707, expiration: '2026-06-11' };
    const { db, broker, flattening, deps } = setupMonitor({
      maxLossPct: 50,
      optionPositions: [{ symbol: 'QQQ', ...contract, quantity: 4 }],
      markFor: () => 0.7,
    });
    db.seedDecision(
      USER,
      submittedBuy('QQQ', 2.0, contract, { messageId: 'buy-QQQ-entry', at: '2026-09-08T13:00:00.000Z' })
    );
    db.seedDecision(
      USER,
      submittedBuy('QQQ', 1.0, contract, { messageId: 'buy-QQQ-add', at: '2026-09-08T14:00:00.000Z' })
    );

    await sweepMaxLoss(deps, flattening);

    // Basis is (2×$2 + 2×$1)/4 = $1.50, so mark $0.70 is −53%. From the $1.00
    // add alone the move is only −30% and the stop would never have fired.
    expect(broker.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        instrument: expect.objectContaining({ kind: 'option', symbol: 'QQQ' }),
        quantity: 4,
        side: 'sell',
        type: 'market',
      })
    );
  });

  it('stops an equity out on the broker average cost, not the latest add limit', async () => {
    const { db, broker, flattening, deps } = setupMonitor({
      maxLossPct: 40,
      equityPositions: [{ symbol: 'PLTR', quantity: 10, averageEntryPrice: 2 }],
      quoteFor: () => 1.05,
    });
    db.seedDecision(USER, submittedBuy('PLTR', 1.0, null, { quantity: 10 }));

    await sweepMaxLoss(deps, flattening);

    // Broker basis $2.00 → mark $1.05 is −47.5%; from the $1.00 add alone the
    // position would look up 5% and never stop out.
    expect(broker.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        instrument: { kind: 'equity', symbol: 'PLTR' },
        side: 'sell',
        type: 'market',
        quantity: 10,
      })
    );
  });

  it('re-protects a position re-entered after an earlier max-loss exit', async () => {
    const contract = { optionType: 'call' as const, strike: 707, expiration: '2026-06-11' };
    const { db, broker, flattening, deps } = setupMonitor({
      maxLossPct: 50,
      optionPositions: [{ symbol: 'QQQ', ...contract, quantity: 2 }],
      markFor: () => 0.75,
    });
    db.seedDecision(USER, submittedBuy('QQQ', 1.5, contract));

    await sweepMaxLoss(deps, flattening); // flattens; in-flight key set
    expect(flattening.size).toBe(1);

    broker.getPositions.mockResolvedValueOnce([]);
    await sweepMaxLoss(deps, flattening); // exit filled, position gone → key pruned
    expect(flattening.size).toBe(0);

    await sweepMaxLoss(deps, flattening); // same contract re-entered and down again

    expect(placedOrders(broker, 'option')).toHaveLength(2);
  });

  it('records no exit for a rejected close and retries it on the next sweep', async () => {
    const contract = { optionType: 'call' as const, strike: 707, expiration: '2026-06-11' };
    const { db, broker, flattening, deps } = setupMonitor({
      maxLossPct: 50,
      optionPositions: [{ symbol: 'QQQ', ...contract, quantity: 2 }],
      markFor: () => 0.75,
    });
    db.seedDecision(USER, submittedBuy('QQQ', 1.5, contract));
    broker.placeOrder.mockResolvedValueOnce({ orderId: 'opt-dead', status: 'rejected' });

    await sweepMaxLoss(deps, flattening);
    const afterReject = await db.listDecisions(USER, 10);
    expect(afterReject.some((d) => d.kind === 'max_loss_exit')).toBe(false);

    await sweepMaxLoss(deps, flattening);
    expect(placedOrders(broker, 'option')).toHaveLength(2);
    const afterRetry = await db.listDecisions(USER, 10);
    expect(afterRetry.filter((d) => d.kind === 'max_loss_exit')).toHaveLength(1);
  });

  it('re-sells after the retry TTL when the close died but the position is still open', async () => {
    const contract = { optionType: 'call' as const, strike: 707, expiration: '2026-06-11' };
    const { db, broker, flattening, deps, nowRef } = setupMonitor({
      maxLossPct: 50,
      optionPositions: [{ symbol: 'QQQ', ...contract, quantity: 2 }],
      markFor: () => 0.75,
    });
    db.seedDecision(USER, submittedBuy('QQQ', 1.5, contract));

    await sweepMaxLoss(deps, flattening);
    await sweepMaxLoss(deps, flattening); // in-flight close still fresh → skip
    expect(placedOrders(broker, 'option')).toHaveLength(1);

    nowRef.value = new Date(RTH.getTime() + FLATTEN_RETRY_MS + 1_000);
    await sweepMaxLoss(deps, flattening); // guard went stale → close re-sent

    expect(placedOrders(broker, 'option')).toHaveLength(2);
  });
});

describe('sweepMaxLoss entry history', () => {
  const contract = { optionType: 'call' as const, strike: 707, expiration: '2026-06-11' };
  const historyReads = (db: FakeDb): number =>
    db.calls.filter((call) => call.method === 'listDecisions').length;

  it('reads the history once and still stops out from the cached basis', async () => {
    let mark = 1.2;
    const { db, broker, flattening, deps } = setupMonitor({
      maxLossPct: 50,
      optionPositions: [
        { symbol: 'QQQ', ...contract, quantity: 2 },
        // Opened by hand: no history prices it, which must not re-read every sweep.
        { symbol: 'NVDA', optionType: 'call', strike: 180, expiration: '2026-06-20', quantity: 1 },
      ],
      markFor: () => mark,
    });
    db.seedDecision(USER, submittedBuy('QQQ', 1.5, contract));
    const entries = new Map();

    await sweepMaxLoss(deps, flattening, entries);
    await sweepMaxLoss(deps, flattening, entries);
    mark = 0.75;
    await sweepMaxLoss(deps, flattening, entries);

    expect(historyReads(db)).toBe(1);
    expect(placedOrders(broker, 'option')).toHaveLength(1);
    expect(broker.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        instrument: expect.objectContaining({ kind: 'option', symbol: 'QQQ' }),
        quantity: 2,
        side: 'sell',
        type: 'market',
      })
    );
  });

  it('re-reads after a decision, so an add re-averages the stop', async () => {
    const position = { symbol: 'QQQ', ...contract };
    let mark = 1.1;
    const { db, broker, flattening, deps } = setupMonitor({
      maxLossPct: 50,
      optionPositions: [{ ...position, quantity: 2 }],
      markFor: () => mark,
    });
    db.seedDecision(
      USER,
      submittedBuy('QQQ', 2.0, contract, { messageId: 'buy-QQQ-entry', at: '2026-09-08T13:00:00.000Z' })
    );
    const entries = new Map();
    await sweepMaxLoss(deps, flattening, entries); // $2.00 basis, mark $1.10: −45%, held

    const add = submittedBuy('QQQ', 0.6, contract, {
      messageId: 'buy-QQQ-add',
      at: '2026-09-08T14:00:00.000Z',
    });
    await db.recordDecision(USER, add);
    deps.events.emitDecision(USER, add);
    broker.getPositions.mockResolvedValue(optionPositions([{ ...position, quantity: 4 }]));
    mark = 0.9;
    await sweepMaxLoss(deps, flattening, entries);

    // Same position, so only the event can refresh it. The basis is now
    // (2×$0.60 + 2×$2.00)/4 = $1.30, and $0.90 is −31%: held. The cached
    // $2.00 basis would read −55% and sell at a loss the user never set.
    expect(historyReads(db)).toBe(2);
    expect(placedOrders(broker, 'option')).toHaveLength(0);
  });

  it('re-reads for a newly held position even when no decision event arrives', async () => {
    const nvda = { optionType: 'call' as const, strike: 180, expiration: '2026-06-20' };
    const { db, broker, flattening, deps } = setupMonitor({
      maxLossPct: 50,
      optionPositions: [{ symbol: 'QQQ', ...contract, quantity: 2 }],
      markFor: (symbol) => (symbol === 'QQQ' ? 1.4 : 2.0),
    });
    db.seedDecision(USER, submittedBuy('QQQ', 1.5, contract));
    const entries = new Map();
    await sweepMaxLoss(deps, flattening, entries);

    // NVDA was bought and logged, but no event reached the monitor.
    db.seedDecision(USER, submittedBuy('NVDA', 5, nvda));
    broker.getPositions.mockResolvedValue(
      optionPositions([
        { symbol: 'QQQ', ...contract, quantity: 2 },
        { symbol: 'NVDA', ...nvda, quantity: 2 },
      ])
    );
    await sweepMaxLoss(deps, flattening, entries);

    expect(historyReads(db)).toBe(2);
    expect(placedOrders(broker, 'option')).toHaveLength(1);
    expect(broker.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        instrument: expect.objectContaining({ kind: 'option', symbol: 'NVDA', strike: 180 }),
        quantity: 2,
        side: 'sell',
      })
    );
  });

  it('does not keep a failed read: the next sweep reads again and stops out', async () => {
    const { db, broker, flattening, deps } = setupMonitor({
      maxLossPct: 50,
      optionPositions: [{ symbol: 'QQQ', ...contract, quantity: 2 }],
      markFor: () => 0.75,
    });
    db.seedDecision(USER, submittedBuy('QQQ', 1.5, contract));
    const listDecisions = vi.spyOn(db, 'listDecisions').mockRejectedValueOnce(new Error('db down'));
    const entries = new Map();

    await sweepMaxLoss(deps, flattening, entries);
    expect(placedOrders(broker, 'option')).toHaveLength(0);

    await sweepMaxLoss(deps, flattening, entries);
    expect(listDecisions).toHaveBeenCalledTimes(2);
    expect(placedOrders(broker, 'option')).toHaveLength(1);
  });
});

describe('sweepMaxLoss across two accounts of one user', () => {
  const OWNER = 'user-owner';
  const PROTECTED = fakeAccount('account-protected', OWNER);
  const UNPROTECTED = fakeAccount('account-unprotected', OWNER);
  const CALL = { optionType: 'call', strike: 707, expiration: '2026-06-11' } as const;

  it('sells only on the account whose own setting is breached, and records it there', async () => {
    const db = createFakeDb();
    db.addAccount(PROTECTED);
    db.addAccount(UNPROTECTED);
    const brokers = new Map(
      [PROTECTED, UNPROTECTED].map((account) => {
        db.seedBrokerTokens(account.id, fakeTokens('tok'));
        db.seedDecision(account.id, submittedBuy('QQQ', 1.5, CALL));
        const broker = makeFakeBroker({
          positions: [optionPosition('QQQ', CALL.optionType, CALL.strike, CALL.expiration, 2)],
          optionMark: 0.75,
        });
        return [account.id, broker] as const;
      })
    );
    db.seedSettings(PROTECTED.id, TradeSettingsSchema.parse({ maxLossPct: 50 }));
    db.seedSettings(UNPROTECTED.id, TradeSettingsSchema.parse({ maxLossPct: null }));
    const session = {
      isConnected: vi.fn().mockReturnValue(true),
      ensureReady: vi.fn().mockResolvedValue(undefined),
    } as unknown as RobinhoodMcpClient;
    const enqueue = vi.fn(<T,>(_accountId: string, run: () => Promise<T>) => run());

    await sweepMaxLoss(
      {
        db,
        brokers: makeFakeRegistry((accountId) => ({ session, broker: brokers.get(accountId)! })),
        events: new TraderEvents(),
        enqueue: enqueue as MaxLossDeps['enqueue'],
        now: () => RTH,
      },
      new Map()
    );

    expect(placedOrders(brokers.get(PROTECTED.id)!, 'option')).toMatchObject([{ side: 'sell', quantity: 2, type: 'market' }]);
    expect(placedOrders(brokers.get(UNPROTECTED.id)!, 'option')).toHaveLength(0);

    const exits = (await db.listDecisions(PROTECTED.id, 10)).filter((d) => d.kind === 'max_loss_exit');
    expect(exits).toHaveLength(1);
    // The exit's synthetic message id names the owner, exactly as it did
    // before accounts existed; the row itself belongs to the account.
    expect(exits[0]!.messageId).toBe(`max-loss:${OWNER}:opt:QQQ:call:707:2026-06-11:${RTH.getTime()}`);
    expect((await db.listDecisions(UNPROTECTED.id, 10)).some((d) => d.kind === 'max_loss_exit')).toBe(false);
    expect(await db.listDecisions(OWNER, 10)).toEqual([]);
    // Each scan runs on its own account's queue, the one its callouts use.
    expect(enqueue.mock.calls.map(([accountId]) => accountId)).toEqual([PROTECTED.id, UNPROTECTED.id]);
  });

  it("one account's close in flight does not hold back the other account's", async () => {
    // Both accounts hold the same contract past the same threshold.
    const accounts = [PROTECTED, UNPROTECTED];
    const db = createFakeDb();
    const brokers = new Map(
      accounts.map((account) => {
        db.addAccount(account);
        db.seedBrokerTokens(account.id, fakeTokens('tok'));
        db.seedDecision(account.id, submittedBuy('QQQ', 1.5, CALL));
        db.seedSettings(account.id, TradeSettingsSchema.parse({ maxLossPct: 50 }));
        const broker = makeFakeBroker({
          positions: [optionPosition('QQQ', CALL.optionType, CALL.strike, CALL.expiration, 2)],
          optionMark: 0.75,
        });
        return [account.id, broker] as const;
      })
    );
    const session = {
      isConnected: vi.fn().mockReturnValue(true),
      ensureReady: vi.fn().mockResolvedValue(undefined),
    } as unknown as RobinhoodMcpClient;
    const deps: MaxLossDeps = {
      db,
      brokers: makeFakeRegistry((accountId) => ({ session, broker: brokers.get(accountId)! })),
      events: new TraderEvents(),
      enqueue: (_accountId, run) => run(),
      now: () => RTH,
    };
    const flattening = new Map<string, number>();
    const closes = (): number[] => accounts.map((account) => placedOrders(brokers.get(account.id)!, 'option').length);

    await sweepMaxLoss(deps, flattening);
    expect(closes()).toEqual([1, 1]);

    // Inside the retry window each account's own close still holds its own re-sell back.
    await sweepMaxLoss(deps, flattening);
    expect(closes()).toEqual([1, 1]);
  });
});

interface OptionRow {
  readonly symbol: string;
  readonly optionType: 'call' | 'put';
  readonly strike: number;
  readonly expiration: string;
  readonly quantity: number;
}

const optionPositions = (rows: readonly OptionRow[]) =>
  rows.map((row) =>
    optionPosition(row.symbol, row.optionType, row.strike, row.expiration, row.quantity)
  );

function submittedBuy(
  symbol: string,
  limitPrice: number,
  option: { optionType: 'call' | 'put'; strike: number; expiration: string } | null = null,
  opts: { quantity?: number; at?: string; messageId?: string } = {}
): Decision {
  const order: SubmittedOrder = {
    symbol,
    side: 'buy',
    assetType: option ? 'option' : 'equity',
    quantity: opts.quantity ?? 2,
    orderType: 'limit',
    limitPrice,
    option,
    orderId: 'buy-1',
    status: 'filled',
  };
  return {
    at: opts.at ?? '2026-09-08T14:00:00.000Z',
    messageId: opts.messageId ?? `buy-${symbol}`,
    kind: 'submitted',
    code: null,
    reason: 'bought',
    ticker: symbol,
    action: 'buy',
    order,
  };
}

function setupMonitor(opts: {
  maxLossPct?: number | null;
  maxLossUsd?: number | null;
  equityPositions?: Array<{ symbol: string; quantity: number; averageEntryPrice?: number }>;
  optionPositions?: OptionRow[];
  markFor?: (symbol: string) => number;
  quoteFor?: (symbol: string) => number;
  /** The broker's order history; the fake offers none unless given. */
  orders?: readonly BrokerOrder[];
  ensureReady?: () => Promise<void>;
  executionMode?: TradeExecutionMode;
}) {
  const db = createFakeDb();
  db.seedBrokerTokens(USER, fakeTokens('tok'));
  db.seedSettings(
    USER,
    TradeSettingsSchema.parse({
      maxLossPct: opts.maxLossPct ?? null,
      maxLossUsd: opts.maxLossUsd ?? null,
    })
  );

  const broker = makeFakeBroker({
    positions: [
      ...(opts.equityPositions ?? []).map((row) =>
        equityPosition(row.symbol, row.quantity, row.averageEntryPrice ?? null)
      ),
      ...optionPositions(opts.optionPositions ?? []),
    ],
    equityMark: (symbol) => opts.quoteFor?.(symbol) ?? 150,
    optionMark: (contract) => opts.markFor?.(contract.symbol) ?? 0.97,
    orders: opts.orders ?? null,
  });

  const mcp = {
    isConnected: vi.fn().mockReturnValue(true),
    ensureReady: opts.ensureReady ?? vi.fn().mockResolvedValue(undefined),
  } as unknown as RobinhoodMcpClient;
  const brokers = makeFakeRegistry(() => ({ session: mcp, broker }), opts.executionMode);
  const enqueue = vi.fn(<T,>(_userId: string, run: () => Promise<T>) => run());
  const flattening = new Map<string, number>();
  const nowRef = { value: RTH };
  const deps = {
    db,
    brokers,
    events: new TraderEvents(),
    enqueue: enqueue as MaxLossDeps['enqueue'],
    now: () => nowRef.value,
  };
  return { db, broker, enqueue, flattening, deps, nowRef };
}
