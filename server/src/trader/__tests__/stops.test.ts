/**
 * cancelStops when Robinhood refuses the cancel.
 *
 * In production every stop cancel answered 403 "Order cannot be cancelled at
 * this time", and the stored id was never cleared, so every later sell on that
 * contract failed. The stop's own state decides what a refused cancel means.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OptionContract } from '../../shared/types.js';
import { TraderEvents } from '../events.js';
import { sweepLadders } from '../ladderMonitor.js';
import { McpToolError, type RobinhoodMcpClient } from '../rh/mcpClient.js';
import type { McpRegistry } from '../rh/mcpRegistry.js';
import type { RobinhoodTools } from '../rh/tools.js';
import type { OptionOrder } from '../rh/types.js';
import { cancelStops, restMissingStops } from '../stops.js';
import { createFakeDb, fakeTokens, type FakeDb } from './fakeDb.js';

const USER = 'user-1';
const OPTION: OptionContract = { optionType: 'call', strike: 707, expiration: '2026-06-11' };

/** The error production saw, as withRetry hands it to cancelStops. */
const REFUSED_TEXT =
  'Tool cancel_option_order returned error: API error 403: {"detail":"Order cannot be cancelled at this time."}';
const refused = (): Error =>
  new Error(`cancel_option_order failed after 3 attempts: ${REFUSED_TEXT}`, {
    cause: new McpToolError(REFUSED_TEXT),
  });

function seedLot(
  db: FakeDb,
  lotId: string,
  at: string,
  quantity: number,
  stopOrderId: string | null
): void {
  db.seedMessage({ messageId: lotId, sentAt: at, authorId: 'caller-1' });
  db.seedDecision(USER, {
    at,
    messageId: lotId,
    kind: 'submitted',
    code: null,
    reason: 'filled',
    ticker: 'QQQ',
    action: 'buy',
    order: {
      symbol: 'QQQ',
      side: 'buy',
      assetType: 'option',
      quantity,
      orderType: 'limit',
      limitPrice: 1,
      option: OPTION,
      orderId: `buy-${lotId}`,
      status: 'filled',
      filledQuantity: quantity,
      averageFillPrice: 1,
      stopOrderId,
    },
  });
}

const stopOrder = (orderId: string, state: string | null, quantity = 2): OptionOrder => ({
  orderId,
  symbol: 'QQQ',
  ...OPTION,
  side: 'sell',
  state,
  averagePrice: null,
  quantity,
  createdAt: null,
  raw: {},
});

interface ToolStubs {
  readonly tools: RobinhoodTools;
  readonly cancel: ReturnType<typeof vi.fn>;
  readonly read: ReturnType<typeof vi.fn>;
}

/**
 * `refusedIds` are refused on cancel. `orders` is what the order read answers,
 * whatever id was asked for: picking the right row is cancelStops' job.
 */
function makeTools(refusedIds: readonly string[], orders: readonly OptionOrder[] | Error | null): ToolStubs {
  const cancel = vi.fn(async (orderId: string) => {
    if (refusedIds.includes(orderId)) throw refused();
  });
  const read = vi.fn(async (_orderId?: string) => {
    if (orders instanceof Error) throw orders;
    return orders === null ? null : { orders, raw: {} };
  });
  const tools = { cancelOptionOrder: cancel, getOptionOrders: read } as unknown as RobinhoodTools;
  return { tools, cancel, read };
}

async function stopIds(db: FakeDb): Promise<Record<string, string | null>> {
  const lots = await db.listOpenOptionLots(USER);
  return Object.fromEntries(lots.map((lot) => [lot.lotId, lot.stopOrderId]));
}

