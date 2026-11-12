/**
 * TRADE_EXECUTION_MODE=paper_only (staging): a paper account trades as its own
 * settings say, and every other account is held exactly as under read_only.
 *
 * Each case runs a paper account beside one that is not paper, both following
 * the same Caller and holding the same lot, so every path has the same work on
 * both. The account that is not paper must see no write call on its adapter.
 *
 * A paper account is a SnapTrade account, and a SnapTrade account meters its
 * requests (broker/requestBudget.ts): Max Loss and the stop rest leave it out
 * whatever the mode. So under paper_only neither writes for anyone: the mode
 * would let a paper account's through, and the budget rule never attempts it.
 * The fakes here price options, which SnapTrade does not; the real adapter
 * under paper_only is in snaptradeWiring.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  TRADE_EXECUTION_MODES,
  TradeSettingsSchema,
  type CalloutParser,
  type Decision,
  type TradeExecutionMode,
  type TradeSettings,
} from '../../shared/types.js';
import { VIEWED_ACCOUNT_HEADER } from '../auth.js';
import { BrokerWritesDisabledError } from '../broker/errors.js';
import { isPaperAccount } from '../broker/paperAccount.js';
import { createQuoteSource } from '../broker/quotes.js';
import { createMcpRegistry, type McpRegistry } from '../broker/registry.js';
import { isRequestMetered } from '../broker/requestBudget.js';
import type { AccountRow, BrokerOrder, OrderRequest } from '../broker/types.js';
import { TraderEvents } from '../events.js';
import { sweepFills } from '../fills.js';
import { sweepLadders } from '../ladderMonitor.js';
import { sweepMaxLoss } from '../maxLoss.js';
import { BTO_QQQ_PUT, envelopeFromFixture } from '../pipeline/__tests__/fixtures/discordMessages.js';
import { submitOrder } from '../pipeline/execute.js';
import { createMessageProcessor } from '../pipeline/index.js';
import type { RobinhoodMcpClient } from '../robinhood/mcpClient.js';
import type { SnapTradeClient } from '../snaptrade/client.js';
import { cancelStops, restMissingStops } from '../stops.js';
import { createFakeDb, fakeAccount, fakeSnapTradeAccount, fakeTokens, type FakeDb } from './fakeDb.js';
import { makeFakeBroker, makeHarness, optionPosition, placedOrders, type FakeBroker, type Harness } from './harness.js';

const PAPER_ONLY: TradeExecutionMode = 'paper_only';
const OWNER = 'user-owner';
const OTHER_ID = 'account-other';

/** Alpaca paper, reached through SnapTrade: the one kind of account staging may trade. */
const PAPER = fakeSnapTradeAccount('account-paper', OWNER);
const LIVE_SLUG = 'SCHWAB';
const snapTradeOther = (isPaper: boolean, institutionSlug: string): AccountRow => {
  const row = fakeSnapTradeAccount(OTHER_ID, OWNER);
  if (row.adapter !== 'snaptrade') throw new Error('fakeSnapTradeAccount no longer makes a SnapTrade row');
  return { ...row, isPaper, institution: institutionSlug.toLowerCase(), adapterData: { ...row.adapterData, institutionSlug } };
};

/** Every kind of account that is not paper; each must be held like the others. */
const NOT_PAPER: ReadonlyArray<readonly [string, AccountRow]> = [
  ['a Robinhood account', fakeAccount(OTHER_ID, OWNER)],
  ['a SnapTrade account at a live broker', snapTradeOther(false, LIVE_SLUG)],
  ['a SnapTrade account flagged paper at a brokerage not on the allowlist', snapTradeOther(true, LIVE_SLUG)],
  ['a SnapTrade account at the paper brokerage that is not flagged paper', snapTradeOther(false, 'ALPACA-PAPER')],
];

/** Tuesday 2026-09-08 10:30 ET: inside regular US hours, when Max Loss sweeps. */
const REGULAR_HOURS = new Date('2026-09-08T14:30:00.000Z');

/** Auto-executing and following everyone, with the calendar guards relaxed. */
const IMMEDIATE: TradeSettings = {
  executionMode: 'immediate',
  followedCallerIds: null,
  regularHoursOnly: false,
  cooldownSeconds: 0,
};
const APPROVAL: TradeSettings = { ...IMMEDIATE, executionMode: 'approval' };

