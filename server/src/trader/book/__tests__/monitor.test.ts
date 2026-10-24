import { describe, expect, it, vi } from 'vitest';

import { createFakeDb, fakeTokens, type FakeDb } from '../../__tests__/fakeDb.js';
import { TraderEvents } from '../../events.js';
import { BrokerUnavailableError, type RobinhoodMcpClient } from '../../rh/mcpClient.js';
import type { McpRegistry, UserBroker } from '../../rh/mcpRegistry.js';
import type { RobinhoodTools } from '../../rh/tools.js';
import { openPosition } from '../ladder.js';
import { sweepBook, type BookMonitorDeps } from '../monitor.js';

/** Tuesday 2026-10-20 10:30 ET — inside regular US hours. */
const RTH = new Date('2026-10-20T14:30:00.000Z');
/** Same Tuesday, 20:00 ET — after the close. */
const AFTER_HOURS = new Date('2026-10-21T00:00:00.000Z');

interface StubOptions {
  readonly unavailable?: boolean;
  readonly markPrice?: number | null;
}

function makeBroker(options: StubOptions = {}): UserBroker {
  const mcp = {
    ensureReady: options.unavailable
      ? vi.fn().mockRejectedValue(new BrokerUnavailableError('needs consent'))
      : vi.fn().mockResolvedValue(undefined),
  } as unknown as RobinhoodMcpClient;
  const tools = {
    getOptionsMarkPrice: vi
      .fn()
      .mockResolvedValue(options.markPrice === null ? null : { markPrice: options.markPrice ?? 0.8 }),
  } as unknown as RobinhoodTools;
  return { mcp, tools };
}

function makeDeps(
  db: FakeDb,
  brokers: Record<string, UserBroker>,
  now: Date
): BookMonitorDeps & { events: TraderEvents } {
  const registry: McpRegistry = {
    for: (userId) => brokers[userId]!,
    existing: (userId) => brokers[userId],
    drop: vi.fn(),
  };
  return { db, brokers: registry, events: new TraderEvents(), now: () => now };
}

const seedOpen = (db: FakeDb, messageId: string, expiration = '2026-10-23') =>
  db.openTrackedCallout(
    openPosition({
      messageId,
      authorId: 'harvey',
      ticker: 'SPY',
      option: { optionType: 'call', strike: 680, expiration },
      entryPrice: 0.5,
      sizeHint: null,
      openedAt: '2026-10-20T13:45:00.000Z',
    })
  );

describe('sweepBook', () => {
  it('marks every open position through one connected session and emits once', async () => {
    const db = createFakeDb();
    db.seedBrokerTokens('u1', fakeTokens('t1'));
    await seedOpen(db, 'm-1');
    await seedOpen(db, 'm-2');
    const broker = makeBroker({ markPrice: 0.8 });
    const deps = makeDeps(db, { u1: broker }, RTH);
    const onBook = vi.fn();
    deps.events.subscribeBook(onBook);

    const result = await sweepBook(deps);

    expect(result).toEqual({ open: 2, marked: 2, settled: 0 });
    expect(broker.tools.getOptionsMarkPrice).toHaveBeenCalledTimes(2);
    expect(db.getTracked('m-1')!.lastMark).toBe(0.8);
    expect(db.getTracked('m-1')!.highestPct).toBeCloseTo(60);
    expect(db.getTracked('m-1')!.fills).toHaveLength(2);
    expect(onBook).toHaveBeenCalledTimes(1);
  });

  it('skips a session that needs consent and borrows the next connected one', async () => {
    const db = createFakeDb();
    db.seedBrokerTokens('u1', fakeTokens('t1'));
    db.seedBrokerTokens('u2', fakeTokens('t2'));
    await seedOpen(db, 'm-1');
    const dead = makeBroker({ unavailable: true });
    const live = makeBroker({ markPrice: 0.55 });
    const state = { preferredUserId: null };

    await sweepBook(makeDeps(db, { u1: dead, u2: live }, RTH), state);

    expect(dead.tools.getOptionsMarkPrice).not.toHaveBeenCalled();
    expect(live.tools.getOptionsMarkPrice).toHaveBeenCalledTimes(1);
    expect(state.preferredUserId).toBe('u2');
  });

  it('leaves a position untouched when no quote comes back', async () => {
    const db = createFakeDb();
    db.seedBrokerTokens('u1', fakeTokens('t1'));
    await seedOpen(db, 'm-1');

    const result = await sweepBook(makeDeps(db, { u1: makeBroker({ markPrice: null }) }, RTH));

    expect(result.marked).toBe(0);
    expect(db.getTracked('m-1')!.lastMark).toBeNull();
  });

  it('settles expired contracts outside regular hours without touching a broker', async () => {
    const db = createFakeDb();
    db.seedBrokerTokens('u1', fakeTokens('t1'));
    await seedOpen(db, 'expired', '2026-10-17');
    await seedOpen(db, 'live', '2026-10-23');
    const broker = makeBroker();

    const result = await sweepBook(makeDeps(db, { u1: broker }, AFTER_HOURS));

    expect(result).toEqual({ open: 2, marked: 0, settled: 1 });
    expect(db.getTracked('expired')).toMatchObject({ closedBy: 'expiry', result: 'loss', exitPrice: 0 });
    expect(db.getTracked('live')!.closedAt).toBeNull();
    expect(broker.mcp.ensureReady).not.toHaveBeenCalled();
  });

  it('does nothing with an empty book', async () => {
    const db = createFakeDb();
    db.seedBrokerTokens('u1', fakeTokens('t1'));
    const broker = makeBroker();

    expect(await sweepBook(makeDeps(db, { u1: broker }, RTH))).toEqual({ open: 0, marked: 0, settled: 0 });
    expect(broker.mcp.ensureReady).not.toHaveBeenCalled();
  });
});
