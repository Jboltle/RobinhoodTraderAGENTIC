/**
 * cancelStops when the broker refuses the cancel.
 *
 * In production every stop cancel answered 403 "Order cannot be cancelled at
 * this time", and the stored id was never cleared, so every later sell on that
 * contract failed. The stop's own state decides what a refused cancel means.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TradeSettingsSchema, type OptionContract } from '../../shared/types.js';
import { brokerStops } from '../brokerStops.js';
import { createQuoteSource } from '../broker/quotes.js';
import type { Broker, BrokerOrder, BrokerPosition } from '../broker/types.js';
import { TraderEvents } from '../events.js';
import { sweepLadders } from '../ladderMonitor.js';
import { McpToolError, type RobinhoodMcpClient } from '../robinhood/mcpClient.js';
import { cancelStops, restMissingStops } from '../stops.js';
import { createFakeDb, fakeTokens, type FakeDb } from './fakeDb.js';
import { makeFakeBroker, makeFakeRegistry, optionPosition } from './harness.js';

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

/** `quantity` is what the stop filled, as Robinhood's `processed_quantity` reaches the port. */
const stopOrder = (orderId: string, state: string | null, quantity = 0): BrokerOrder => ({
  orderId,
  instrument: { kind: 'option', symbol: 'QQQ', ...OPTION },
  side: 'sell',
  status: state,
  fillPrice: null,
  quantity,
  filledQuantity: quantity,
  createdAt: null,
});

const held = (quantity: number): BrokerPosition =>
  optionPosition('QQQ', OPTION.optionType, OPTION.strike, OPTION.expiration, quantity);

interface BrokerStubs {
  readonly broker: Broker;
  readonly cancel: ReturnType<typeof vi.fn<Broker['cancelOrder']>>;
  readonly read: ReturnType<typeof vi.fn<Broker['getOrders']>>;
}

/**
 * `refusedIds` are refused on cancel. `orders` is what the order read answers,
 * whatever id was asked for: picking the right row is cancelStops' job.
 */