const ENTRY_ENVELOPE = envelopeFromFixture(BTO_QQQ_PUT);
const ENTRY_OPTION = BTO_QQQ_PUT.expectedCallout.option!;
/** Near the entry's strike, so the entry check has nothing to hold the callout for. */
const QQQ_SPOT = 710;

const OPEN_LOT_MESSAGE_ID = 'open-lot';
const OPEN_LOT_ORDER_ID = 'buy-1';
const OPEN_LOT_CONTRACTS = 2;
const OPEN_LOT_ENTRY = 1.5;
/** Half the entry: past a 50% Max Loss. */
const LOSING_MARK = 0.75;
/** Past the ladder's one level, +50% of the entry. */
const WINNING_MARK = 2.4;
const MAX_LOSS: TradeSettings = { maxLossPct: 50 };
const LADDER: TradeSettings = { exitMode: 'ladder', trimLevels: [{ gainPct: 50, portionPct: 50 }] };
const RESTING_STOP_ID = 'stop-1';
const HELD = `Held by TRADE_EXECUTION_MODE=${PAPER_ONLY}`;

/** A filled option buy still open at the broker: what each monitor acts on. */
const openLot = (status: 'filled' | 'unconfirmed', stopOrderId?: string): Decision => ({
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
    orderId: OPEN_LOT_ORDER_ID,
    status,
    ...(stopOrderId !== undefined ? { stopOrderId } : {}),
  },
});

/** The broker's own record of that buy, filled: what the fill sweep reads back. */
const FILLED_AT_BROKER: BrokerOrder = {
  orderId: OPEN_LOT_ORDER_ID,
  instrument: { kind: 'option', symbol: 'QQQ', ...ENTRY_OPTION },
  side: 'buy',
  status: 'filled',
  fillPrice: OPEN_LOT_ENTRY,
  quantity: OPEN_LOT_CONTRACTS,
  createdAt: REGULAR_HOURS.toISOString(),
};

const SESSION = {
  isConnected: vi.fn().mockReturnValue(true),
  ensureReady: vi.fn().mockResolvedValue(undefined),
} as unknown as RobinhoodMcpClient;

interface World {
  readonly db: FakeDb;
  readonly events: TraderEvents;
  readonly brokers: McpRegistry;
  /** The broker behind each account's adapter: what a write would reach. */
  readonly behind: (account: AccountRow) => FakeBroker;
}

interface WorldOptions {
  readonly optionMark?: number | null;
  readonly orders?: readonly BrokerOrder[];
}

/** Only a Robinhood account stores credentials; a SnapTrade one is connected by its row alone. */
const seedCredentials = (db: FakeDb, account: AccountRow): void => {
  if (account.adapter === 'robinhood') db.seedBrokerTokens(account.id, fakeTokens(`token-${account.id}`));
};

/** The paper account and `other`, each connected, each with its own broker behind its own adapter. */
function makeWorld(other: AccountRow, options: WorldOptions = {}): World {
  const db = createFakeDb();
  for (const account of [other, PAPER]) {
    db.addAccount(account);
    seedCredentials(db, account);
  }
  const fakes = new Map<string, FakeBroker>();
  const fakeOf = (accountId: string): FakeBroker => {
    let fake = fakes.get(accountId);
    if (!fake) {
      fake = makeFakeBroker({
        positions: [
          optionPosition('QQQ', ENTRY_OPTION.optionType, ENTRY_OPTION.strike, ENTRY_OPTION.expiration, OPEN_LOT_CONTRACTS),
        ],
        equityMark: QQQ_SPOT,
        optionMark: options.optionMark ?? null,
        orders: options.orders ?? null,
      });
      fakes.set(accountId, fake);
    }
    return fake;
  };
  const brokers = createMcpRegistry(
    (['robinhood', 'snaptrade'] as const).map((id) => ({
      id,
      quotesOptions: true,
      open: (account: AccountRow) => ({ session: SESSION, broker: fakeOf(account.id) }),
    })),
    PAPER_ONLY
  );
  return { db, events: new TraderEvents(), brokers, behind: (account) => fakeOf(account.id) };
}

/** Both accounts hold the same open lot under the same settings. */
function worldWithOpenLots(
  other: AccountRow,
  settings: TradeSettings,
  options: WorldOptions & { readonly status?: 'filled' | 'unconfirmed'; readonly stopOrderId?: string } = {}
): World {
  const world = makeWorld(other, options);
  world.db.seedMessage({ messageId: OPEN_LOT_MESSAGE_ID, sentAt: REGULAR_HOURS.toISOString() });
  for (const account of [other, PAPER]) {
    world.db.seedSettings(account.id, TradeSettingsSchema.parse(settings));
    world.db.seedDecision(account.id, openLot(options.status ?? 'filled', options.stopOrderId));
  }
  world.db.calls.length = 0;
  return world;
}

