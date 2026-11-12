import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Decision, SubmittedOrder, TradeExecutionMode } from '../../shared/types.js';
import { TradeSettingsSchema } from '../../shared/types.js';
import { brokerStops } from '../brokerStops.js';
import { TraderEvents } from '../events.js';
import {
  EQUITY_MULTIPLIER,
  FLATTEN_RETRY_MS,
  OPTION_MULTIPLIER,
  lossBreached,
  lossEnabled,
  normalizeOptionPremium,
  resolveOptionEntry,
  sweepMaxLoss,
  weightedAverageEntry,
  type MaxLossDeps,
} from '../maxLoss.js';
import type { McpRegistry, UserBroker } from '../rh/mcpRegistry.js';
import { BrokerUnavailableError, type RobinhoodMcpClient } from '../rh/mcpClient.js';
import type { RobinhoodTools } from '../rh/tools.js';
import type { OptionOrder } from '../rh/types.js';
import { createFakeDb, fakeTokens, type FakeDb } from './fakeDb.js';

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
    const { db, tools, flattening, deps } = setupMonitor({
      maxLossPct: 50,
      optionPositions: [
        { symbol: 'QQQ', optionType: 'call', strike: 707, expiration: '2026-06-11', quantity: 2, raw: {} },
      ],
      markFor: () => 0.75,
      ensureReady,
    });
    db.seedDecision(USER, submittedBuy('QQQ', 1.5, { optionType: 'call', strike: 707, expiration: '2026-06-11' }));

    await sweepMaxLoss(deps, flattening);

    expect(ensureReady).toHaveBeenCalled();
    expect(tools.placeOptionsOrder).toHaveBeenCalledOnce();
  });

  // The deployment kill switch: a read-only process observes the breach and
  // never reaches the broker. Max Loss is protection the user opted into, so
  // `approval` does not hold it — only `read_only` does.
  it('read_only deployment logs the breach and places nothing', async () => {
    const { db, tools, flattening, deps } = setupMonitor({
      maxLossPct: 50,
      optionPositions: [
        { symbol: 'QQQ', optionType: 'call', strike: 707, expiration: '2026-06-11', quantity: 2, raw: {} },
      ],
      markFor: () => 0.75,
      executionMode: 'read_only',
    });
    db.seedDecision(USER, submittedBuy('QQQ', 1.5, { optionType: 'call', strike: 707, expiration: '2026-06-11' }));

    await sweepMaxLoss(deps, flattening);
    await sweepMaxLoss(deps, flattening);

    expect(tools.placeOptionsOrder).not.toHaveBeenCalled();
    expect((await db.listDecisions(USER, 10)).filter((d) => d.kind === 'max_loss_exit')).toHaveLength(0);
    // The in-flight key stays set, so the breach is not re-logged every sweep.
    expect(flattening.size).toBe(1);
  });

  it('approval deployment still flattens: Max Loss is protection, not an entry', async () => {
    const { tools, flattening, deps } = setupMonitor({
      maxLossPct: 50,
      optionPositions: [
        { symbol: 'QQQ', optionType: 'call', strike: 707, expiration: '2026-06-11', quantity: 2, raw: {} },
      ],
      markFor: () => 0.75,
      executionMode: 'approval',
    });
    deps.db.seedDecision(USER, submittedBuy('QQQ', 1.5, { optionType: 'call', strike: 707, expiration: '2026-06-11' }));

    await sweepMaxLoss(deps, flattening);

    expect(tools.placeOptionsOrder).toHaveBeenCalledOnce();
  });

  it('skips a user whose session needs OAuth consent', async () => {
    const { tools, flattening, deps } = setupMonitor({
      maxLossPct: 50,
      ensureReady: vi.fn().mockRejectedValue(new BrokerUnavailableError('authorization required')),
    });

    await sweepMaxLoss(deps, flattening);

    expect(tools.getOptionPositions).not.toHaveBeenCalled();
    expect(tools.placeOptionsOrder).not.toHaveBeenCalled();
  });

  it('market-sells a 50% down option and leaves a sibling position untouched', async () => {
    const { db, tools, enqueue, flattening, deps } = setupMonitor({
      maxLossPct: 50,
      optionPositions: [
        { symbol: 'QQQ', optionType: 'call', strike: 707, expiration: '2026-06-11', quantity: 2, raw: {} },
        { symbol: 'NVDA', optionType: 'call', strike: 180, expiration: '2026-06-20', quantity: 3, raw: {} },
      ],
      markFor: (symbol) => (symbol === 'QQQ' ? 0.75 : 4.5),
    });
    db.seedDecision(USER, submittedBuy('QQQ', 1.5, { optionType: 'call', strike: 707, expiration: '2026-06-11' }));
    db.seedDecision(USER, submittedBuy('NVDA', 5, { optionType: 'call', strike: 180, expiration: '2026-06-20' }));

    await sweepMaxLoss(deps, flattening);

    expect(tools.placeOptionsOrder).toHaveBeenCalledOnce();
    expect(tools.placeOptionsOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'QQQ',
        optionType: 'call',
        strike: 707,
        expiration: '2026-06-11',
        contracts: 2,
        side: 'sell',
        orderType: 'market',
      })
    );
    expect(tools.placeOrder).not.toHaveBeenCalled();
    const rows = await db.listDecisions(USER, 10);
    expect(rows.some((d) => d.kind === 'max_loss_exit' && d.ticker === 'QQQ')).toBe(true);
    expect(enqueue).toHaveBeenCalled();
  });

  it('does not sell when entry is unknown', async () => {
    const { tools, flattening, deps } = setupMonitor({
      maxLossPct: 50,
      optionPositions: [
        { symbol: 'QQQ', optionType: 'call', strike: 707, expiration: '2026-06-11', quantity: 2, raw: {} },
      ],
      markFor: () => 0.3,
    });

    await sweepMaxLoss(deps, flattening);

    expect(tools.placeOptionsOrder).not.toHaveBeenCalled();
  });

  it('writes nothing when both thresholds are off', async () => {
    const { tools, flattening, deps } = setupMonitor({
      optionPositions: [
        { symbol: 'QQQ', optionType: 'call', strike: 707, expiration: '2026-06-11', quantity: 2, raw: {} },
      ],
      markFor: () => 0.3,
    });

    await sweepMaxLoss(deps, flattening);

    expect(tools.getPositions).not.toHaveBeenCalled();
    expect(tools.placeOptionsOrder).not.toHaveBeenCalled();
    expect(tools.placeOrder).not.toHaveBeenCalled();
  });

  it('does not double-fire a position already flattening', async () => {
    const { tools, flattening, deps } = setupMonitor({
      maxLossPct: 50,
      optionPositions: [
        { symbol: 'QQQ', optionType: 'call', strike: 707, expiration: '2026-06-11', quantity: 2, raw: {} },
      ],
      markFor: () => 0.75,
    });
    deps.db.seedDecision(
      USER,
      submittedBuy('QQQ', 1.5, { optionType: 'call', strike: 707, expiration: '2026-06-11' })
    );

    await sweepMaxLoss(deps, flattening);
    await sweepMaxLoss(deps, flattening);

    expect(tools.placeOptionsOrder).toHaveBeenCalledOnce();
  });

  it('stops out on the averaged-down basis, not the latest add price', async () => {
    const contract = { optionType: 'call' as const, strike: 707, expiration: '2026-06-11' };
    const { db, tools, flattening, deps } = setupMonitor({
      maxLossPct: 50,
      optionPositions: [{ symbol: 'QQQ', ...contract, quantity: 4, raw: {} }],
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
    expect(tools.placeOptionsOrder).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'QQQ', contracts: 4, side: 'sell', orderType: 'market' })
    );
  });

  it('stops an equity out on the broker average cost, not the latest add limit', async () => {
    const { db, tools, flattening, deps } = setupMonitor({
      maxLossPct: 40,
      equityPositions: [{ symbol: 'PLTR', quantity: 10, raw: { average_buy_price: '2.0000' } }],
      quoteFor: () => 1.05,
    });
    db.seedDecision(USER, submittedBuy('PLTR', 1.0, null, { quantity: 10 }));

    await sweepMaxLoss(deps, flattening);

    // Broker basis $2.00 → mark $1.05 is −47.5%; from the $1.00 add alone the
    // position would look up 5% and never stop out.
    expect(tools.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'PLTR', side: 'sell', orderType: 'market', quantity: 10 })
    );
  });

  it('re-protects a position re-entered after an earlier max-loss exit', async () => {
    const contract = { optionType: 'call' as const, strike: 707, expiration: '2026-06-11' };
    const { db, tools, flattening, deps } = setupMonitor({
      maxLossPct: 50,
      optionPositions: [{ symbol: 'QQQ', ...contract, quantity: 2, raw: {} }],
      markFor: () => 0.75,
    });
    db.seedDecision(USER, submittedBuy('QQQ', 1.5, contract));

    await sweepMaxLoss(deps, flattening); // flattens; in-flight key set
    expect(flattening.size).toBe(1);

    asMock(tools.getOptionPositions).mockResolvedValueOnce({ positions: [], raw: {} });
    await sweepMaxLoss(deps, flattening); // exit filled, position gone → key pruned
    expect(flattening.size).toBe(0);

    await sweepMaxLoss(deps, flattening); // same contract re-entered and down again

    expect(tools.placeOptionsOrder).toHaveBeenCalledTimes(2);
  });

  it('records no exit for a rejected close and retries it on the next sweep', async () => {
    const contract = { optionType: 'call' as const, strike: 707, expiration: '2026-06-11' };
    const { db, tools, flattening, deps } = setupMonitor({
      maxLossPct: 50,
      optionPositions: [{ symbol: 'QQQ', ...contract, quantity: 2, raw: {} }],
      markFor: () => 0.75,
    });
    db.seedDecision(USER, submittedBuy('QQQ', 1.5, contract));
    asMock(tools.placeOptionsOrder).mockResolvedValueOnce({ orderId: 'opt-dead', status: 'rejected' });

    await sweepMaxLoss(deps, flattening);
    const afterReject = await db.listDecisions(USER, 10);
    expect(afterReject.some((d) => d.kind === 'max_loss_exit')).toBe(false);

    await sweepMaxLoss(deps, flattening);
    expect(tools.placeOptionsOrder).toHaveBeenCalledTimes(2);
    const afterRetry = await db.listDecisions(USER, 10);
    expect(afterRetry.filter((d) => d.kind === 'max_loss_exit')).toHaveLength(1);
  });

  it('re-sells after the retry TTL when the close died but the position is still open', async () => {
    const contract = { optionType: 'call' as const, strike: 707, expiration: '2026-06-11' };
    const { db, tools, flattening, deps, nowRef } = setupMonitor({
      maxLossPct: 50,
      optionPositions: [{ symbol: 'QQQ', ...contract, quantity: 2, raw: {} }],
      markFor: () => 0.75,
    });
    db.seedDecision(USER, submittedBuy('QQQ', 1.5, contract));

    await sweepMaxLoss(deps, flattening);
    await sweepMaxLoss(deps, flattening); // in-flight close still fresh → skip
    expect(tools.placeOptionsOrder).toHaveBeenCalledTimes(1);

    nowRef.value = new Date(RTH.getTime() + FLATTEN_RETRY_MS + 1_000);
    await sweepMaxLoss(deps, flattening); // guard went stale → close re-sent

    expect(tools.placeOptionsOrder).toHaveBeenCalledTimes(2);
  });
});

