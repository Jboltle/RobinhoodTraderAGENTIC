/**
 * Own-target ladder sweeps: a level is sold once while its sell lives, again
 * when that sell died, and never for contracts the account does not hold.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TradeSettingsSchema, type Decision, type OptionContract, type TradeSettings } from '../../shared/types.js';
import { brokerStops } from '../brokerStops.js';
import type { Broker, BrokerOrder, BrokerPosition, Instrument } from '../broker/types.js';
import { TraderEvents } from '../events.js';
import {
  LADDER_INTERVAL_MS,
  MAX_LADDER_PLACEMENTS_PER_DAY,
  startLadderMonitor,
  sweepLadders,
  type LadderDeps,
} from '../ladderMonitor.js';
import { startOfDay } from '../pipeline/riskFilter.js';
import type { RobinhoodMcpClient } from '../robinhood/mcpClient.js';
import { createFakeDb, fakeTokens, type FakeDb } from './fakeDb.js';
import { makeFakeBroker, makeFakeRegistry, optionPosition } from './harness.js';

const USER = 'user-1';
const OPTION: OptionContract = { optionType: 'call', strike: 707, expiration: '2026-06-11' };
const SWEEP_GAP_MS = 15_000;

const QQQ_CALL: Instrument = { kind: 'option', symbol: 'QQQ', ...OPTION };

const held = (quantity: number): BrokerPosition =>
  optionPosition('QQQ', OPTION.optionType, OPTION.strike, OPTION.expiration, quantity);

function seedLot(db: FakeDb, lotId: string, at: string, quantity: number, stopOrderId: string | null = null): void {
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

interface Setup {
  readonly db: FakeDb;
  readonly deps: LadderDeps;
  readonly place: ReturnType<typeof vi.fn<Broker['placeOrder']>>;
  readonly cancel: ReturnType<typeof vi.fn<Broker['cancelOrder']>>;
  readonly positions: ReturnType<typeof vi.fn<Broker['getPositions']>>;
}

function setup(opts: {
  readonly trimLevels: TradeSettings['trimLevels'];
  readonly positions: readonly BrokerPosition[] | Error;
  readonly mark?: number;
  readonly overrides?: Partial<Broker>;
}): Setup {
  const db = createFakeDb();
  db.seedBrokerTokens(USER, fakeTokens('token'));
  db.seedSettings(USER, TradeSettingsSchema.parse({ exitMode: 'ladder', trimLevels: opts.trimLevels }));
  let sells = 0;
  const place = vi.fn<Broker['placeOrder']>(async () => ({ orderId: `sell-${(sells += 1)}`, status: 'queued' }));
  const cancel = vi.fn<Broker['cancelOrder']>(async () => undefined);
  const positions = vi.fn<Broker['getPositions']>(async () => {
    if (opts.positions instanceof Error) throw opts.positions;
    return opts.positions;
  });
  const broker = makeFakeBroker({
    optionMark: opts.mark ?? 1.3,
    overrides: { getPositions: positions, placeOrder: place, cancelOrder: cancel, ...opts.overrides },
  });
  const session = { ensureReady: vi.fn().mockResolvedValue(undefined) } as unknown as RobinhoodMcpClient;
  const brokers = makeFakeRegistry(() => ({ session, broker }));
  return {
    db,
    deps: { db, brokers, events: new TraderEvents(), executionMode: 'immediate' },
    place,
    cancel,
    positions,
  };
}

/** A sweep, one ladder interval after the previous one. */
async function sweep(deps: LadderDeps): Promise<number> {
  vi.advanceTimersByTime(SWEEP_GAP_MS);
  return sweepLadders(deps);
}

async function ladderRows(db: FakeDb): Promise<Decision[]> {
  return (await db.listDecisions(USER, 50)).filter((row) => row.messageId.startsWith('ladder:'));
}