const writes = (fake: FakeBroker): number => fake.placeOrder.mock.calls.length + fake.cancelOrder.mock.calls.length;
const decisionsOf = async (db: FakeDb, account: AccountRow): Promise<Decision[]> => db.listDecisions(account.id, 10);
const scopedCalls = (db: FakeDb, account: AccountRow): string[] =>
  db.calls.filter((call) => call.scopeId === account.id).map((call) => call.method);

describe.each(NOT_PAPER)('paper_only: a paper account beside %s', (_name, other) => {
  describe('a callout both accounts follow', () => {
    async function processEntry(paperSettings: TradeSettings, otherSettings: TradeSettings): Promise<World> {
      const world = makeWorld(other);
      world.db.seedSettings(PAPER.id, paperSettings);
      world.db.seedSettings(other.id, otherSettings);
      const parser: CalloutParser = { parse: vi.fn(async () => BTO_QQQ_PUT.expectedCallout) };
      const processor = createMessageProcessor({
        parser,
        db: world.db,
        events: world.events,
        brokers: world.brokers,
        quotes: createQuoteSource({ db: world.db, brokers: world.brokers }),
        executionMode: PAPER_ONLY,
      });
      await processor.process(ENTRY_ENVELOPE);
      return world;
    }

    it('the paper account in approval mode waits for its own approval, not held by the deployment', async () => {
      const { db, behind } = await processEntry(APPROVAL, APPROVAL);

      const [decision, ...rest] = await decisionsOf(db, PAPER);
      expect(rest).toEqual([]);
      expect(decision).toMatchObject({ kind: 'pending_approval', order: { side: 'buy' } });
      expect(decision!.reason).not.toContain('Held by');
      expect(writes(behind(PAPER))).toBe(0);
    });

    it('the paper account in immediate mode places the order', async () => {
      const { db, behind } = await processEntry(IMMEDIATE, IMMEDIATE);

      expect(await decisionsOf(db, PAPER)).toMatchObject([{ kind: 'submitted', order: { side: 'buy' } }]);
      expect(placedOrders(behind(PAPER), 'option')).toMatchObject([{ side: 'buy', type: 'limit' }]);
    });

    it.each([
      ['immediate', IMMEDIATE],
      ['approval', APPROVAL],
    ] as const)('the other account is held by the deployment when its own settings say %s', async (_mode, settings) => {
      const { db, behind } = await processEntry(IMMEDIATE, settings);

      const [decision, ...rest] = await decisionsOf(db, other);
      expect(rest).toEqual([]);
      expect(decision).toMatchObject({ kind: 'pending_approval', order: { side: 'buy' } });
      expect(decision!.reason).toContain(HELD);
      expect(writes(behind(other))).toBe(0);
    });
  });

  describe('Approve', () => {
    const USER = { id: OWNER, email: 'owner@example.com' };
    const TOKEN = 'token-for-owner';
    const PENDING_MESSAGE_ID = 'msg-pending';
    let harness: Harness;

    /** Approves on `account` as the dashboard does: selected, and named by the request. */
    const approve = (account: AccountRow) => {
      harness.db.addAccount(account, { select: true });
      return harness.as(TOKEN, {
        method: 'POST',
        url: `/api/trades/${PENDING_MESSAGE_ID}/approve`,
        headers: { [VIEWED_ACCOUNT_HEADER]: account.id },
      });
    };

    async function start(otherSettings: TradeSettings): Promise<void> {
      harness = makeHarness({ executionMode: PAPER_ONLY, adapters: ['robinhood', 'snaptrade'] });
      harness.db.addUser(USER, TOKEN);
      for (const account of [other, PAPER]) {
        harness.db.addAccount(account);
        seedCredentials(harness.db, account);
        harness.db.seedDecision(account.id, {
          ...openLot('filled'),
          messageId: PENDING_MESSAGE_ID,
          kind: 'pending_approval',
          order: { ...openLot('filled').order!, orderId: null, status: null },
        });
      }
      harness.db.seedSettings(other.id, otherSettings);
    }

    it("the paper account's approval places the order, with no credentials stored for it", async () => {
      await start(IMMEDIATE);

      const response = await approve(PAPER);

      expect(await harness.db.getBrokerTokens(PAPER.id)).toBeNull();
      expect(response.statusCode).toBe(200);
      expect((response.json() as { decision: Decision }).decision.kind).toBe('submitted');
      expect(placedOrders(harness.fakeBroker(PAPER.id), 'option')).toMatchObject([
        { side: 'buy', quantity: OPEN_LOT_CONTRACTS },
      ]);
    });

    it.each([
      ['immediate', IMMEDIATE],
      ['approval', APPROVAL],
    ] as const)("the other account's is refused and stays pending (its own settings: %s)", async (_mode, settings) => {
      await start(settings);

      const response = await approve(other);

      expect(response.statusCode).toBe(409);
      expect((response.json() as { error: string }).error).toContain(PAPER_ONLY);
      expect((await harness.db.listDecisions(other.id, 10))[0]!.kind).toBe('pending_approval');
      expect(writes(harness.fakeBroker(other.id))).toBe(0);
    });
  });

  describe('the monitors', () => {
    it('Max Loss sells on neither: the paper account is not scanned (its adapter meters requests), the other is refused', async () => {
      const { db, events, brokers, behind } = worldWithOpenLots(other, MAX_LOSS, { optionMark: LOSING_MARK });
      const reachedGuard = vi.spyOn(brokers.for(other).broker, 'placeOrder');

      await sweepMaxLoss(
        { db, brokers, events, enqueue: (_accountId, run) => run(), now: () => REGULAR_HOURS },
        new Map()
      );

      // Not attempted on the paper account: it is neither opened nor read.
      expect(brokers.existing(PAPER.id)).toBeUndefined();
      expect(scopedCalls(db, PAPER)).toEqual([]);
      // A Robinhood account's breach gets as far as the guard; a SnapTrade one is not scanned either.
      expect(reachedGuard).toHaveBeenCalledTimes(isRequestMetered(other) ? 0 : 1);
      for (const account of [PAPER, other]) {
        expect(writes(behind(account))).toBe(0);
        expect((await decisionsOf(db, account)).filter((d) => d.kind === 'max_loss_exit')).toEqual([]);
      }
    });

    it('the own-target ladder sells the paper level and never reads the other', async () => {
      const { db, events, brokers, behind } = worldWithOpenLots(other, LADDER, { optionMark: WINNING_MARK });

      expect(await sweepLadders({ db, brokers, events, executionMode: PAPER_ONLY })).toBe(1);

      expect(placedOrders(behind(PAPER), 'option')).toMatchObject([{ side: 'sell', type: 'limit' }]);
      expect(writes(behind(other))).toBe(0);
      expect(scopedCalls(db, other)).toEqual([]);
    });

    it('the fill sweep reads both fills back and rests a stop on neither: the paper account meters requests, the other is held', async () => {
      const { db, events, brokers, behind } = worldWithOpenLots(other, MAX_LOSS, {
        status: 'unconfirmed',
        orders: [FILLED_AT_BROKER],
      });

      await sweepFills({ db, brokers, events, executionMode: PAPER_ONLY, now: () => REGULAR_HOURS });

      for (const account of [PAPER, other]) {
        // The fill itself is still read back: reads are never held.
        expect((await decisionsOf(db, account))[0]!.order).toMatchObject({ status: 'filled' });
        expect(writes(behind(account))).toBe(0);
        expect((await db.listOpenOptionLots(account.id)).map((lot) => lot.stopOrderId)).toEqual([null]);
      }
    });
  });

  /**
   * Each write path run as if its own policy check had let it through
   * (`immediate`), over the paper_only registry: the guard alone holds the
   * account that is not paper.
   */
  describe('the write paths behind the guard alone', () => {
    const SELL: OrderRequest = {
      instrument: { kind: 'option', symbol: 'QQQ', ...ENTRY_OPTION },
      side: 'sell',
      quantity: OPEN_LOT_CONTRACTS,
      type: 'market',
    };

    it('placeOrder and cancelOrder: refused for the other account, passed on for the paper one', async () => {
      const { brokers, behind } = makeWorld(other);

      await expect(brokers.for(other).broker.placeOrder(SELL)).rejects.toBeInstanceOf(BrokerWritesDisabledError);
      await expect(brokers.for(other).broker.cancelOrder(RESTING_STOP_ID)).rejects.toBeInstanceOf(
        BrokerWritesDisabledError
      );
      expect(writes(behind(other))).toBe(0);

      expect(brokers.for(PAPER).broker).toBe(behind(PAPER));
    });

    it('submitOrder: refused for the other account, placed for the paper one', async () => {
      const { brokers, behind } = makeWorld(other);

      await expect(submitOrder(openLot('filled').order!, brokers.for(other).broker)).rejects.toBeInstanceOf(
        BrokerWritesDisabledError
      );
      expect(writes(behind(other))).toBe(0);

      // What a monitor's order on the paper account would meet, were one attempted: nothing.
      await submitOrder(openLot('filled').order!, brokers.for(PAPER).broker);
      expect(placedOrders(behind(PAPER), 'option')).toHaveLength(1);
    });

    it('cancelStops: the resting stop is neither cancelled nor forgotten', async () => {
      const { db, brokers, behind } = worldWithOpenLots(other, MAX_LOSS, { stopOrderId: RESTING_STOP_ID });

      await expect(
        cancelStops(db, other.id, brokers.for(other).broker, 'QQQ', ENTRY_OPTION)
      ).rejects.toBeInstanceOf(BrokerWritesDisabledError);

      expect(writes(behind(other))).toBe(0);
      expect((await db.listOpenOptionLots(other.id)).map((lot) => lot.stopOrderId)).toEqual([RESTING_STOP_ID]);
    });

    it('restMissingStops: no stop is rested and none is recorded', async () => {
      const { db, brokers, behind } = worldWithOpenLots(other, MAX_LOSS);

      await restMissingStops({ accountId: other.id, db, broker: brokers.for(other).broker, executionMode: 'immediate' });

      expect(writes(behind(other))).toBe(0);
      expect((await db.listOpenOptionLots(other.id)).map((lot) => lot.stopOrderId)).toEqual([null]);
    });

    it('the own-target ladder: no sell is placed or recorded for the other account', async () => {
      const { db, events, brokers, behind } = worldWithOpenLots(other, LADDER, { optionMark: WINNING_MARK });

      expect(await sweepLadders({ db, brokers, events, executionMode: 'immediate' })).toBe(1);

      expect(placedOrders(behind(PAPER), 'option')).toHaveLength(1);
      expect(writes(behind(other))).toBe(0);
      expect(await decisionsOf(db, other)).toHaveLength(1);
    });

    it('the fill sweep: no stop is rested for the other account, and none is attempted on the paper one', async () => {
      const { db, events, brokers, behind } = worldWithOpenLots(other, MAX_LOSS, {
        status: 'unconfirmed',
        orders: [FILLED_AT_BROKER],
      });
      const reachedGuard = vi.spyOn(brokers.for(other).broker, 'placeOrder');

      await sweepFills({ db, brokers, events, executionMode: 'immediate', now: () => REGULAR_HOURS });

      // A Robinhood account's stop gets as far as the guard; a SnapTrade one's is never sent (metered).
      expect(reachedGuard).toHaveBeenCalledTimes(isRequestMetered(other) ? 0 : 1);
      expect(writes(behind(other))).toBe(0);
      expect(writes(behind(PAPER))).toBe(0);
    });
  });
});

