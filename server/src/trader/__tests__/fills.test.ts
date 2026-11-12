import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Decision, SubmittedOrder } from '../../shared/types.js';
import { brokerStops } from '../brokerStops.js';
import { TraderEvents } from '../events.js';
import { applyBrokerState, sweepFills, type FillMonitorDeps } from '../fills.js';
import { BrokerUnavailableError, type RobinhoodMcpClient } from '../rh/mcpClient.js';
import type { McpRegistry, UserBroker } from '../rh/mcpRegistry.js';
import type { RobinhoodTools } from '../rh/tools.js';
import type { OptionOrder } from '../rh/types.js';
import { createFakeDb, fakeTokens } from './fakeDb.js';

const USER = 'user-1';
const NOW = new Date('2026-10-21T15:18:30.000Z');

const CONTRACT = { optionType: 'call' as const, strike: 772, expiration: '2026-10-21' };

const placed = (overrides: Partial<SubmittedOrder> = {}): SubmittedOrder => ({
  symbol: 'SPY',
  side: 'buy',
  assetType: 'option',
  quantity: 3,
  orderType: 'limit',
  limitPrice: 0.865,
  option: CONTRACT,
  orderId: 'ord-1',
  status: 'unconfirmed',
  ...overrides,
});

const submitted = (order: SubmittedOrder, at = '2026-10-21T15:18:06.000Z'): Decision => ({
  at,
  messageId: `msg-${order.orderId}`,
  kind: 'submitted',
  code: null,
  reason: `Bought ${order.quantity}x SPY 772C. Status: ${order.status}`,
  ticker: 'SPY',
  action: order.side,
  order,
});

const liveOrder = (overrides: Partial<OptionOrder> = {}): OptionOrder => ({
  orderId: 'ord-1',
  symbol: 'SPY',
  ...CONTRACT,
  side: 'buy',
  state: 'filled',
  averagePrice: 0.86,
  quantity: 3,
  createdAt: '2026-10-21T15:18:06.000Z',
  raw: {},
  ...overrides,
});