/** Parsed log lines written while `run` executes. */
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
    await run();
  } finally {
    err.mockRestore();
    out.mockRestore();
  }
  return lines;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-06-11T15:00:00.000Z') });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const FIRST_QUARTER = [
  { gainPct: 25, portionPct: 25 },
  { gainPct: 100, portionPct: 75 },
];

describe('ladder — one sell per level', () => {
  it('does not place a level again while its sell is working', async () => {
    const { db, deps, place } = setup({ trimLevels: FIRST_QUARTER, positions: [held(4)] });
    seedLot(db, 'lot-a', '2026-06-11T13:00:00.000Z', 4);

    expect(await sweep(deps)).toBe(1);
    expect(await sweep(deps)).toBe(0);
    expect(await sweep(deps)).toBe(0);

    expect(place).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ side: 'sell', quantity: 1 }));
    expect(await ladderRows(db)).toHaveLength(1);
  });

  it('does not place a level again once its sell filled', async () => {
    const { db, deps, place } = setup({ trimLevels: FIRST_QUARTER, positions: [held(4)] });
    seedLot(db, 'lot-a', '2026-06-11T13:00:00.000Z', 4);
    await sweep(deps);
    const [first] = await ladderRows(db);
    await db.updateOrder(USER, first!.messageId, { ...first!.order!, status: 'filled', filledQuantity: 1 });

    expect(await sweep(deps)).toBe(0);

    expect(place).toHaveBeenCalledOnce();
  });

  it('places a level again exactly once after its sell died, and records every placement', async () => {
    const { db, deps, place } = setup({ trimLevels: FIRST_QUARTER, positions: [held(4)] });
    seedLot(db, 'lot-a', '2026-06-11T13:00:00.000Z', 4);
    await sweep(deps);
    const [first] = await ladderRows(db);
    await db.updateOrder(USER, first!.messageId, { ...first!.order!, status: 'cancelled' });

    expect(await sweep(deps)).toBe(1);
    expect(await sweep(deps)).toBe(0);
    expect(await sweep(deps)).toBe(0);

    expect(place).toHaveBeenCalledTimes(2);
    const rows = await ladderRows(db);
    expect(rows.map((row) => row.order?.status).sort()).toEqual(['cancelled', 'queued']);
    expect(new Set(rows.map((row) => row.messageId)).size).toBe(2);
    expect(rows.every((row) => row.messageId.startsWith('ladder:lot-a:25:'))).toBe(true);
    const [lot] = await db.listOpenOptionLots(USER);
    expect(lot).toMatchObject({ openQty: 3, soldAtGain: { 25: 1 } });
  });
});

describe('ladder — one level per lot per sweep', () => {
  it('sells one level per sweep when the mark is past two targets', async () => {
    const { db, deps, place } = setup({ trimLevels: FIRST_QUARTER, positions: [held(4)], mark: 2.5 });
    seedLot(db, 'lot-a', '2026-06-11T13:00:00.000Z', 4);

    expect(await sweep(deps)).toBe(1);
    expect(place).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ quantity: 1, limitPrice: 1.25 }));

    expect(await sweep(deps)).toBe(1);
    expect(place).toHaveBeenLastCalledWith(expect.objectContaining({ quantity: 3, limitPrice: 2 }));
    expect(place).toHaveBeenCalledTimes(2);
  });
});