describe('paper_only: the registry follows the account row', () => {
  const SELL: OrderRequest = {
    instrument: { kind: 'option', symbol: 'QQQ', ...ENTRY_OPTION },
    side: 'sell',
    quantity: OPEN_LOT_CONTRACTS,
    type: 'market',
  };

  it('a session opened for a paper account refuses writes once its row no longer reads as paper', async () => {
    const { brokers, behind } = makeWorld(fakeAccount(OTHER_ID, OWNER));
    expect(brokers.for(PAPER).broker).toBe(behind(PAPER));

    const relabelled = brokers.for({ ...PAPER, isPaper: false }).broker;

    await expect(relabelled.placeOrder(SELL)).rejects.toBeInstanceOf(BrokerWritesDisabledError);
    await expect(relabelled.cancelOrder(RESTING_STOP_ID)).rejects.toBeInstanceOf(BrokerWritesDisabledError);
    expect(brokers.existing(PAPER.id)!.broker).toBe(relabelled);
    expect(writes(behind(PAPER))).toBe(0);
  });

  it('the same row keeps the same session and broker', () => {
    const { brokers } = makeWorld(fakeAccount(OTHER_ID, OWNER));

    expect(brokers.for(PAPER)).toBe(brokers.for({ ...PAPER }));
  });
});