/** Parsed log lines written while `run` executes, from both streams. */
async function logged(run: () => Promise<unknown>): Promise<Record<string, unknown>[]> {
  const lines: Record<string, unknown>[] = [];
  const capture = (chunk: unknown): boolean => {
    try {
      lines.push(JSON.parse(String(chunk)) as Record<string, unknown>);
    } catch {
      // Not a log line.
    }
    return true;
  };
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(capture);
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(capture);
  try {
    await run().catch(() => undefined);
  } finally {
    err.mockRestore();
    out.mockRestore();
  }
  return lines;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('cancelStops — the cancel succeeds', () => {
  it('clears the stored id and never reads the order', async () => {
    const db = createFakeDb();
    seedLot(db, 'lot-a', '2026-06-11T13:00:00.000Z', 2, 'stop-a');
    const { tools, cancel, read } = makeTools([], []);

    await cancelStops(db, USER, tools, 'QQQ', OPTION);

    expect(cancel).toHaveBeenCalledExactlyOnceWith('stop-a');
    expect(read).not.toHaveBeenCalled();
    expect(await stopIds(db)).toEqual({ 'lot-a': null });
  });
});

describe('cancelStops — the cancel is refused', () => {
  it.each(['cancelled', 'canceled', 'rejected', 'failed', 'voided', 'CANCELLED'])(
    'clears the id and carries on when the stop is %s',
    async (state) => {
      const db = createFakeDb();
      seedLot(db, 'lot-a', '2026-06-11T13:00:00.000Z', 2, 'stop-a');
      const { tools, read } = makeTools(['stop-a'], [stopOrder('stop-a', state)]);

      await expect(cancelStops(db, USER, tools, 'QQQ', OPTION)).resolves.toBeUndefined();

      expect(read).toHaveBeenCalledExactlyOnceWith('stop-a');
      expect(await stopIds(db)).toEqual({ 'lot-a': null });
    }
  );

  it.each(['confirmed', 'queued', 'partially_filled', 'pending_cancelled', 'unconfirmed', 'some_new_state', null])(
    'keeps the id and rethrows the cancel error when the stop is %s',
    async (state) => {
      const db = createFakeDb();
      seedLot(db, 'lot-a', '2026-06-11T13:00:00.000Z', 2, 'stop-a');
      const { tools } = makeTools(['stop-a'], [stopOrder('stop-a', state)]);

      await expect(cancelStops(db, USER, tools, 'QQQ', OPTION)).rejects.toThrow(
        /^cancel_option_order failed after 3 attempts: .*Order cannot be cancelled at this time/
      );

      expect(await stopIds(db)).toEqual({ 'lot-a': 'stop-a' });
    }
  );

  it.each<[string, readonly OptionOrder[] | Error | null]>([
    ['the read fails', new Error('get_option_orders failed after 3 attempts: fetch failed')],
    ['the order is not listed', []],
    ['only other orders are listed', [stopOrder('someone-else', 'cancelled')]],
    ['the server has no order history tool', null],
  ])('keeps the id and rethrows the cancel error when %s', async (_label, orders) => {
    const db = createFakeDb();
    seedLot(db, 'lot-a', '2026-06-11T13:00:00.000Z', 2, 'stop-a');
    const { tools } = makeTools(['stop-a'], orders);

    await expect(cancelStops(db, USER, tools, 'QQQ', OPTION)).rejects.toThrow(
      /Order cannot be cancelled at this time/
    );

    expect(await stopIds(db)).toEqual({ 'lot-a': 'stop-a' });
  });

  it('clears both ids when the older stop is dead and the newer one cancels normally', async () => {
    const db = createFakeDb();
    seedLot(db, 'lot-old', '2026-06-11T13:00:00.000Z', 2, 'stop-old');
    seedLot(db, 'lot-new', '2026-06-11T14:00:00.000Z', 3, 'stop-new');
    const { tools, cancel, read } = makeTools(['stop-old'], [stopOrder('stop-old', 'cancelled')]);

    await cancelStops(db, USER, tools, 'QQQ', OPTION);

    expect(cancel.mock.calls.map((call) => call[0])).toEqual(['stop-old', 'stop-new']);
    expect(read).toHaveBeenCalledExactlyOnceWith('stop-old');
    expect(await stopIds(db)).toEqual({ 'lot-old': null, 'lot-new': null });
  });

  it('logs the lot, the order and its state next to the cancel error', async () => {
    const db = createFakeDb();
    seedLot(db, 'lot-a', '2026-06-11T13:00:00.000Z', 2, 'stop-a');
    const { tools } = makeTools(['stop-a'], [stopOrder('stop-a', 'confirmed')]);

    const lines = await logged(() => cancelStops(db, USER, tools, 'QQQ', OPTION));

    expect(lines).toContainEqual(
      expect.objectContaining({
        message: 'stop cancel failed',
        userId: USER,
        lotId: 'lot-a',
        orderId: 'stop-a',
        state: 'confirmed',
        error: expect.stringContaining('Order cannot be cancelled at this time'),
      })
    );
  });
});

describe('cancelStops — the refused stop had already filled', () => {
  it('closes the lot, clears the id, and fails the exit without touching later lots', async () => {
    const db = createFakeDb();
    seedLot(db, 'lot-old', '2026-06-11T13:00:00.000Z', 2, 'stop-old');
    seedLot(db, 'lot-new', '2026-06-11T14:00:00.000Z', 3, 'stop-new');
    const { tools, cancel } = makeTools(['stop-old'], [stopOrder('stop-old', 'filled', 2)]);

    await expect(cancelStops(db, USER, tools, 'QQQ', OPTION)).rejects.toThrow(/already filled/);

    // The newer lot keeps its working stop: no sell follows this failure.
    expect(cancel).toHaveBeenCalledExactlyOnceWith('stop-old');
    expect(await stopIds(db)).toEqual({ 'lot-new': 'stop-new' });
    const rows = await db.listDecisions(USER, 10);
    expect(rows.find((row) => row.messageId === 'stop:stop-old')).toMatchObject({
      kind: 'max_loss_exit',
      action: 'sell',
      ticker: 'QQQ',
      order: {
        side: 'sell',
        quantity: 2,
        orderId: 'stop-old',
        status: 'filled',
        filledQuantity: 2,
        lots: [{ lotId: 'lot-old', quantity: 2 }],
      },
    });
    expect(rows.find((row) => row.messageId === 'lot-old')?.order?.stopOrderId).toBeNull();
  });

  it('closes only what the stop sold when it covered part of the lot', async () => {
    const db = createFakeDb();
    seedLot(db, 'lot-a', '2026-06-11T13:00:00.000Z', 3, 'stop-a');
    const { tools } = makeTools(['stop-a'], [stopOrder('stop-a', 'filled', 1)]);

    await expect(cancelStops(db, USER, tools, 'QQQ', OPTION)).rejects.toThrow(/already filled/);

    const [lot] = await db.listOpenOptionLots(USER);
    expect(lot).toMatchObject({ lotId: 'lot-a', openQty: 2, stopOrderId: null });
  });

  it('is repeatable: the next exit on the contract goes through', async () => {
    const db = createFakeDb();
    seedLot(db, 'lot-old', '2026-06-11T13:00:00.000Z', 2, 'stop-old');
    seedLot(db, 'lot-new', '2026-06-11T14:00:00.000Z', 3, 'stop-new');
    const { tools } = makeTools(['stop-old'], [stopOrder('stop-old', 'filled', 2)]);
    await cancelStops(db, USER, tools, 'QQQ', OPTION).catch(() => undefined);

    await expect(cancelStops(db, USER, tools, 'QQQ', OPTION)).resolves.toBeUndefined();

    expect(await stopIds(db)).toEqual({ 'lot-new': null });
  });

  it('keeps the id and rethrows the cancel error when the fill carries no quantity', async () => {
    const db = createFakeDb();
    seedLot(db, 'lot-a', '2026-06-11T13:00:00.000Z', 2, 'stop-a');
    const { tools } = makeTools(['stop-a'], [stopOrder('stop-a', 'filled', 0)]);

    await expect(cancelStops(db, USER, tools, 'QQQ', OPTION)).rejects.toThrow(
      /Order cannot be cancelled at this time/
    );

    expect(await stopIds(db)).toEqual({ 'lot-a': 'stop-a' });
    expect(await db.listDecisions(USER, 10)).toHaveLength(1);
  });
});

describe('own-target ladder over a stop that had already filled', () => {
  it('places nothing on the sweep that finds it, then sells the surviving lot', async () => {
    const db = createFakeDb();
    db.seedBrokerTokens(USER, fakeTokens('token'));
    db.seedSettings(USER, { exitMode: 'ladder', trimLevels: [{ gainPct: 50, portionPct: 100 }] });
    seedLot(db, 'lot-old', '2026-06-11T13:00:00.000Z', 2, 'stop-old');
    seedLot(db, 'lot-new', '2026-06-11T14:00:00.000Z', 3, 'stop-new');
    const stubs = makeTools(['stop-old'], [stopOrder('stop-old', 'filled', 2)]);
    const place = vi.fn().mockResolvedValue({ orderId: 'sell-1', status: 'queued', raw: {} });
    const tools = {
      ...stubs.tools,
      getOptionsMarkPrice: vi.fn().mockResolvedValue({ markPrice: 1.6, raw: {} }),
      placeOptionsOrder: place,
    } as unknown as RobinhoodTools;
    const broker = {
      mcp: { ensureReady: vi.fn().mockResolvedValue(undefined) } as unknown as RobinhoodMcpClient,
      tools,
    };
    const brokers: McpRegistry = { for: () => broker, existing: () => broker, drop: () => undefined };
    const deps = { db, brokers, events: new TraderEvents(), executionMode: 'immediate' as const };

    expect(await sweepLadders(deps)).toBe(0);
    expect(place).not.toHaveBeenCalled();

    expect(await sweepLadders(deps)).toBe(1);
    expect(place).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ side: 'sell', contracts: 3, orderType: 'limit', limitPremium: 1.5 })
    );
    expect((await db.listDecisions(USER, 10)).find((row) => row.messageId === 'ladder:lot-new:50')?.order?.lots).toEqual([
      { lotId: 'lot-new', quantity: 3, gainPct: 50 },
    ]);
  });
});

describe('restMissingStops', () => {
  it('logs the status Robinhood returned for the placed stop', async () => {
    const db = createFakeDb();
    db.seedSettings(USER, { maxLossPct: 80 });
    seedLot(db, 'lot-a', '2026-06-11T13:00:00.000Z', 2, null);
    const tools = {
      placeOptionsOrder: vi.fn().mockResolvedValue({ orderId: 'stop-a', status: 'unconfirmed', raw: {} }),
    } as unknown as RobinhoodTools;

    const lines = await logged(() => restMissingStops({ userId: USER, db, tools, executionMode: 'immediate' }));

    expect(lines).toContainEqual(
      expect.objectContaining({ message: 'rested max-loss stop', orderId: 'stop-a', status: 'unconfirmed' })
    );
    expect(await stopIds(db)).toEqual({ 'lot-a': 'stop-a' });
  });
});