describe('ladder — a level whose sells keep dying', () => {
  const SWEEPS = 12;
  const boundLines = (lines: Record<string, unknown>[], lotId: string): Record<string, unknown>[] =>
    lines.filter((line) => line.lotId === lotId && String(line.message).includes('left alone'));

  it('stops placing a level once its sells were rejected the daily maximum of times', async () => {
    let sells = 0;
    const place = vi.fn<Broker['placeOrder']>(async () => ({ orderId: `sell-${(sells += 1)}`, status: 'rejected' }));
    const { db, deps } = setup({
      trimLevels: FIRST_QUARTER,
      positions: [held(4)],
      overrides: { placeOrder: place },
    });
    seedLot(db, 'lot-rejected', '2026-06-11T13:00:00.000Z', 4);

    const lines = await logged(async () => {
      for (let i = 0; i < SWEEPS; i += 1) await sweep(deps);
    });

    expect(place).toHaveBeenCalledTimes(MAX_LADDER_PLACEMENTS_PER_DAY);
    expect(await ladderRows(db)).toHaveLength(MAX_LADDER_PLACEMENTS_PER_DAY);
    // The buy and the placements, nothing more: the daily trade cap is not used up.
    expect(await db.countSubmittedSince(USER, startOfDay())).toBe(1 + MAX_LADDER_PLACEMENTS_PER_DAY);
    expect(boundLines(lines, 'lot-rejected')).toHaveLength(1);
    expect(boundLines(lines, 'lot-rejected')[0]).toMatchObject({ level: 'warn', gainPct: 25 });
  });

  it('counts a submit that throws, records it as failed, and keeps it out of the daily trade cap', async () => {
    const place = vi.fn<Broker['placeOrder']>().mockRejectedValue(new Error('place_option_order failed after 3 attempts: fetch failed'));
    const { db, deps, positions } = setup({
      trimLevels: FIRST_QUARTER,
      positions: [held(4)],
      overrides: { placeOrder: place },
    });
    seedLot(db, 'lot-throws', '2026-06-11T13:00:00.000Z', 4);

    for (let i = 0; i < SWEEPS; i += 1) expect(await sweep(deps)).toBe(0);

    expect(place).toHaveBeenCalledTimes(MAX_LADDER_PLACEMENTS_PER_DAY);
    const rows = await ladderRows(db);
    expect(rows).toHaveLength(MAX_LADDER_PLACEMENTS_PER_DAY);
    for (const row of rows) {
      expect(row).toMatchObject({ kind: 'execution_failed', action: 'sell', order: { status: 'failed' } });
      expect(row.reason).toContain('fetch failed');
    }
    expect(await db.countSubmittedSince(USER, startOfDay())).toBe(1);
    expect((await db.listOpenOptionLots(USER))[0]).toMatchObject({ openQty: 4, soldAtGain: {} });
    // A level that is left alone costs no positions read either.
    expect(positions).toHaveBeenCalledTimes(MAX_LADDER_PLACEMENTS_PER_DAY);
  });

  it('counts each level on its own: the next level is still sold', async () => {
    let sells = 0;
    let markPrice = 1.3;
    const place = vi.fn<Broker['placeOrder']>(async () => ({ orderId: `sell-${(sells += 1)}`, status: 'rejected' }));
    const { db, deps } = setup({
      trimLevels: FIRST_QUARTER,
      positions: [held(4)],
      overrides: { placeOrder: place, getMark: async () => markPrice },
    });
    seedLot(db, 'lot-two-levels', '2026-06-11T13:00:00.000Z', 4);
    for (let i = 0; i < SWEEPS; i += 1) await sweep(deps);
    expect(place).toHaveBeenCalledTimes(MAX_LADDER_PLACEMENTS_PER_DAY);

    markPrice = 2.5;
    await sweep(deps);

    expect(place).toHaveBeenLastCalledWith(expect.objectContaining({ quantity: 3, limitPrice: 2 }));
    expect(place).toHaveBeenCalledTimes(MAX_LADDER_PLACEMENTS_PER_DAY + 1);
  });

  it('places the level again the next day', async () => {
    let sells = 0;
    const place = vi.fn<Broker['placeOrder']>(async () => ({ orderId: `sell-${(sells += 1)}`, status: 'rejected' }));
    const { db, deps } = setup({
      trimLevels: FIRST_QUARTER,
      positions: [held(4)],
      overrides: { placeOrder: place },
    });
    seedLot(db, 'lot-next-day', '2026-06-11T13:00:00.000Z', 4);
    for (let i = 0; i < SWEEPS; i += 1) await sweep(deps);
    expect(place).toHaveBeenCalledTimes(MAX_LADDER_PLACEMENTS_PER_DAY);

    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    await sweep(deps);

    expect(place).toHaveBeenCalledTimes(MAX_LADDER_PLACEMENTS_PER_DAY + 1);
  });
});