function setup(opts: { orders?: OptionOrder[] | null; ensureReady?: () => Promise<void> } = {}) {
  const db = createFakeDb();
  db.seedBrokerTokens(USER, fakeTokens('tok'));
  const tools = {
    getOptionOrders: vi.fn().mockResolvedValue(opts.orders === null ? null : { orders: opts.orders ?? [], raw: {} }),
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
  const events = new TraderEvents();
  const emitted: Decision[] = [];
  events.subscribe(USER, { onDecision: (d) => emitted.push(d) });
  const deps: FillMonitorDeps = { db, brokers, events, now: () => NOW };
  return { db, tools, deps, emitted };
}

describe('sweepFills', () => {
  it('unconfirmed → filled: writes the fill onto the row and emits the decision', async () => {
    const { db, deps, emitted } = setup({ orders: [liveOrder({ averagePrice: 0.86 })] });
    db.seedDecision(USER, submitted(placed()));

    const result = await sweepFills(deps);

    expect(result).toEqual({ open: 1, updated: 1 });
    const [row] = await db.listDecisions(USER, 10);
    expect(row!.order).toMatchObject({
      status: 'filled',
      filledQuantity: 3,
      averageFillPrice: 0.86,
      filledAt: NOW.toISOString(),
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.order?.status).toBe('filled');
  });

  it('a filled row leaves the work list, so the next sweep makes no broker call', async () => {
    const { db, deps, tools } = setup({ orders: [liveOrder()] });
    db.seedDecision(USER, submitted(placed()));

    await sweepFills(deps);
    const second = await sweepFills(deps);

    expect(second).toEqual({ open: 0, updated: 0 });
    expect(tools.getOptionOrders).toHaveBeenCalledOnce();
  });

  it('lookbackMs widens the window: a 50-day-old open row is swept only with it set', async () => {
    const { db, deps } = setup({ orders: [liveOrder()] });
    db.seedDecision(USER, submitted(placed(), '2026-09-01T15:18:06.000Z'));

    expect(await sweepFills(deps)).toEqual({ open: 0, updated: 0 });
    expect(await sweepFills({ ...deps, lookbackMs: 90 * 24 * 60 * 60 * 1000 })).toEqual({
      open: 1,
      updated: 1,
    });
  });

  it('normalizes a 159-scale fill price against the order limit', async () => {
    const { db, deps } = setup({ orders: [liveOrder({ averagePrice: 86 })] });
    db.seedDecision(USER, submitted(placed({ limitPrice: 0.865 })));

    await sweepFills(deps);

    expect((await db.listDecisions(USER, 10))[0]!.order?.averageFillPrice).toBe(0.86);
  });

  it('an order id the broker does not list is left untouched', async () => {
    const { db, deps, emitted } = setup({ orders: [liveOrder({ orderId: 'someone-else' })] });
    db.seedDecision(USER, submitted(placed()));

    const result = await sweepFills(deps);

    expect(result).toEqual({ open: 1, updated: 0 });
    expect((await db.listDecisions(USER, 10))[0]!.order?.status).toBe('unconfirmed');
    expect(emitted).toHaveLength(0);
  });

  it('an unchanged state writes nothing and emits nothing', async () => {
    const { db, deps, emitted } = setup({ orders: [liveOrder({ state: 'unconfirmed', averagePrice: null })] });
    db.seedDecision(USER, submitted(placed()));

    const result = await sweepFills(deps);

    expect(result).toEqual({ open: 1, updated: 0 });
    expect(emitted).toHaveLength(0);
  });

  it('cancelled is terminal: recorded without fill fields, then dropped from the work list', async () => {
    const { db, deps } = setup({ orders: [liveOrder({ state: 'cancelled', averagePrice: null })] });
    db.seedDecision(USER, submitted(placed()));

    await sweepFills(deps);

    const [row] = await db.listDecisions(USER, 10);
    expect(row!.order).toMatchObject({ status: 'cancelled', filledQuantity: null, averageFillPrice: null, filledAt: null });
    expect(await db.listOpenOrders(new Date(0))).toHaveLength(0);
  });

  it('never reaches for the session of a user with no connection row', async () => {
    const { db, deps, tools } = setup({ orders: [liveOrder()] });
    db.seedDecision('disconnected-user', submitted(placed()));

    const result = await sweepFills(deps);

    expect(result).toEqual({ open: 1, updated: 0 });
    expect(tools.getOptionOrders).not.toHaveBeenCalled();
    expect(deps.brokers.for('disconnected-user').mcp.ensureReady).not.toHaveBeenCalled();
  });

  it('skips a user whose session needs OAuth consent without failing the sweep', async () => {
    const { db, deps, tools } = setup({
      ensureReady: vi.fn().mockRejectedValue(new BrokerUnavailableError('authorization required')),
    });
    db.seedDecision(USER, submitted(placed()));

    const result = await sweepFills(deps);

    expect(result).toEqual({ open: 1, updated: 0 });
    expect(tools.getOptionOrders).not.toHaveBeenCalled();
  });

  it('ignores equity orders and rows older than the window', async () => {
    const { db, deps, tools } = setup({ orders: [liveOrder()] });
    db.seedDecision(
      USER,
      submitted(placed({ orderId: 'eq-1', assetType: 'equity', option: null, symbol: 'F' }))
    );
    db.seedDecision(USER, submitted(placed({ orderId: 'old-1' }), '2026-10-01T15:00:00.000Z'));

    const result = await sweepFills(deps);

    // The equity row counts as open (nothing can settle it) but triggers no read.
    expect(result).toEqual({ open: 1, updated: 0 });
    expect(tools.getOptionOrders).not.toHaveBeenCalled();
  });

  it('reaches a max_loss_exit row through the same key', async () => {
    const { db, deps } = setup({ orders: [liveOrder({ orderId: 'ml-1', side: 'sell', averagePrice: 0.4 })] });
    db.seedDecision(USER, {
      ...submitted(placed({ orderId: 'ml-1', side: 'sell', orderType: 'market', limitPrice: null, status: 'submitted' })),
      messageId: `max-loss:${USER}:opt:SPY:call:772:2026-10-21:1`,
      kind: 'max_loss_exit',
    });

    const result = await sweepFills(deps);

    expect(result.updated).toBe(1);
    expect((await db.listDecisions(USER, 10))[0]!.order).toMatchObject({ status: 'filled', averageFillPrice: 0.4 });
  });
});

describe('sweepFills — resting Max Loss stops', () => {
  const HELD = { symbol: 'SPY', ...CONTRACT, quantity: 3, raw: {} };

  beforeEach(() => {
    brokerStops.enabled = true;
  });
  afterEach(() => {
    brokerStops.enabled = false;
  });

  describe('with Robinhood-side stops off (production)', () => {
    beforeEach(() => {
      brokerStops.enabled = false;
    });

    it('a filled buy gets no stop, on the sweep that sees the fill or on a later one', async () => {
      const { db, deps, place, positions } = restSetup({
        orders: [liveOrder()],
        positions: async () => ({ positions: [HELD], raw: {} }),
      });
      seedBuy(db, placed());

      expect(await sweepFills(deps)).toEqual({ open: 1, updated: 1 });
      expect(await sweepFills(deps)).toEqual({ open: 0, updated: 0 });

      expect(place).not.toHaveBeenCalled();
      expect(positions).not.toHaveBeenCalled();
      expect((await db.listOpenOptionLots(USER))[0]?.stopOrderId).toBeNull();
    });

    it('an idle sweep is the open-orders query and nothing else', async () => {
      const { db, deps, ensureReady, tools } = restSetup({ positions: async () => ({ positions: [HELD], raw: {} }) });
      seedBuy(db, placed({ status: 'filled', filledQuantity: 3, averageFillPrice: 0.86 }));
      const users = vi.spyOn(db, 'listBrokerUserIds');
      const settings = vi.spyOn(db, 'getSettings');
      const ledger = vi.spyOn(db, 'listOpenOptionLots');

      expect(await sweepFills(deps)).toEqual({ open: 0, updated: 0 });

      expect(users).not.toHaveBeenCalled();
      expect(settings).not.toHaveBeenCalled();
      expect(ledger).not.toHaveBeenCalled();
      expect(ensureReady).not.toHaveBeenCalled();
      expect(tools.getOptionOrders).not.toHaveBeenCalled();
    });

    it('an active sweep lists users once, for the fill sync only', async () => {
      const { db, deps } = restSetup({
        orders: [liveOrder()],
        positions: async () => ({ positions: [HELD], raw: {} }),
      });
      seedBuy(db, placed());
      const users = vi.spyOn(db, 'listBrokerUserIds');
      const settings = vi.spyOn(db, 'getSettings');

      await sweepFills(deps);

      expect(users).toHaveBeenCalledOnce();
      expect(settings).not.toHaveBeenCalled();
    });
  });

  function restSetup(opts: { orders?: OptionOrder[]; positions: () => Promise<unknown> }) {
    const base = setup({ orders: opts.orders });
    base.db.seedSettings(USER, { maxLossPct: 80 });
    let stops = 0;
    const place = vi.fn(async () => ({ orderId: `stop-${(stops += 1)}`, status: 'unconfirmed', raw: {} }));
    const positions = vi.fn(opts.positions);
    Object.assign(base.tools, { placeOptionsOrder: place, getOptionPositions: positions });
    const ensureReady = base.deps.brokers.for(USER).mcp.ensureReady as ReturnType<typeof vi.fn>;
    const deps: FillMonitorDeps = { ...base.deps, executionMode: 'immediate' };
    return { ...base, deps, place, positions, ensureReady };
  }

  function seedBuy(db: ReturnType<typeof createFakeDb>, order: SubmittedOrder): void {
    db.seedMessage({ messageId: `msg-${order.orderId}`, sentAt: '2026-10-21T15:18:00.000Z', authorId: 'caller-1' });
    db.seedDecision(USER, submitted(order));
  }

  it('a fill the positions read does not show yet gets its stop on the next idle sweep', async () => {
    const shown: unknown[][] = [[], [HELD]];
    const { db, deps, place } = restSetup({
      orders: [liveOrder()],
      positions: async () => ({ positions: shown.shift() ?? [HELD], raw: {} }),
    });
    seedBuy(db, placed());

    expect(await sweepFills(deps)).toEqual({ open: 1, updated: 1 });
    expect(place).not.toHaveBeenCalled();

    expect(await sweepFills(deps)).toEqual({ open: 0, updated: 0 });
    expect(place).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ side: 'sell', orderType: 'stop_market', contracts: 3 })
    );
    expect((await db.listOpenOptionLots(USER))[0]?.stopOrderId).toBe('stop-1');
  });

  it('a fill whose positions read failed gets its stop on the next idle sweep', async () => {
    let reads = 0;
    const { db, deps, place } = restSetup({
      orders: [liveOrder()],
      positions: async () => {
        if ((reads += 1) === 1) throw new Error('get_option_positions failed after 3 attempts: fetch failed');
        return { positions: [HELD], raw: {} };
      },
    });
    seedBuy(db, placed());

    await sweepFills(deps);
    expect(place).not.toHaveBeenCalled();

    await sweepFills(deps);
    expect(place).toHaveBeenCalledOnce();
  });

  it('an idle sweep reaches for no session when the user has no lot', async () => {
    const { deps, positions, ensureReady } = restSetup({ positions: async () => ({ positions: [], raw: {} }) });

    expect(await sweepFills(deps)).toEqual({ open: 0, updated: 0 });

    expect(ensureReady).not.toHaveBeenCalled();
    expect(positions).not.toHaveBeenCalled();
  });

  it('an idle sweep reaches for no session when every lot without a stop is on an expired contract', async () => {
    const { db, deps, positions, place, ensureReady } = restSetup({
      positions: async () => ({ positions: [], raw: {} }),
    });
    const expired = { ...CONTRACT, expiration: '2026-10-20' };
    seedBuy(db, placed({ option: expired, status: 'filled', filledQuantity: 3, averageFillPrice: 0.86 }));

    expect(await sweepFills(deps)).toEqual({ open: 0, updated: 0 });

    expect(ensureReady).not.toHaveBeenCalled();
    expect(positions).not.toHaveBeenCalled();
    expect(place).not.toHaveBeenCalled();
  });

  it('an idle sweep costs one positions read while a held lot has no stop it can rest', async () => {
    const { db, deps, positions, place, ensureReady } = restSetup({
      positions: async () => ({ positions: [], raw: {} }),
    });
    seedBuy(db, placed({ status: 'filled', filledQuantity: 3, averageFillPrice: 0.86 }));

    await sweepFills(deps);

    expect(ensureReady).toHaveBeenCalledOnce();
    expect(positions).toHaveBeenCalledOnce();
    expect(place).not.toHaveBeenCalled();
  });
});

describe('applyBrokerState', () => {
  it('returns the same reference when the broker reports nothing new', () => {
    const order = placed({ status: 'filled', filledQuantity: 3, averageFillPrice: 0.86, filledAt: NOW.toISOString() });
    expect(applyBrokerState(order, liveOrder({ averagePrice: 0.86 }), NOW)).toBe(order);
  });

  it('keeps the first filledAt across later sweeps', () => {
    const first = applyBrokerState(placed(), liveOrder(), NOW);
    const later = applyBrokerState(first, liveOrder(), new Date(NOW.getTime() + 60_000));
    expect(later.filledAt).toBe(NOW.toISOString());
  });

  it('a partial fill records the processed count, not the order size', () => {
    const next = applyBrokerState(placed({ quantity: 10 }), liveOrder({ state: 'partially_filled', quantity: 4, averagePrice: 0.85 }), NOW);
    expect(next).toMatchObject({ status: 'partially_filled', filledQuantity: 4, averageFillPrice: 0.85, filledAt: null });
  });
});
