import { describe, expect, it, vi } from 'vitest';

import type { Decision, SubmittedOrder } from '../../shared/types.js';
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