describe('ladder — only contracts the account holds', () => {
  const ALL_AT_25 = [{ gainPct: 25, portionPct: 100 }];

  it('reads no positions on a sweep with no level due', async () => {
    const { db, deps, positions, place } = setup({ trimLevels: ALL_AT_25, positions: [held(4)], mark: 1.1 });
    seedLot(db, 'lot-a', '2026-06-11T13:00:00.000Z', 4);

    expect(await sweep(deps)).toBe(0);

    expect(positions).not.toHaveBeenCalled();
    expect(place).not.toHaveBeenCalled();
  });

  it('reads positions once per sweep, however many lots are due', async () => {
    const { db, deps, positions, place } = setup({ trimLevels: ALL_AT_25, positions: [held(5)] });
    seedLot(db, 'lot-a', '2026-06-11T13:00:00.000Z', 2);
    seedLot(db, 'lot-b', '2026-06-11T14:00:00.000Z', 3);

    expect(await sweep(deps)).toBe(2);

    expect(positions).toHaveBeenCalledOnce();
    expect(place).toHaveBeenCalledTimes(2);
  });

  it('skips a lot the account no longer holds: no cancel, no sell, one log line', async () => {
    const { db, deps, place, cancel } = setup({ trimLevels: ALL_AT_25, positions: [] });
    seedLot(db, 'lot-gone', '2026-06-11T13:00:00.000Z', 4, 'stop-a');

    const lines = await logged(async () => {
      expect(await sweep(deps)).toBe(0);
      expect(await sweep(deps)).toBe(0);
      expect(await sweep(deps)).toBe(0);
    });

    expect(cancel).not.toHaveBeenCalled();
    expect(place).not.toHaveBeenCalled();
    expect((await db.listOpenOptionLots(USER))[0]?.stopOrderId).toBe('stop-a');
    expect(lines.filter((line) => line.lotId === 'lot-gone')).toHaveLength(1);
  });

  it('caps the sell to what the account holds', async () => {
    const { db, deps, place } = setup({ trimLevels: ALL_AT_25, positions: [held(1)] });
    seedLot(db, 'lot-a', '2026-06-11T13:00:00.000Z', 4);

    expect(await sweep(deps)).toBe(1);

    expect(place).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ quantity: 1 }));
    expect((await ladderRows(db))[0]?.order).toMatchObject({
      quantity: 1,
      lots: [{ lotId: 'lot-a', quantity: 1, gainPct: 25 }],
    });
  });

  it('gives a short position to the newest lot, so a stale older lot sells nothing', async () => {
    const { db, deps, place } = setup({ trimLevels: ALL_AT_25, positions: [held(3)] });
    seedLot(db, 'lot-stale', '2026-06-10T13:00:00.000Z', 2);
    seedLot(db, 'lot-new', '2026-06-11T14:00:00.000Z', 3);

    expect(await sweep(deps)).toBe(1);

    expect(place).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ quantity: 3 }));
    expect((await ladderRows(db))[0]?.order?.lots).toEqual([{ lotId: 'lot-new', quantity: 3, gainPct: 25 }]);
  });

  it('does nothing when the positions read fails', async () => {
    const { db, deps, place, cancel } = setup({
      trimLevels: ALL_AT_25,
      positions: new Error('get_option_positions failed after 3 attempts: fetch failed'),
    });
    seedLot(db, 'lot-a', '2026-06-11T13:00:00.000Z', 4, 'stop-a');

    const lines = await logged(async () => {
      expect(await sweep(deps)).toBe(0);
    });

    expect(cancel).not.toHaveBeenCalled();
    expect(place).not.toHaveBeenCalled();
    expect(await ladderRows(db)).toHaveLength(0);
    // The failure ends the account's sweep; it is not read as "holds nothing".
    expect(lines).toContainEqual(
      expect.objectContaining({
        message: 'ladder sweep skipped account',
        error: expect.stringContaining('get_option_positions failed'),
      })
    );
  });
});