describe('the modes that hold every account alike', () => {
  it.each(['approval', 'read_only'] as const)(
    '%s: the own-target ladder lists no account, as before, and sells nothing',
    async (executionMode) => {
      const other = fakeAccount(OTHER_ID, OWNER);
      const { db, events, brokers, behind } = worldWithOpenLots(other, LADDER, { optionMark: WINNING_MARK });
      const listed = vi.spyOn(db, 'listConnectedAccounts');

      expect(await sweepLadders({ db, brokers, events, executionMode })).toBe(0);

      expect(listed).not.toHaveBeenCalled();
      expect(writes(behind(PAPER)) + writes(behind(other))).toBe(0);
    }
  );
});

describe('paper_only: connecting', () => {
  const USER = { id: OWNER, email: 'owner@example.com' };
  const TOKEN = 'token-for-owner';
  const ROBINHOOD_ID = 'account-robinhood';
  const PORTAL_URL = 'https://app.snaptrade.com/snapTrade/redeemToken?token=one-time';
  const snapTrade: SnapTradeClient = {
    portalLink: async () => PORTAL_URL,
    listConnections: async () => [
      { id: 'conn-alpaca', brokerageSlug: 'ALPACA-PAPER', brokerageName: 'Alpaca Paper', type: 'trade', disabled: false },
      { id: 'conn-live', brokerageSlug: LIVE_SLUG, brokerageName: 'Schwab', type: 'trade', disabled: false },
    ],
    listAccounts: async () => [
      { id: 'st-alpaca', connectionId: 'conn-alpaca', displayName: 'Paper', maskedAccountNumber: '1234', isPaper: true },
      { id: 'st-live', connectionId: 'conn-live', displayName: 'Individual', maskedAccountNumber: '9876', isPaper: false },
    ],
  };
  let harness: Harness;

  const post = (url: string, body: unknown = {}) =>
    harness.as(TOKEN, {
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json', [VIEWED_ACCOUNT_HEADER]: ROBINHOOD_ID },
      payload: JSON.stringify(body),
    });

  function start(): void {
    harness = makeHarness({
      executionMode: PAPER_ONLY,
      adapters: ['robinhood', 'snaptrade'],
      snapTrade: { client: snapTrade, ownerEmail: USER.email },
    });
    harness.db.addUser(USER, TOKEN, ROBINHOOD_ID);
  }

  it('the Robinhood connect and callback are refused, naming the mode, and no session is opened', async () => {
    start();

    for (const [url, body] of [
      ['/api/broker/connect', { force: true }],
      ['/api/broker/callback', { redirectUrl: 'http://127.0.0.1:8788/oauth/callback?code=abc&state=xyz' }],
    ] as const) {
      const response = await post(url, body);
      expect(response.statusCode).toBe(409);
      expect((response.json() as { error: string }).error).toBe(
        `Robinhood cannot be connected from this environment (TRADE_EXECUTION_MODE=${PAPER_ONLY})`
      );
    }
    expect(harness.brokers.existing(ROBINHOOD_ID)).toBeUndefined();
  });

  it('the SnapTrade link and sync are allowed, and only the Alpaca paper account they add counts as paper', async () => {
    start();

    expect((await post('/api/snaptrade/link')).json()).toEqual({ url: PORTAL_URL });
    const sync = await post('/api/snaptrade/sync');
    expect(sync.statusCode).toBe(200);
    expect(sync.json()).toMatchObject({ added: 2 });

    const paperByInstitution = Object.fromEntries(
      (await harness.db.listAccounts(OWNER)).accounts.map(({ account }) => [account.institution, isPaperAccount(account)])
    );
    expect(paperByInstitution).toEqual({ robinhood: false, 'alpaca-paper': true, [LIVE_SLUG.toLowerCase()]: false });
  });
});

describe('TRADE_EXECUTION_MODE in the environment', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const configUnder = async (value: string): Promise<{ tradeExecutionMode: TradeExecutionMode }> => {
    vi.stubEnv('TRADE_EXECUTION_MODE', value);
    vi.resetModules();
    return (await import('../../shared/config.js')).config;
  };

  it.each(TRADE_EXECUTION_MODES)('%s is accepted', async (mode) => {
    expect((await configUnder(mode)).tradeExecutionMode).toBe(mode);
  });

  it('paper_only is one of the modes', () => {
    expect(TRADE_EXECUTION_MODES).toContain(PAPER_ONLY);
  });

  it('a value the parser does not know stops the process at startup', async () => {
    await expect(configUnder('paper')).rejects.toThrow('TRADE_EXECUTION_MODE must be one of');
  });
});
