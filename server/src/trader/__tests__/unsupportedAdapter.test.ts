/**
 * An account whose adapter this deployment does not have: a SnapTrade row on
 * a deployment without the SnapTrade keys. It is left out of the callout
 * fan-out and of every monitor, named once at boot, and never in the way of
 * the accounts this deployment can trade.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TradeSettingsSchema,
  type CalloutParser,
  type Decision,
  type TradeSettings,
} from '../../shared/types.js';
import { VIEWED_ACCOUNT_HEADER } from '../auth.js';
import { createQuoteSource } from '../broker/quotes.js';
import { restoreSessions } from '../broker/registry.js';
import type { OrderRequest } from '../broker/types.js';
import { TraderEvents, type StageEvent } from '../events.js';
import { sweepFills } from '../fills.js';
import { sweepLadders } from '../ladderMonitor.js';
import { sweepMaxLoss } from '../maxLoss.js';
import { BTO_QQQ_PUT, envelopeFromFixture } from '../pipeline/__tests__/fixtures/discordMessages.js';
import { createMessageProcessor } from '../pipeline/index.js';
import type { RobinhoodMcpClient } from '../robinhood/mcpClient.js';
import type { AccountsResponse } from '../server.js';
import { createFakeDb, fakeAccount, fakeSnapTradeAccount, fakeTokens, type FakeDb } from './fakeDb.js';
import {
  makeFakeBroker,
  makeFakeRegistry,
  makeHarness,
  optionPosition,
  placedOrders,
  type FakeBroker,
  type Harness,
} from './harness.js';

const OWNER = 'user-owner';
const ROBINHOOD = fakeAccount('account-robinhood', OWNER);
/** Connected like any other account, but this deployment's registry holds no SnapTrade adapter. */
const UNSUPPORTED = fakeSnapTradeAccount('account-paper', OWNER);

/** Tuesday 2026-09-08 10:30 ET: inside regular US hours, when Max Loss sweeps. */
const REGULAR_HOURS = new Date('2026-09-08T14:30:00.000Z');

/** Auto-executing and following everyone, with the calendar guards relaxed. */
const TRADING: TradeSettings = {
  executionMode: 'immediate',
  followedCallerIds: null,
  regularHoursOnly: false,
  cooldownSeconds: 0,
};

const ENTRY_ENVELOPE = envelopeFromFixture(BTO_QQQ_PUT);
const ENTRY_OPTION = BTO_QQQ_PUT.expectedCallout.option!;

const OPEN_LOT_MESSAGE_ID = 'open-lot';
const OPEN_LOT_CONTRACTS = 2;
const OPEN_LOT_ENTRY = 1.5;
/** Half the entry: past a 50% Max Loss. */
const LOSING_MARK = 0.75;
/** Past the ladder's one level, +50% of the entry. */
const WINNING_MARK = 2.4;
/** Near the entry's strike, so the entry check has nothing to hold the callout for. */
const QQQ_SPOT = 710;

/** A filled option buy still open at the broker: what each monitor acts on. */
const openLot = (status: 'filled' | 'unconfirmed'): Decision => ({
  at: REGULAR_HOURS.toISOString(),
  messageId: OPEN_LOT_MESSAGE_ID,
  kind: 'submitted',
  code: null,
  reason: 'bought',
  ticker: 'QQQ',
  action: 'buy',
  order: {
    symbol: 'QQQ',
    side: 'buy',
    assetType: 'option',
    quantity: OPEN_LOT_CONTRACTS,
    orderType: 'limit',
    limitPrice: OPEN_LOT_ENTRY,
    option: ENTRY_OPTION,
    orderId: 'buy-1',
    status,
  },
});

interface World {
  readonly db: FakeDb;
  readonly events: TraderEvents;
  readonly brokers: ReturnType<typeof makeFakeRegistry>;
  readonly robinhoodBroker: FakeBroker;
  /** Every account id the registry was asked to open a session for. */
  readonly opened: string[];
}