describe('sweepMaxLoss — a position whose lot carries a stored stop id', () => {
  const contract = { optionType: 'call' as const, strike: 707, expiration: '2026-06-11' };

  afterEach(() => {
    brokerStops.enabled = false;
  });

  /** A 50% down QQQ position of 2, bought by this system, with `stop-1` stored on the buy. */
  function setupStopped(): ReturnType<typeof setupMonitor> {
    const monitor = setupMonitor({
      maxLossPct: 50,
      optionPositions: [{ symbol: 'QQQ', ...contract, quantity: 2, raw: {} }],
      markFor: () => 0.75,
    });
    const buy = submittedBuy('QQQ', 1.5, contract);
    monitor.db.seedMessage({ messageId: buy.messageId, sentAt: buy.at, authorId: 'caller-1' });
    monitor.db.seedDecision(USER, {
      ...buy,
      order: { ...buy.order!, filledQuantity: 2, averageFillPrice: 1.5, stopOrderId: 'stop-1' },
    });
    return monitor;
  }

  it('stops off (production): evaluates it like any other position and sells the breach', async () => {
    const { db, tools, flattening, deps } = setupStopped();
    const ledger = vi.spyOn(db, 'listOpenOptionLots');

    await sweepMaxLoss(deps, flattening);

    expect(tools.placeOptionsOrder).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ symbol: 'QQQ', ...contract, contracts: 2, side: 'sell', orderType: 'market' })
    );
    expect((await db.listDecisions(USER, 10)).some((d) => d.kind === 'max_loss_exit')).toBe(true);
    // As before the stop feature: the lot ledger is not read at all.
    expect(ledger).not.toHaveBeenCalled();
  });

  it('stops on: leaves the position to its stop', async () => {
    brokerStops.enabled = true;
    const { db, tools, flattening, deps } = setupStopped();

    await sweepMaxLoss(deps, flattening);

    expect(tools.placeOptionsOrder).not.toHaveBeenCalled();
    expect((await db.listDecisions(USER, 10)).some((d) => d.kind === 'max_loss_exit')).toBe(false);
  });
});