describe('ladder — over a stop the broker refuses to cancel', () => {
  beforeEach(() => {
    brokerStops.enabled = true;
  });
  afterEach(() => {
    brokerStops.enabled = false;
  });

  it('with broker-side stops off: sells the level with no cancel attempt and leaves the stored id', async () => {
    brokerStops.enabled = false;
    const cancel = vi.fn<Broker['cancelOrder']>().mockRejectedValue(new Error('API error 403: Order cannot be cancelled at this time.'));
    const read = vi.fn<Broker['getOrders']>();
    const { db, deps, place } = setup({
      trimLevels: [{ gainPct: 25, portionPct: 100 }],
      positions: [held(2)],
      overrides: { cancelOrder: cancel, getOrders: read },
    });
    seedLot(db, 'lot-off', '2026-06-11T13:00:00.000Z', 2, 'stop-a');

    expect(await sweep(deps)).toBe(1);

    expect(place).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ side: 'sell', quantity: 2, type: 'limit', limitPrice: 1.25 })
    );
    expect(cancel).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(await ladderRows(db)).toHaveLength(1);
    expect((await db.listDecisions(USER, 10)).find((row) => row.messageId === 'lot-off')?.order?.stopOrderId).toBe(
      'stop-a'
    );
  });

  // The same two cases run with stops off in "only contracts the account
  // holds"; there a cancel can never happen, so they are pinned here too.
  it('does not cancel the stop of a lot the account no longer holds', async () => {
    const { db, deps, place, cancel } = setup({ trimLevels: [{ gainPct: 25, portionPct: 100 }], positions: [] });
    seedLot(db, 'lot-gone-stopped', '2026-06-11T13:00:00.000Z', 4, 'stop-a');

    expect(await sweep(deps)).toBe(0);

    expect(cancel).not.toHaveBeenCalled();
    expect(place).not.toHaveBeenCalled();
    expect((await db.listOpenOptionLots(USER))[0]?.stopOrderId).toBe('stop-a');
  });

  it('does not cancel the stop when the positions read fails', async () => {
    const { db, deps, place, cancel } = setup({
      trimLevels: [{ gainPct: 25, portionPct: 100 }],
      positions: new Error('get_option_positions failed after 3 attempts: fetch failed'),
    });
    seedLot(db, 'lot-a', '2026-06-11T13:00:00.000Z', 4, 'stop-a');

    expect(await sweep(deps)).toBe(0);

    expect(cancel).not.toHaveBeenCalled();
    expect(place).not.toHaveBeenCalled();
  });

  it('sells and records the level when the refused stop is dead', async () => {
    const refused = new Error(
      'cancel_option_order failed after 3 attempts: Tool cancel_option_order returned error: ' +
        'API error 403: {"detail":"Order cannot be cancelled at this time."}'
    );
    const { db, deps, place } = setup({
      trimLevels: [{ gainPct: 25, portionPct: 100 }],
      positions: [held(2)],
      overrides: {
        cancelOrder: vi.fn<Broker['cancelOrder']>().mockRejectedValue(refused),
        getOrders: vi.fn<Broker['getOrders']>().mockResolvedValue([DEAD_STOP]),
      },
    });
    seedLot(db, 'lot-a', '2026-06-11T13:00:00.000Z', 2, 'stop-a');

    expect(await sweep(deps)).toBe(1);

    expect(place).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ side: 'sell', quantity: 2, type: 'limit', limitPrice: 1.25 })
    );
    expect(await ladderRows(db)).toHaveLength(1);
    expect((await db.listDecisions(USER, 10)).find((row) => row.messageId === 'lot-a')?.order?.stopOrderId).toBeNull();
  });
});