interface WorldOptions {
  /** Only the Robinhood account: the comparison case. */
  readonly alone?: boolean;
  /** The contract's mark at the Robinhood broker; null means it cannot price it. */
  readonly optionMark?: number | null;
}

/** The Robinhood account, and beside it (unless `alone`) the account this deployment cannot open. */
function makeWorld(options: WorldOptions = {}): World {
  const db = createFakeDb();
  const accounts = options.alone ? [ROBINHOOD] : [UNSUPPORTED, ROBINHOOD];
  for (const account of accounts) {
    db.addAccount(account);
    db.seedBrokerTokens(account.id, fakeTokens(`token-${account.id}`));
    db.seedSettings(account.id, TRADING);
  }
  const robinhoodBroker = makeFakeBroker({
    positions: [
      optionPosition('QQQ', ENTRY_OPTION.optionType, ENTRY_OPTION.strike, ENTRY_OPTION.expiration, OPEN_LOT_CONTRACTS),
    ],
    equityMark: QQQ_SPOT,
    optionMark: options.optionMark ?? null,
  });
  const session = {
    isConnected: vi.fn().mockReturnValue(true),
    ensureReady: vi.fn().mockResolvedValue(undefined),
  } as unknown as RobinhoodMcpClient;
  const opened: string[] = [];
  const brokers = makeFakeRegistry((accountId) => {
    opened.push(accountId);
    return { session, broker: robinhoodBroker };
  });
  return { db, events: new TraderEvents(), brokers, robinhoodBroker, opened };
}

const scopedCalls = (db: FakeDb, accountId: string): string[] =>
  db.calls.filter((call) => call.scopeId === accountId).map((call) => call.method);

describe('a callout, with a connected account whose adapter is not deployed', () => {
  interface CalloutOutcome {
    readonly world: World;
    readonly decisions: Array<Omit<Decision, 'at'>>;
    readonly orders: OrderRequest[];
    readonly stages: Array<StageEvent['stage']>;
    readonly heardByUnsupported: string[];
  }

  async function processEntry(options: { readonly alone?: boolean } = {}): Promise<CalloutOutcome> {
    const world = makeWorld(options);
    const { db, events, brokers, robinhoodBroker } = world;
    const stages: Array<StageEvent['stage']> = [];
    const heardByUnsupported: string[] = [];
    events.subscribe(ROBINHOOD.id, { onStage: (event) => stages.push(event.stage) });
    events.subscribe(UNSUPPORTED.id, {
      onStage: (event) => heardByUnsupported.push(event.stage),
      onDecision: (decision) => heardByUnsupported.push(decision.kind),
    });
    const parser: CalloutParser = { parse: vi.fn(async () => BTO_QQQ_PUT.expectedCallout) };
    const processor = createMessageProcessor({
      parser,
      db,
      events,
      brokers,
      quotes: createQuoteSource({ db, brokers }),
      executionMode: 'immediate',
    });

    await processor.process(ENTRY_ENVELOPE);

    const decisions = (await db.listDecisions(ROBINHOOD.id, 10)).map(({ at: _at, ...rest }) => rest);
    return { world, decisions, orders: placedOrders(robinhoodBroker, 'option'), stages, heardByUnsupported };
  }

  it('is handled for the Robinhood account exactly as it is without that account', async () => {
    const beside = await processEntry();
    const alone = await processEntry({ alone: true });

    expect(beside.decisions).toMatchObject([{ kind: 'submitted', order: { side: 'buy' } }]);
    expect(beside.orders).toHaveLength(1);
    expect(beside.decisions).toEqual(alone.decisions);
    expect(beside.orders).toEqual(alone.orders);
    expect(beside.stages).toEqual(alone.stages);
    expect(beside.world.robinhoodBroker.getAccount.mock.calls).toEqual(alone.world.robinhoodBroker.getAccount.mock.calls);
  });

  it('leaves that account out: no decision row, no live event, no read under its id', async () => {
    const { world, heardByUnsupported } = await processEntry();

    expect(scopedCalls(world.db, UNSUPPORTED.id)).toEqual([]);
    expect(heardByUnsupported).toEqual([]);
    expect(world.opened).toEqual([ROBINHOOD.id]);
    expect(await world.db.listDecisions(UNSUPPORTED.id, 10)).toEqual([]);
  });
});