describe("Max Loss entry — a per-contract fill of the system's own limit buy", () => {
  const contract = { optionType: 'call' as const, strike: 707, expiration: '2026-06-11' };
  const position = { symbol: 'QQQ', ...contract, quantity: 2, raw: {} };
  /** Paid 1.59 on a 1.60 limit; Robinhood's order history reports the fill per contract. */
  const LIMIT = 1.6;
  const PER_CONTRACT_FILL = 159;

  const fill = (orderId: string, averagePrice: number, overrides: Partial<OptionOrder> = {}): OptionOrder => ({
    orderId,
    symbol: 'QQQ',
    ...contract,
    side: 'buy',
    state: 'filled',
    averagePrice,
    quantity: 2,
    createdAt: '2026-09-08T14:00:00.000Z',
    raw: {},
    ...overrides,
  });

  /** What production (d6cf5d5) computes for one filled buy. */
  const productionEntry = (averagePrice: number, mark: number | null): number =>
    normalizeOptionPremium(averagePrice, mark);

  async function sweepWith(opts: {
    mark: number;
    orders: OptionOrder[];
    buy?: Decision | null;
  }): Promise<{ sells: unknown[][]; reasons: string[] }> {
    const { db, tools, flattening, deps } = setupMonitor({
      maxLossPct: 50,
      optionPositions: [position],
      markFor: () => opts.mark,
    });
    if (opts.buy !== null) db.seedDecision(USER, opts.buy ?? submittedBuy('QQQ', LIMIT, contract));
    asMock(tools.getOptionOrders).mockResolvedValue({ orders: opts.orders, raw: {} });

    await sweepMaxLoss(deps, flattening);

    const exits = (await db.listDecisions(USER, 10)).filter((d) => d.kind === 'max_loss_exit');
    return { sells: asMock(tools.placeOptionsOrder).mock.calls, reasons: exits.map((d) => d.reason) };
  }

  it('does not sell a winner whose own limit buy is reported per contract', async () => {
    // 159 / 8.00 is under 20, so the mark alone no longer gives the scale away.
    const { sells } = await sweepWith({ mark: 8, orders: [fill('buy-1', PER_CONTRACT_FILL)] });

    expect(sells).toHaveLength(0);
  });

  it('still sells a true loss from 1.59, with the same order as before', async () => {
    const { sells, reasons } = await sweepWith({ mark: 0.7, orders: [fill('buy-1', PER_CONTRACT_FILL)] });

    expect(sells).toEqual([
      [expect.objectContaining({ symbol: 'QQQ', ...contract, contracts: 2, side: 'sell', orderType: 'market' })],
    ]);
    expect(reasons).toEqual(['Max loss: sold 2 QQQ 707C 2026-06-11 at mark $0.70 (entry $1.59)']);
  });

  it('still sells a collapse from 1.59: the corrected figure is not divided a second time', async () => {
    // 1.59 / 0.05 is itself over 20; treated as a scale error again it would read 0.0159.
    const { sells, reasons } = await sweepWith({ mark: 0.05, orders: [fill('buy-1', PER_CONTRACT_FILL)] });

    expect(sells).toHaveLength(1);
    expect(reasons).toEqual(['Max loss: sold 2 QQQ 707C 2026-06-11 at mark $0.05 (entry $1.59)']);
  });

  it('is identical to production when no recorded decision has that order id', async () => {
    const { sells, reasons } = await sweepWith({ mark: 8, orders: [fill('bought-in-the-app', PER_CONTRACT_FILL)] });

    expect(sells).toHaveLength(1);
    expect(reasons[0]).toContain('(entry $159.00)');
  });

  it('is identical to production for a market buy, even one that carries a limit', async () => {
    const buy = submittedBuy('QQQ', LIMIT, contract);
    const { sells, reasons } = await sweepWith({
      mark: 8,
      orders: [fill('buy-1', PER_CONTRACT_FILL)],
      buy: { ...buy, order: { ...buy.order!, orderType: 'market' } },
    });

    expect(sells).toHaveLength(1);
    expect(reasons[0]).toContain('(entry $159.00)');
  });

  it.each([
    ['a genuine per-share fill', 1.59],
    ['a fill just under 20 times the limit', 31.99],
    ['a limit that is not positive', PER_CONTRACT_FILL],
  ])('is identical to production for %s', (label, averagePrice) => {
    const buy = submittedBuy('QQQ', label === 'a limit that is not positive' ? 0 : LIMIT, contract);

    for (const mark of [0.7, 7.9, 8, null]) {
      expect(resolveOptionEntry([buy], position, [fill('buy-1', averagePrice)], mark)).toBe(
        productionEntry(averagePrice, mark)
      );
    }
  });

  it('is identical to production when the recorded order with that id is a sell', () => {
    const buy = submittedBuy('QQQ', LIMIT, contract);
    const sell: Decision = { ...buy, action: 'sell', order: { ...buy.order!, side: 'sell' } };

    expect(resolveOptionEntry([sell], position, [fill('buy-1', PER_CONTRACT_FILL)], 8)).toBe(159);
  });

  it('corrects at exactly 20 times the limit', () => {
    const buy = submittedBuy('QQQ', LIMIT, contract);

    expect(resolveOptionEntry([buy], position, [fill('buy-1', 32)], 8)).toBeCloseTo(0.32);
  });

  it("corrects only the system's own order when two orders opened the contract", () => {
    const buy = submittedBuy('QQQ', LIMIT, contract);
    const orders = [
      fill('buy-1', PER_CONTRACT_FILL, { createdAt: '2026-09-08T14:05:00.000Z' }),
      fill('bought-in-the-app', PER_CONTRACT_FILL, { createdAt: '2026-09-08T14:00:00.000Z' }),
    ];

    const entry = resolveOptionEntry([buy], { ...position, quantity: 4 }, orders, 8);

    expect(entry).toBeCloseTo((1.59 * 2 + 159 * 2) / 4);
  });

  it('never matches a broker order that has no id', () => {
    const buy = submittedBuy('QQQ', LIMIT, contract);
    const unplaced: Decision = { ...buy, order: { ...buy.order!, orderId: null } };

    expect(resolveOptionEntry([unplaced], position, [fill('x', PER_CONTRACT_FILL, { orderId: null })], 8)).toBe(159);
  });

  it('property: the entry is never above what production computes', () => {
    // Deterministic pseudo-random numbers: the same cases on every run.
    let seed = 20261112;
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const CASES = 5000;
    let corrected = 0;
    for (let i = 0; i < CASES; i += 1) {
      const paid = 0.01 + random() * 40;
      const limit = paid * (1 + random() * 0.2);
      const averagePrice = random() < 0.5 ? paid : paid * 100;
      const mark = random() < 0.1 ? null : 0.01 + random() * paid * 30;
      const own = random() < 0.7;
      const buy = submittedBuy('QQQ', Number(limit.toFixed(2)), contract);
      const order = fill(own ? 'buy-1' : 'bought-in-the-app', averagePrice);

      const entry = resolveOptionEntry([buy], position, [order], mark)!;
      const production = productionEntry(averagePrice, mark);

      expect(entry).toBeLessThanOrEqual(production);
      if (!own) expect(entry).toBe(production);
      if (entry !== production) {
        corrected += 1;
        expect(entry).toBeCloseTo(production / 100);
      }
    }
    // The rule did fire: this is not a test of two identical functions.
    expect(corrected).toBeGreaterThan(0);
  });
});

