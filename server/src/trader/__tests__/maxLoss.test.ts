import { describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/config.js', () => ({
  config: { tradeExecutionMode: 'immediate' },
}));

import { config } from '../../shared/config.js';
import type { Decision, SubmittedOrder } from '../../shared/types.js';
import { TradeSettingsSchema } from '../../shared/types.js';
import { TraderEvents } from '../events.js';
import {
  EQUITY_MULTIPLIER,
  OPTION_MULTIPLIER,
  lossBreached,
  lossEnabled,
  normalizeOptionPremium,
  sweepMaxLoss,
  type MaxLossDeps,
} from '../maxLoss.js';
import type { McpRegistry, UserBroker } from '../rh/mcpRegistry.js';
import type { RobinhoodMcpClient } from '../rh/mcpClient.js';
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

describe('sweepMaxLoss', () => {
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

  it('does not flatten when the process is locked in approval mode', async () => {
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
    const original = config.tradeExecutionMode;
    (config as { tradeExecutionMode: 'immediate' | 'approval' }).tradeExecutionMode = 'approval';
    try {
      await sweepMaxLoss(deps, flattening);
    } finally {
      (config as { tradeExecutionMode: 'immediate' | 'approval' }).tradeExecutionMode = original;
    }
    expect(tools.placeOptionsOrder).not.toHaveBeenCalled();
  });
});

function submittedBuy(
  symbol: string,
  limitPrice: number,
  option: { optionType: 'call' | 'put'; strike: number; expiration: string } | null = null
): Decision {
  const order: SubmittedOrder = {
    symbol,
    side: 'buy',
    assetType: option ? 'option' : 'equity',
    quantity: 2,
    orderType: 'limit',
    limitPrice,
    option,
    orderId: 'buy-1',
    status: 'filled',
  };
  return {
    at: '2026-09-08T14:00:00.000Z',
    messageId: `buy-${symbol}`,
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
  optionPositions?: Array<{
    symbol: string;
    optionType: 'call' | 'put';
    strike: number;
    expiration: string;
    quantity: number;
    raw: unknown;
  }>;
  markFor?: (symbol: string) => number;
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
    getQuote: vi.fn().mockResolvedValue({ price: 150 }),
    getOptionsMarkPrice: vi
      .fn()
      .mockImplementation((symbol: string) =>
        Promise.resolve({ markPrice: opts.markFor?.(symbol) ?? 0.97 })
      ),
    placeOrder: vi.fn().mockResolvedValue({ orderId: 'eq-001', status: 'queued' }),
    placeOptionsOrder: vi.fn().mockResolvedValue({ orderId: 'opt-001', status: 'queued' }),
    getPositions: vi.fn().mockResolvedValue({ positions: [], raw: {} }),
    getOptionPositions: vi
      .fn()
      .mockResolvedValue({ positions: opts.optionPositions ?? [], raw: {} }),
    getOptionOrders: vi.fn().mockResolvedValue(null),
  } as unknown as RobinhoodTools;

  const mcp = { isConnected: vi.fn().mockReturnValue(true) } as unknown as RobinhoodMcpClient;
  const brokers: McpRegistry = {
    for: (): UserBroker => ({ mcp, tools }),
    existing: () => ({ mcp, tools }),
    drop: () => undefined,
  };
  const enqueue = vi.fn(<T,>(_userId: string, run: () => Promise<T>) => run());
  const flattening = new Set<string>();
  const deps = {
    db,
    brokers,
    events: new TraderEvents(),
    enqueue: enqueue as MaxLossDeps['enqueue'],
    now: () => RTH,
  };
  return { db, tools, enqueue, flattening, deps };
}