describe('boot warm-up, with a connected account whose adapter is not deployed', () => {
  afterEach(() => vi.restoreAllMocks());

  const warnings = (stderr: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> =>
    stderr.mock.calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .filter((line) => line.level === 'warn');

  it('names the account and its adapter once, and still restores the accounts after it', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const db = createFakeDb();
    for (const account of [UNSUPPORTED, ROBINHOOD]) {
      db.addAccount(account);
      db.seedBrokerTokens(account.id, fakeTokens('tok'));
    }
    const ensureConnected = vi.fn().mockResolvedValue(undefined);
    const restored: string[] = [];
    const brokers = makeFakeRegistry((accountId) => {
      restored.push(accountId);
      return { session: { ensureConnected } as unknown as RobinhoodMcpClient, broker: makeFakeBroker() };
    });

    await restoreSessions(db, brokers);

    expect(restored).toEqual([ROBINHOOD.id]);
    expect(ensureConnected).toHaveBeenCalledOnce();
    expect(warnings(stderr)).toMatchObject([{ accountId: UNSUPPORTED.id, adapter: 'snaptrade' }]);
  });

  it('an account whose session cannot be opened does not stop the ones after it', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const BROKEN = fakeAccount('account-broken', OWNER);
    const db = createFakeDb();
    for (const account of [BROKEN, ROBINHOOD]) {
      db.addAccount(account);
      db.seedBrokerTokens(account.id, fakeTokens('tok'));
    }
    const ensureConnected = vi.fn().mockResolvedValue(undefined);
    const brokers = makeFakeRegistry((accountId) => {
      if (accountId === BROKEN.id) throw new Error('adapter could not open the account');
      return { session: { ensureConnected } as unknown as RobinhoodMcpClient, broker: makeFakeBroker() };
    });

    await restoreSessions(db, brokers);
    await vi.waitFor(() => expect(warnings(stderr)).toHaveLength(1));

    expect(ensureConnected).toHaveBeenCalledOnce();
    expect(warnings(stderr)).toMatchObject([{ accountId: BROKEN.id, error: 'adapter could not open the account' }]);
  });
});