/** The lot's stop as the broker lists it after refusing its cancel: dead, nothing filled. */
const DEAD_STOP: BrokerOrder = {
  orderId: 'stop-a',
  instrument: QQQ_CALL,
  side: 'sell',
  status: 'cancelled',
  fillPrice: null,
  quantity: 0,
  filledQuantity: 0,
  createdAt: null,
};

describe('ladder monitor — overlapping ticks', () => {
  const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  it('skips a tick while the previous sweep is still running', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], now: new Date('2026-06-11T15:00:00.000Z') });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mark = vi.fn<Broker['getMark']>(async () => {
      await gate;
      return 1.3;
    });
    const { db, deps, place } = setup({
      trimLevels: FIRST_QUARTER,
      positions: [held(4)],
      overrides: { getMark: mark },
    });
    seedLot(db, 'lot-a', '2026-06-11T13:00:00.000Z', 4);
    const stop = startLadderMonitor(deps);

    vi.advanceTimersByTime(LADDER_INTERVAL_MS);
    await settle();
    vi.advanceTimersByTime(LADDER_INTERVAL_MS);
    await settle();
    release();
    await settle();

    expect(mark).toHaveBeenCalledOnce();
    expect(place).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ quantity: 1 }));

    // The guard clears with the sweep: the next tick runs.
    vi.advanceTimersByTime(LADDER_INTERVAL_MS);
    await settle();
    expect(mark).toHaveBeenCalledTimes(2);
    stop();
  });
});

describe('ladder — what a placement asks of the broker and records', () => {
  /** Half the lot at +50%, the other half at +100%. */
  const HALVES = [
    { gainPct: 50, portionPct: 50 },
    { gainPct: 100, portionPct: 50 },
  ];
  /** Past the first target, short of the second. */
  const MARK = 1.6;

  it("a target hit places a limit sell at the target price for that level's contracts", async () => {
    const { db, deps, place, cancel } = setup({ trimLevels: HALVES, positions: [held(4)], mark: MARK });
    seedLot(db, 'lot-a', '2026-06-11T13:00:00.000Z', 4);

    expect(await sweep(deps)).toBe(1);

    expect(place.mock.calls).toEqual([
      [{ instrument: QQQ_CALL, side: 'sell', quantity: 2, type: 'limit', limitPrice: 1.5 }],
    ]);
    expect(cancel).not.toHaveBeenCalled();
    const [decision] = await ladderRows(db);
    expect(decision!.messageId).toMatch(/^ladder:lot-a:50:\d+$/);
    expect(decision).toMatchObject({
      kind: 'submitted',
      action: 'sell',
      order: {
        quantity: 2,
        orderType: 'limit',
        limitPrice: 1.5,
        orderId: 'sell-1',
        lots: [{ lotId: 'lot-a', quantity: 2, gainPct: 50 }],
      },
    });
  });

  it("with broker-side stops on, cancels the lot's resting stop, then places the sell", async () => {
    brokerStops.enabled = true;
    try {
      const { db, deps, place, cancel } = setup({ trimLevels: HALVES, positions: [held(4)], mark: MARK });
      seedLot(db, 'lot-a', '2026-06-11T13:00:00.000Z', 4, 'stop-1');

      expect(await sweep(deps)).toBe(1);

      expect(cancel.mock.calls).toEqual([['stop-1']]);
      expect(place).toHaveBeenCalledOnce();
      expect(cancel.mock.invocationCallOrder[0]!).toBeLessThan(place.mock.invocationCallOrder[0]!);
      const [lot] = await db.listOpenOptionLots(USER);
      expect(lot!.stopOrderId).toBeNull();
    } finally {
      brokerStops.enabled = false;
    }
  });
});