function makeBroker(refusedIds: readonly string[], orders: readonly BrokerOrder[] | Error | null): BrokerStubs {
  const cancel = vi.fn<Broker['cancelOrder']>(async (orderId) => {
    if (refusedIds.includes(orderId)) throw refused();
  });
  const read = vi.fn<Broker['getOrders']>(async () => {
    if (orders instanceof Error) throw orders;
    return orders;
  });
  return { broker: makeFakeBroker({ overrides: { cancelOrder: cancel, getOrders: read } }), cancel, read };
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

// Every describe below is the stop feature itself, so it runs switched on.
beforeEach(() => {
  brokerStops.enabled = true;
});

afterEach(() => {
  brokerStops.enabled = false;
  vi.restoreAllMocks();
});

describe('broker-side stops off (production)', () => {
  beforeEach(() => {
    brokerStops.enabled = false;
  });

  it('cancelStops does nothing: no cancel, no order read, no throw, the stored id stays', async () => {
    const db = createFakeDb();
    seedLot(db, 'lot-a', '2026-06-11T13:00:00.000Z', 2, 'stop-a');
    const { broker, cancel, read } = makeBroker(['stop-a'], [stopOrder('stop-a', 'confirmed')]);
    const ledger = vi.spyOn(db, 'listOpenOptionLots');

    await expect(cancelStops(db, USER, broker, 'QQQ', OPTION)).resolves.toBeUndefined();

    expect(cancel).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(ledger).not.toHaveBeenCalled();
    ledger.mockRestore();
    expect(await stopIds(db)).toEqual({ 'lot-a': 'stop-a' });
  });

  it('restMissingStops does nothing: no stop, no positions read, no session, no database read', async () => {
    const db = createFakeDb();
    db.seedSettings(USER, TradeSettingsSchema.parse({ maxLossPct: 80 }));
    seedLot(db, 'lot-a', '2026-06-11T13:00:00.000Z', 2, null);
    const broker = makeFakeBroker({ positions: [held(2)] });
    const { placeOrder: place, getPositions: read } = broker;
    const ensureReady = vi.fn();
    const settings = vi.spyOn(db, 'getSettings');
    const ledger = vi.spyOn(db, 'listOpenOptionLots');

    await restMissingStops({
      accountId: USER,
      db,
      broker,
      executionMode: 'immediate',
      now: new Date('2026-06-11T15:00:00.000Z'),
      ensureReady,
    });

    expect(place).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(ensureReady).not.toHaveBeenCalled();
    expect(settings).not.toHaveBeenCalled();
    expect(ledger).not.toHaveBeenCalled();
  });
});

describe('cancelStops — the cancel succeeds', () => {
  it('clears the stored id and never reads the order', async () => {
    const db = createFakeDb();
    seedLot(db, 'lot-a', '2026-06-11T13:00:00.000Z', 2, 'stop-a');
    const { broker, cancel, read } = makeBroker([], []);

    await cancelStops(db, USER, broker, 'QQQ', OPTION);

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
      const { broker, read } = makeBroker(['stop-a'], [stopOrder('stop-a', state)]);

      await expect(cancelStops(db, USER, broker, 'QQQ', OPTION)).resolves.toBeUndefined();

      expect(read).toHaveBeenCalledExactlyOnceWith('stop-a');
      expect(await stopIds(db)).toEqual({ 'lot-a': null });
    }
  );

  it.each(['confirmed', 'queued', 'partially_filled', 'pending_cancelled', 'unconfirmed', 'expired', 'some_new_state', null])(
    'keeps the id and rethrows the cancel error when the stop is %s',
    async (state) => {
      const db = createFakeDb();
      seedLot(db, 'lot-a', '2026-06-11T13:00:00.000Z', 2, 'stop-a');
      const { broker } = makeBroker(['stop-a'], [stopOrder('stop-a', state)]);

      await expect(cancelStops(db, USER, broker, 'QQQ', OPTION)).rejects.toThrow(
        /^cancel_option_order failed after 3 attempts: .*Order cannot be cancelled at this time/
      );

      expect(await stopIds(db)).toEqual({ 'lot-a': 'stop-a' });
    }
  );

  it.each<[string, readonly BrokerOrder[] | Error | null]>([
    ['the read fails', new Error('get_option_orders failed after 3 attempts: fetch failed')],
    ['the order is not listed', []],
    ['only other orders are listed', [stopOrder('someone-else', 'cancelled')]],
    ['the broker offers no order history', null],
  ])('keeps the id and rethrows the cancel error when %s', async (_label, orders) => {
    const db = createFakeDb();
    seedLot(db, 'lot-a', '2026-06-11T13:00:00.000Z', 2, 'stop-a');
    const { broker } = makeBroker(['stop-a'], orders);

    await expect(cancelStops(db, USER, broker, 'QQQ', OPTION)).rejects.toThrow(
      /Order cannot be cancelled at this time/
    );

    expect(await stopIds(db)).toEqual({ 'lot-a': 'stop-a' });
  });

  it.each(['cancelled', 'rejected', 'failed', 'voided'])(
    'keeps the id and rethrows when a %s stop had sold part of the lot first',
    async (state) => {
      const db = createFakeDb();
      seedLot(db, 'lot-a', '2026-06-11T13:00:00.000Z', 3, 'stop-a');
      const { broker } = makeBroker(['stop-a'], [stopOrder('stop-a', state, 2)]);

      await expect(cancelStops(db, USER, broker, 'QQQ', OPTION)).rejects.toThrow(
        /^cancel_option_order failed after 3 attempts: .*Order cannot be cancelled at this time/
      );

      expect(await stopIds(db)).toEqual({ 'lot-a': 'stop-a' });
      expect(await db.listDecisions(USER, 10)).toHaveLength(1);
    }
  );

  it('clears the id of a dead stop whose row carries no filled quantity', async () => {
    const db = createFakeDb();
    seedLot(db, 'lot-a', '2026-06-11T13:00:00.000Z', 3, 'stop-a');
    const { filledQuantity: _absent, ...row } = stopOrder('stop-a', 'cancelled', 3);
    const { broker } = makeBroker(['stop-a'], [row]);

    await expect(cancelStops(db, USER, broker, 'QQQ', OPTION)).resolves.toBeUndefined();

    expect(await stopIds(db)).toEqual({ 'lot-a': null });
  });

  it('clears both ids when the older stop is dead and the newer one cancels normally', async () => {
    const db = createFakeDb();
    seedLot(db, 'lot-old', '2026-06-11T13:00:00.000Z', 2, 'stop-old');
    seedLot(db, 'lot-new', '2026-06-11T14:00:00.000Z', 3, 'stop-new');
    const { broker, cancel, read } = makeBroker(['stop-old'], [stopOrder('stop-old', 'cancelled')]);

    await cancelStops(db, USER, broker, 'QQQ', OPTION);

    expect(cancel.mock.calls.map((call) => call[0])).toEqual(['stop-old', 'stop-new']);
    expect(read).toHaveBeenCalledExactlyOnceWith('stop-old');
    expect(await stopIds(db)).toEqual({ 'lot-old': null, 'lot-new': null });
  });

  it('logs the lot, the order and its state next to the cancel error', async () => {
    const db = createFakeDb();
    seedLot(db, 'lot-a', '2026-06-11T13:00:00.000Z', 2, 'stop-a');
    const { broker } = makeBroker(['stop-a'], [stopOrder('stop-a', 'confirmed')]);

    const lines = await logged(() => cancelStops(db, USER, broker, 'QQQ', OPTION));

    expect(lines).toContainEqual(
      expect.objectContaining({
        message: 'stop cancel failed',
        accountId: USER,
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
    const { broker, cancel } = makeBroker(['stop-old'], [stopOrder('stop-old', 'filled', 2)]);

    await expect(cancelStops(db, USER, broker, 'QQQ', OPTION)).rejects.toThrow(/already filled/);

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
    const { broker } = makeBroker(['stop-a'], [stopOrder('stop-a', 'filled', 1)]);

    await expect(cancelStops(db, USER, broker, 'QQQ', OPTION)).rejects.toThrow(/already filled/);

    const [lot] = await db.listOpenOptionLots(USER);
    expect(lot).toMatchObject({ lotId: 'lot-a', openQty: 2, stopOrderId: null });
  });

  it('is repeatable: the next exit on the contract goes through', async () => {
    const db = createFakeDb();
    seedLot(db, 'lot-old', '2026-06-11T13:00:00.000Z', 2, 'stop-old');
    seedLot(db, 'lot-new', '2026-06-11T14:00:00.000Z', 3, 'stop-new');
    const { broker } = makeBroker(['stop-old'], [stopOrder('stop-old', 'filled', 2)]);
    await cancelStops(db, USER, broker, 'QQQ', OPTION).catch(() => undefined);

    await expect(cancelStops(db, USER, broker, 'QQQ', OPTION)).resolves.toBeUndefined();

    expect(await stopIds(db)).toEqual({ 'lot-new': null });
  });

  it('keeps the id and rethrows the cancel error when the fill carries no quantity', async () => {
    const db = createFakeDb();
    seedLot(db, 'lot-a', '2026-06-11T13:00:00.000Z', 2, 'stop-a');
    const { broker } = makeBroker(['stop-a'], [stopOrder('stop-a', 'filled', 0)]);

    await expect(cancelStops(db, USER, broker, 'QQQ', OPTION)).rejects.toThrow(
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
    db.seedSettings(
      USER,
      TradeSettingsSchema.parse({ exitMode: 'ladder', trimLevels: [{ gainPct: 50, portionPct: 100 }] })
    );
    seedLot(db, 'lot-old', '2026-06-11T13:00:00.000Z', 2, 'stop-old');
    seedLot(db, 'lot-new', '2026-06-11T14:00:00.000Z', 3, 'stop-new');
    const stubs = makeBroker(['stop-old'], [stopOrder('stop-old', 'filled', 2)]);
    const place = vi.fn<Broker['placeOrder']>().mockResolvedValue({ orderId: 'sell-1', status: 'queued' });
    const broker = makeFakeBroker({
      optionMark: 1.6,
      // The older lot's contracts are gone: its stop sold them.
      positions: [held(3)],
      overrides: { cancelOrder: stubs.cancel, getOrders: stubs.read, placeOrder: place },
    });
    const session = { ensureReady: vi.fn().mockResolvedValue(undefined) } as unknown as RobinhoodMcpClient;
    const brokers = makeFakeRegistry(() => ({ session, broker }));
    const deps = {
      db,
      brokers,
      quotes: createQuoteSource({ db, brokers }),
      events: new TraderEvents(),
      executionMode: 'immediate' as const,
    };

    expect(await sweepLadders(deps)).toBe(0);
    expect(place).not.toHaveBeenCalled();

    expect(await sweepLadders(deps)).toBe(1);
    expect(place).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ side: 'sell', quantity: 3, type: 'limit', limitPrice: 1.5 })
    );
    expect((await db.listDecisions(USER, 10)).find((row) => row.messageId.startsWith('ladder:lot-new:50:'))?.order?.lots).toEqual([
      { lotId: 'lot-new', quantity: 3, gainPct: 50 },
    ]);
  });
});

describe('restMissingStops', () => {
  function restSetup(positions: readonly BrokerPosition[] | Error): {
    db: FakeDb;
    broker: Broker;
    place: ReturnType<typeof vi.fn<Broker['placeOrder']>>;
    read: ReturnType<typeof vi.fn<Broker['getPositions']>>;
  } {
    const db = createFakeDb();
    db.seedSettings(USER, TradeSettingsSchema.parse({ maxLossPct: 80 }));
    let stops = 0;
    const place = vi.fn<Broker['placeOrder']>(async () => ({ orderId: `stop-${(stops += 1)}`, status: 'unconfirmed' }));
    const read = vi.fn<Broker['getPositions']>(async () => {
      if (positions instanceof Error) throw positions;
      return positions;
    });
    return { db, broker: makeFakeBroker({ overrides: { placeOrder: place, getPositions: read } }), place, read };
  }
  /** The contract's expiration day, mid-session in New York. */
  const EXPIRATION_DAY = new Date('2026-06-11T15:00:00.000Z');
  const rest = (db: FakeDb, broker: Broker, now: Date = EXPIRATION_DAY): Promise<void> =>
    restMissingStops({ accountId: USER, db, broker, executionMode: 'immediate', now });

  it('logs the status the broker returned for the placed stop', async () => {
    const { db, broker } = restSetup([held(2)]);
    seedLot(db, 'lot-a', '2026-06-11T13:00:00.000Z', 2, null);

    const lines = await logged(() => rest(db, broker));

    expect(lines).toContainEqual(
      expect.objectContaining({ message: 'rested max-loss stop', orderId: 'stop-1', status: 'unconfirmed' })
    );
    expect(await stopIds(db)).toEqual({ 'lot-a': 'stop-1' });
  });

  it('reads positions once, and not at all when no lot needs a stop', async () => {
    const { db, broker, place, read } = restSetup([held(5)]);
    seedLot(db, 'lot-a', '2026-06-11T13:00:00.000Z', 2, null);
    seedLot(db, 'lot-b', '2026-06-11T14:00:00.000Z', 3, null);

    await rest(db, broker);
    expect(read).toHaveBeenCalledOnce();
    expect(place).toHaveBeenCalledTimes(2);

    await rest(db, broker);
    expect(read).toHaveBeenCalledOnce();
    expect(place).toHaveBeenCalledTimes(2);
  });

  it('rests no stop on a lot the account does not hold', async () => {
    const { db, broker, place } = restSetup([]);
    seedLot(db, 'lot-a', '2026-06-11T13:00:00.000Z', 2, null);

    await rest(db, broker);

    expect(place).not.toHaveBeenCalled();
    expect(await stopIds(db)).toEqual({ 'lot-a': null });
  });

  it('caps the stop to what the account holds', async () => {
    const { db, broker, place } = restSetup([held(1)]);
    seedLot(db, 'lot-a', '2026-06-11T13:00:00.000Z', 3, null);

    await rest(db, broker);

    expect(place).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'stop', quantity: 1 }));
  });

  it('gives a short position to the newest lot, never more than held in total', async () => {
    const { db, broker, place } = restSetup([held(3)]);
    seedLot(db, 'lot-stale', '2026-06-10T13:00:00.000Z', 2, null);
    seedLot(db, 'lot-new', '2026-06-11T14:00:00.000Z', 3, null);

    await rest(db, broker);

    expect(place).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ quantity: 3 }));
    expect(await stopIds(db)).toEqual({ 'lot-stale': null, 'lot-new': 'stop-1' });
  });

  it('rests no stop and reads no positions for a lot on an expired contract', async () => {
    const { db, broker, place, read } = restSetup([held(2)]);
    seedLot(db, 'lot-a', '2026-06-11T13:00:00.000Z', 2, null);

    // 03:59 UTC on the 12th is still the 11th in New York.
    await rest(db, broker, new Date('2026-06-12T04:01:00.000Z'));

    expect(read).not.toHaveBeenCalled();
    expect(place).not.toHaveBeenCalled();
    expect(await stopIds(db)).toEqual({ 'lot-a': null });

    await rest(db, broker, new Date('2026-06-12T03:59:00.000Z'));
    expect(place).toHaveBeenCalledOnce();
  });

  it('readies the session only when a lot needs a stop', async () => {
    const { db, broker } = restSetup([held(2)]);
    const ensureReady = vi.fn().mockResolvedValue(undefined);
    const run = (): Promise<void> =>
      restMissingStops({ accountId: USER, db, broker, executionMode: 'immediate', now: EXPIRATION_DAY, ensureReady });

    await run();
    expect(ensureReady).not.toHaveBeenCalled();

    seedLot(db, 'lot-a', '2026-06-11T13:00:00.000Z', 2, null);
    await run();
    expect(ensureReady).toHaveBeenCalledOnce();
  });

  it('rests nothing when the positions read fails', async () => {
    const { db, broker, place } = restSetup(new Error('get_option_positions failed after 3 attempts: fetch failed'));
    seedLot(db, 'lot-a', '2026-06-11T13:00:00.000Z', 2, null);

    await expect(rest(db, broker)).rejects.toThrow(/get_option_positions failed/);

    expect(place).not.toHaveBeenCalled();
    expect(await stopIds(db)).toEqual({ 'lot-a': null });
  });
});