describe('the monitors, with a connected account whose adapter is not deployed', () => {
  /** Both accounts hold the same open lot, so each monitor has the same work on each. */
  function worldWithOpenLots(
    status: 'filled' | 'unconfirmed',
    settings: TradeSettings,
    optionMark: number | null = null
  ): World {
    const world = makeWorld({ optionMark });
    world.db.seedMessage({ messageId: OPEN_LOT_MESSAGE_ID, sentAt: REGULAR_HOURS.toISOString() });
    for (const account of [UNSUPPORTED, ROBINHOOD]) {
      world.db.seedSettings(account.id, TradeSettingsSchema.parse(settings));
      world.db.seedDecision(account.id, openLot(status));
    }
    world.db.calls.length = 0;
    return world;
  }

  it('Max Loss never queues a scan for it, and still closes the Robinhood position', async () => {
    const { db, events, brokers, robinhoodBroker, opened } = worldWithOpenLots('filled', { maxLossPct: 50 }, LOSING_MARK);
    const queued: string[] = [];

    await sweepMaxLoss(
      {
        db,
        brokers,
        events,
        enqueue: (accountId, run) => {
          queued.push(accountId);
          return run();
        },
        now: () => REGULAR_HOURS,
      },
      new Map()
    );

    expect(queued).toEqual([ROBINHOOD.id]);
    expect(opened).toEqual([ROBINHOOD.id]);
    expect(placedOrders(robinhoodBroker, 'option')).toMatchObject([{ side: 'sell', type: 'market' }]);
  });

  it('the own-target ladder never reads it, and still sells the Robinhood level', async () => {
    const { db, events, brokers, robinhoodBroker, opened } = worldWithOpenLots(
      'filled',
      { exitMode: 'ladder', trimLevels: [{ gainPct: 50, portionPct: 50 }] },
      WINNING_MARK
    );

    expect(await sweepLadders({ db, brokers, events, executionMode: 'immediate' })).toBe(1);

    expect(scopedCalls(db, UNSUPPORTED.id)).toEqual([]);
    expect(opened).toEqual([ROBINHOOD.id]);
    expect(placedOrders(robinhoodBroker, 'option')).toMatchObject([{ side: 'sell', type: 'limit' }]);
  });

  it('the fill sweep never opens it, and still reads the Robinhood order back', async () => {
    const world = worldWithOpenLots('unconfirmed', {});
    const { db, events, brokers, robinhoodBroker, opened } = world;
    const asked = vi.spyOn(brokers, 'for');

    const result = await sweepFills({ db, brokers, events, executionMode: 'immediate', now: () => REGULAR_HOURS });

    expect(result.open).toBe(2);
    expect(asked.mock.calls.map(([account]) => account.id)).not.toContain(UNSUPPORTED.id);
    expect(opened).toEqual([ROBINHOOD.id]);
    expect(robinhoodBroker.getOrders).toHaveBeenCalledOnce();
  });
});

describe('the routes, when the selected account is one whose adapter is not deployed', () => {
  const USER = { id: OWNER, email: 'owner@example.com' };
  const TOKEN = 'token-for-owner';
  const PENDING_MESSAGE_ID = 'msg-pending';
  const UNAVAILABLE = { error: `${UNSUPPORTED.label} is not available on this deployment` };

  let harness: Harness;
  const get = (url: string) => harness.as(TOKEN, { method: 'GET', url });

  beforeEach(() => {
    // The harness registry holds the Robinhood adapter alone.
    harness = makeHarness();
    harness.db.addUser(USER, TOKEN, ROBINHOOD.id);
    harness.db.addAccount(UNSUPPORTED, { select: true });
    for (const account of [ROBINHOOD, UNSUPPORTED]) {
      harness.db.seedBrokerTokens(account.id, fakeTokens(`token-${account.id}`));
    }
  });

  it('portfolio and performance answer the not-connected 409, naming the reason', async () => {
    for (const url of ['/api/portfolio', '/api/trades/performance']) {
      const response = await get(url);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual(UNAVAILABLE);
    }
  });

  it('approve answers the same 409 and leaves the trade pending', async () => {
    harness.db.seedDecision(UNSUPPORTED.id, { ...openLot('filled'), messageId: PENDING_MESSAGE_ID, kind: 'pending_approval' });

    const response = await harness.as(TOKEN, {
      method: 'POST',
      url: `/api/trades/${PENDING_MESSAGE_ID}/approve`,
      headers: { [VIEWED_ACCOUNT_HEADER]: UNSUPPORTED.id },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual(UNAVAILABLE);
    expect((await harness.db.listDecisions(UNSUPPORTED.id, 10))[0]!.kind).toBe('pending_approval');
  });

  it('the account reads as not connected in the status, and with its real connection in the account list', async () => {
    expect((await get('/api/broker/status')).json()).toMatchObject({ connected: false });

    const { brokers } = (await get('/api/accounts')).json() as AccountsResponse;
    expect(brokers).toMatchObject([
      { adapter: 'robinhood', account: { id: ROBINHOOD.id, connected: true } },
      { adapter: 'snaptrade', accounts: { [UNSUPPORTED.id]: { connected: true } } },
    ]);
  });

  it('no session is opened for it', async () => {
    await get('/api/portfolio');
    await get('/api/trades/performance');

    expect(harness.brokers.existing(UNSUPPORTED.id)).toBeUndefined();
  });
});
