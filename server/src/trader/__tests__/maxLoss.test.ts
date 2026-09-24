import { describe, expect, it, vi } from 'vitest';

import type { Decision, SubmittedOrder } from '../../shared/types.js';
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
import type { McpRegistry, UserBroker } from '../rh/mcpRegistry.js';
import { BrokerUnavailableError, type RobinhoodMcpClient } from '../rh/mcpClient.js';
import type { RobinhoodTools } from '../rh/tools.js';
import { createFakeDb, fakeTokens } from './fakeDb.js';

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
    now: () => nowRef.value,
  };
  return { db, tools, enqueue, flattening, deps, nowRef };
}