describe('sweepMaxLoss entry history', () => {
  const contract = { optionType: 'call' as const, strike: 707, expiration: '2026-06-11' };
  const historyReads = (db: FakeDb): number =>
    db.calls.filter((call) => call.method === 'listDecisions').length;

  it('reads the history once and still stops out from the cached basis', async () => {
    let mark = 1.2;
    const { db, tools, flattening, deps } = setupMonitor({
      maxLossPct: 50,
      optionPositions: [
        { symbol: 'QQQ', ...contract, quantity: 2, raw: {} },
        // Opened by hand: no history prices it, which must not re-read every sweep.
        { symbol: 'NVDA', optionType: 'call', strike: 180, expiration: '2026-06-20', quantity: 1, raw: {} },
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
    expect(tools.placeOptionsOrder).toHaveBeenCalledOnce();
    expect(tools.placeOptionsOrder).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'QQQ', contracts: 2, side: 'sell', orderType: 'market' })
    );
  });

  it('re-reads after a decision, so an add re-averages the stop', async () => {
    const position = { symbol: 'QQQ', ...contract, raw: {} };
    let mark = 1.1;
    const { db, tools, flattening, deps } = setupMonitor({
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
    asMock(tools.getOptionPositions).mockResolvedValue({
      positions: [{ ...position, quantity: 4 }],
      raw: {},
    });
    mark = 0.9;
    await sweepMaxLoss(deps, flattening, entries);

    // Same position, so only the event can refresh it. The basis is now
    // (2×$0.60 + 2×$2.00)/4 = $1.30, and $0.90 is −31%: held. The cached
    // $2.00 basis would read −55% and sell at a loss the user never set.
    expect(historyReads(db)).toBe(2);
    expect(tools.placeOptionsOrder).not.toHaveBeenCalled();
  });

  it('re-reads for a newly held position even when no decision event arrives', async () => {
    const nvda = { optionType: 'call' as const, strike: 180, expiration: '2026-06-20' };
    const { db, tools, flattening, deps } = setupMonitor({
      maxLossPct: 50,
      optionPositions: [{ symbol: 'QQQ', ...contract, quantity: 2, raw: {} }],
      markFor: (symbol) => (symbol === 'QQQ' ? 1.4 : 2.0),
    });
    db.seedDecision(USER, submittedBuy('QQQ', 1.5, contract));
    const entries = new Map();
    await sweepMaxLoss(deps, flattening, entries);

    // NVDA was bought and logged, but no event reached the monitor.
    db.seedDecision(USER, submittedBuy('NVDA', 5, nvda));
    asMock(tools.getOptionPositions).mockResolvedValue({
      positions: [
        { symbol: 'QQQ', ...contract, quantity: 2, raw: {} },
        { symbol: 'NVDA', ...nvda, quantity: 2, raw: {} },
      ],
      raw: {},
    });
    await sweepMaxLoss(deps, flattening, entries);

    expect(historyReads(db)).toBe(2);
    expect(tools.placeOptionsOrder).toHaveBeenCalledOnce();
    expect(tools.placeOptionsOrder).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'NVDA', strike: 180, contracts: 2, side: 'sell' })
    );
  });

  it('does not keep a failed read: the next sweep reads again and stops out', async () => {
    const { db, tools, flattening, deps } = setupMonitor({
      maxLossPct: 50,
      optionPositions: [{ symbol: 'QQQ', ...contract, quantity: 2, raw: {} }],
      markFor: () => 0.75,
    });
    db.seedDecision(USER, submittedBuy('QQQ', 1.5, contract));
    const listDecisions = vi.spyOn(db, 'listDecisions').mockRejectedValueOnce(new Error('db down'));
    const entries = new Map();

    await sweepMaxLoss(deps, flattening, entries);
    expect(tools.placeOptionsOrder).not.toHaveBeenCalled();

    await sweepMaxLoss(deps, flattening, entries);
    expect(listDecisions).toHaveBeenCalledTimes(2);
    expect(tools.placeOptionsOrder).toHaveBeenCalledOnce();
  });
});

const asMock = (fn: unknown): ReturnType<typeof vi.fn> => fn as ReturnType<typeof vi.fn>;

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
  equityPositions?: Array<{ symbol: string; quantity: number; raw: unknown }>;
  optionPositions?: Array<{
    symbol: string;
    optionType: 'call' | 'put';
    strike: number;
    expiration: string;
    quantity: number;
    raw: unknown;
  }>;
  markFor?: (symbol: string) => number;
  quoteFor?: (symbol: string) => number;
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

  const tools = {
    getBuyingPower: vi.fn().mockResolvedValue({ amountUsd: 10_000 }),
    getQuote: vi
      .fn()
      .mockImplementation((symbol: string) =>
        Promise.resolve({ price: opts.quoteFor?.(symbol) ?? 150 })
      ),
    getOptionsMarkPrice: vi
      .fn()
      .mockImplementation((symbol: string) =>
        Promise.resolve({ markPrice: opts.markFor?.(symbol) ?? 0.97 })
      ),
    placeOrder: vi.fn().mockResolvedValue({ orderId: 'eq-001', status: 'queued' }),
    placeOptionsOrder: vi.fn().mockResolvedValue({ orderId: 'opt-001', status: 'queued' }),
    getPositions: vi
      .fn()
      .mockResolvedValue({ positions: opts.equityPositions ?? [], raw: {} }),
    getOptionPositions: vi
      .fn()
      .mockResolvedValue({ positions: opts.optionPositions ?? [], raw: {} }),
    getOptionOrders: vi.fn().mockResolvedValue(null),
  } as unknown as RobinhoodTools;

  const mcp = {
    isConnected: vi.fn().mockReturnValue(true),
    ensureReady: opts.ensureReady ?? vi.fn().mockResolvedValue(undefined),
  } as unknown as RobinhoodMcpClient;
  const brokers: McpRegistry = {
    for: (): UserBroker => ({ mcp, tools }),
    existing: () => ({ mcp, tools }),
    drop: () => undefined,
  };
  const enqueue = vi.fn(<T,>(_userId: string, run: () => Promise<T>) => run());
  const flattening = new Map<string, number>();
  const nowRef = { value: RTH };
  const deps = {
    db,
    brokers,
    events: new TraderEvents(),
    enqueue: enqueue as MaxLossDeps['enqueue'],
    executionMode: opts.executionMode ?? 'immediate',
    now: () => nowRef.value,
  };
  return { db, tools, enqueue, flattening, deps, nowRef };
}
