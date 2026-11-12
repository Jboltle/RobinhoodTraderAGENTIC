/**
 * A SnapTrade account wired in: the real SnapTrade adapter, registered through
 * the registry, over a fake of the SDK client that records every call. So each
 * test can say what a path asks of SnapTrade, and how many requests it costs
 * against the 10 a minute an account is allowed.
 *
 * The SnapTrade account here stores no credentials, as a real one does not.
 * No test builds the SDK client: nothing here can reach SnapTrade.
 */
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import type { AccountPosition, AllAccountPositionsResponse } from 'snaptrade-typescript-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  TradeSettingsSchema,
  type CalloutParser,
  type Decision,
  type TradeExecutionMode,
  type TradeSettings,
} from '../../shared/types.js';
import { deployedAdapters } from '../adapters.js';
import { VIEWED_ACCOUNT_HEADER } from '../auth.js';
import { BrokerUnavailableError, BrokerWritesDisabledError } from '../broker/errors.js';
import { createQuoteSource } from '../broker/quotes.js';
import { createMcpRegistry, supportedAccounts, type McpRegistry } from '../broker/registry.js';
import { METERED_DASHBOARD_READ_INTERVAL_MS, METERED_ORDER_READ_INTERVAL_MS } from '../broker/requestBudget.js';
import type { AccountRow, BrokerSession, OptionInstrument } from '../broker/types.js';
import { TraderEvents } from '../events.js';
import { FILL_POLL_ACTIVE_MS, sweepFills } from '../fills.js';
import { sweepLadders } from '../ladderMonitor.js';
import { resolveOptionEntry, sweepMaxLoss, warnOfUnprotectedAccounts } from '../maxLoss.js';
import {
  BTO_QQQ_PUT,
  TRIM_QQQ_FIRST,
  envelopeFromFixture,
  type DiscordMessageFixture,
} from '../pipeline/__tests__/fixtures/discordMessages.js';
import { createMessageProcessor } from '../pipeline/index.js';
import { buildServer } from '../server.js';
import { createSnapTradeAdapter } from '../snaptrade/adapter.js';
import {
  createSnapTrade,
  type SnapTradeAccess,
  type SnapTradeAccount,
  type SnapTradeConnection,
} from '../snaptrade/client.js';
import {
  callNames,
  fakeSnapTradeClient,
  type FakeSnapTradeAnswers,
  type FakeSnapTradeClient,
} from '../snaptrade/__tests__/fakeClient.js';
import { optionOrder, optionOrderPlaced, optionPosition } from '../snaptrade/__tests__/fixtures/unverified.js';
import { createFakeDb, fakeAccount, fakeSnapTradeAccount, fakeTokens, type FakeDb } from './fakeDb.js';
import { makeFakeBroker, placedOrders, type FakeBroker } from './harness.js';

/** Tuesday 2026-09-08 10:30 ET: inside regular US hours, when the monitors sweep. */
const NOW = new Date('2026-09-08T14:30:00.000Z');

const OWNER = { id: 'user-owner', email: 'owner@example.com' };
const TOKEN = 'token-for-owner';
const ROBINHOOD = fakeAccount('account-robinhood', OWNER.id);
/** Connected by its row alone: nothing is stored under it. */
const PAPER = fakeSnapTradeAccount('account-paper', OWNER.id);
/** SnapTrade's own id for the account (fakeSnapTradeAccount's): what every request must name. */
const PAPER_SNAPTRADE_ID = `external-${PAPER.id}`;
/** The same owner's SnapTrade account at a live broker: real money, so never a paper account. */
const LIVE: AccountRow = {
  id: 'account-live',
  userId: OWNER.id,
  adapter: 'snaptrade',
  institution: 'schwab',
  externalAccountId: 'external-account-live',
  label: 'Schwab Individual',
  isPaper: false,
  needsReconnect: false,
  adapterData: { connectionId: 'connection-2', institutionSlug: 'SCHWAB', maskedAccountNumber: '9876' },
};

/** Auto-executing and following everyone, with the calendar guards relaxed. */
const TRADING: TradeSettings = {
  executionMode: 'immediate',
  followedCallerIds: null,
  regularHoursOnly: false,
  cooldownSeconds: 0,
};

/** Near the callouts' strikes, so the entry check has nothing to hold a callout for. */
const QQQ_SPOT = 710;
const PLACED_ORDER_ID = 'option-order-1';

const BALANCE_READ = 'accountInformation.getUserAccountBalance';
const POSITIONS_READ = 'accountInformation.getAllAccountPositions';
const ORDERS_READ = 'accountInformation.getUserAccountRecentOrders';
const OPTION_ORDER = 'trading.placeMlegOrder';

const BALANCES = [{ currency: { code: 'USD' }, cash: 10_000, buying_power: 10_000 }];
/** Two of the contract the trim callout closes, held at SnapTrade. */
const HELD_QQQ_CALL = optionPosition(
  { units: '2' },
  {
    symbol: 'QQQ   260611C00707000',
    option_type: 'CALL',
    strike_price: '707',
    expiration_date: '2026-06-11',
    underlying: { kind: 'etf', id: 'symbol-qqq', symbol: 'QQQ', raw_symbol: 'QQQ', currency: 'USD' },
  }
);

const held = (...results: AccountPosition[]): AllAccountPositionsResponse => ({
  results,
  data_freshness: { as_of: '2026-06-11T14:00:00Z' },
});

/** What a Robinhood login in progress offers; a SnapTrade account must never be handed it. */
const ROBINHOOD_AUTH_URL = 'https://robinhood.example/authorize';
const ROBINHOOD_SESSION: BrokerSession = {
  ensureReady: async () => undefined,
  ensureConnected: async () => undefined,
  isConnected: () => true,
  getPendingAuthUrl: () => ROBINHOOD_AUTH_URL,
  isAuthPending: () => false,
  submitAuthCode: () => undefined,
};

interface World {
  readonly db: FakeDb;
  readonly events: TraderEvents;
  readonly brokers: McpRegistry;
  /** The SDK client behind the SnapTrade adapter. */
  readonly sdk: FakeSnapTradeClient;
  readonly robinhoodBroker: FakeBroker;
}

interface WorldOptions {
  readonly mode?: TradeExecutionMode;
  readonly answers?: FakeSnapTradeAnswers;
  /** The SnapTrade account's own settings, over TRADING. */
  readonly paperSettings?: TradeSettings;
}

/** A Robinhood account with stored tokens and, beside it, a SnapTrade account with none. */
function makeWorld(options: WorldOptions = {}): World {
  const db = createFakeDb();
  db.addUser(OWNER, TOKEN, ROBINHOOD.id);
  db.seedBrokerTokens(ROBINHOOD.id, fakeTokens('robinhood-token'));
  db.seedSettings(ROBINHOOD.id, TRADING);
  db.addAccount(PAPER);
  db.seedSettings(PAPER.id, { ...TRADING, ...options.paperSettings });

  const robinhoodBroker = makeFakeBroker({ equityMark: QQQ_SPOT, optionMark: null });
  const sdk = fakeSnapTradeClient({
    balances: BALANCES,
    optionOrder: optionOrderPlaced(),
    ...options.answers,
  });
  const brokers = createMcpRegistry(
    [
      { id: 'robinhood', quotesOptions: true, open: () => ({ session: ROBINHOOD_SESSION, broker: robinhoodBroker }) },
      createSnapTradeAdapter(sdk.client),
    ],
    options.mode ?? 'immediate'
  );
  return { db, events: new TraderEvents(), brokers, sdk, robinhoodBroker };
}

async function processCallout(world: World, fixture: DiscordMessageFixture, mode: TradeExecutionMode): Promise<void> {
  const { db, events, brokers } = world;
  const parser: CalloutParser = { parse: vi.fn(async () => fixture.expectedCallout) };
  const processor = createMessageProcessor({
    parser,
    db,
    events,
    brokers,
    quotes: createQuoteSource({ db, brokers }),
    executionMode: mode,
  });
  await processor.process(envelopeFromFixture(fixture));
}

type Request = (options: InjectOptions) => Promise<LightMyRequestResponse>;

/** The dashboard's routes, signed in as the owner. */
/** The dashboard's server over the world, with `viewed` the account its owner has selected. */
function serverOver(
  world: World,
  viewed: AccountRow,
  snapTrade: SnapTradeAccess | null = null,
  mode: TradeExecutionMode = 'immediate'
): FastifyInstance {
  const { db, events, brokers } = world;
  db.addAccount(viewed, { select: true });
  return buildServer({ db, events, brokers, executionMode: mode, snapTrade });
}

function serve(
  world: World,
  viewed: AccountRow = PAPER,
  snapTrade: SnapTradeAccess | null = null,
  mode: TradeExecutionMode = 'immediate'
): Request {
  const app = serverOver(world, viewed, snapTrade, mode);
  return (options) =>
    app.inject({
      ...options,
      headers: { ...options.headers, authorization: `Bearer ${TOKEN}`, [VIEWED_ACCOUNT_HEADER]: viewed.id },
    });
}

/** The contract the SnapTrade order fixture (optionOrder) is for. */
const SPY_CALL: OptionInstrument = {
  kind: 'option',
  symbol: 'SPY',
  optionType: 'call',
  strike: 772,
  expiration: '2026-10-21',
};
const SPY_CALL_CONTRACTS = 3;

/** An option buy the account placed that the broker has not been seen to fill yet. */
function workingBuy(orderType: 'market' | 'limit', limitPrice: number | null, messageId = 'msg-working'): Decision {
  return {
    at: NOW.toISOString(),
    messageId,
    kind: 'submitted',
    code: null,
    reason: 'bought',
    ticker: SPY_CALL.symbol,
    action: 'buy',
    order: {
      symbol: SPY_CALL.symbol,
      side: 'buy',
      assetType: 'option',
      quantity: SPY_CALL_CONTRACTS,
      orderType,
      limitPrice,
      option: { optionType: SPY_CALL.optionType, strike: SPY_CALL.strike, expiration: SPY_CALL.expiration },
      orderId: PLACED_ORDER_ID,
      status: 'accepted',
    },
  };
}

const decisionsOf = async (db: FakeDb, accountId: string): Promise<Decision[]> => db.listDecisions(accountId, 10);

describe('which deployments have the SnapTrade adapter', () => {
  it('nothing is built while any of the three settings is absent', () => {
    const keys = { clientId: 'id', consumerKey: 'key', ownerEmail: OWNER.email };

    expect(createSnapTrade({ ...keys, clientId: null })).toBeNull();
    expect(createSnapTrade({ ...keys, consumerKey: null })).toBeNull();
    expect(createSnapTrade({ ...keys, ownerEmail: null })).toBeNull();
  });

  it('without a client the deployment is as before: Robinhood alone, the SnapTrade account left out', async () => {
    const { db } = makeWorld();
    const adapters = deployedAdapters(db, null);
    const brokers = createMcpRegistry(adapters, 'immediate');

    expect(adapters.map((adapter) => adapter.id)).toEqual(['robinhood']);
    expect(brokers.supports(PAPER)).toBe(false);
    expect((await supportedAccounts(db, brokers)).map((account) => account.id)).toEqual([ROBINHOOD.id]);
  });

  it('with a client the SnapTrade account is one this deployment acts on', async () => {
    const { db, sdk } = makeWorld();
    const adapters = deployedAdapters(db, sdk.client);
    const brokers = createMcpRegistry(adapters, 'immediate');

    expect(adapters.map((adapter) => adapter.id)).toEqual(['robinhood', 'snaptrade']);
    expect(brokers.supports(PAPER)).toBe(true);
    expect((await supportedAccounts(db, brokers)).map((account) => account.id)).toEqual([ROBINHOOD.id, PAPER.id]);
    expect(sdk.calls).toEqual([]);
  });
});

describe('a callout, with a SnapTrade account beside the Robinhood one', () => {
  it('an entry is placed on both, on SnapTrade through the adapter, for two requests', async () => {
    const world = makeWorld();

    await processCallout(world, BTO_QQQ_PUT, 'immediate');

    expect(placedOrders(world.robinhoodBroker, 'option')).toHaveLength(1);
    expect(callNames(world.sdk)).toEqual([BALANCE_READ, OPTION_ORDER]);
    expect(world.sdk.calls[1]![1]).toMatchObject({
      accountId: PAPER_SNAPTRADE_ID,
      order_type: 'LIMIT',
      limit_price: '0.97',
      legs: [{ instrument: { symbol: 'QQQ   260608P00710000' }, action: 'BUY_TO_OPEN' }],
    });
    expect(await decisionsOf(world.db, PAPER.id)).toMatchObject([
      { kind: 'submitted', order: { side: 'buy', orderId: PLACED_ORDER_ID, status: 'pending' } },
    ]);
  });

  it('an exit reads the positions and places the sell: two requests', async () => {
    const world = makeWorld({ answers: { positions: held(HELD_QQQ_CALL) } });

    await processCallout(world, TRIM_QQQ_FIRST, 'immediate');

    expect(callNames(world.sdk)).toEqual([POSITIONS_READ, OPTION_ORDER]);
    expect(world.sdk.calls[1]![1]).toMatchObject({
      accountId: PAPER_SNAPTRADE_ID,
      order_type: 'MARKET',
      legs: [{ instrument: { symbol: 'QQQ   260611C00707000' }, action: 'SELL_TO_CLOSE' }],
    });
    expect(await decisionsOf(world.db, PAPER.id)).toMatchObject([{ kind: 'submitted', order: { side: 'sell' } }]);
  });

  it('an entry held for approval is sized and not placed: one request', async () => {
    const world = makeWorld({ paperSettings: { executionMode: 'approval' } });

    await processCallout(world, BTO_QQQ_PUT, 'immediate');

    expect(callNames(world.sdk)).toEqual([BALANCE_READ]);
    expect(await decisionsOf(world.db, PAPER.id)).toMatchObject([{ kind: 'pending_approval' }]);
  });
});

describe('a read_only deployment with the SnapTrade adapter', () => {
  it('a callout places nothing at SnapTrade', async () => {
    const world = makeWorld({ mode: 'read_only' });

    await processCallout(world, BTO_QQQ_PUT, 'read_only');

    expect(callNames(world.sdk)).not.toContain(OPTION_ORDER);
    expect(await decisionsOf(world.db, PAPER.id)).toMatchObject([{ kind: 'pending_approval' }]);
  });

  it('the registry hands the SnapTrade account a broker that refuses the write before the SDK is reached', async () => {
    const { brokers, sdk } = makeWorld({ mode: 'read_only' });
    const { broker } = brokers.for(PAPER);

    await expect(
      broker.placeOrder({
        instrument: { kind: 'option', symbol: 'QQQ', optionType: 'put', strike: 710, expiration: '2026-06-08' },
        side: 'buy',
        quantity: 1,
        type: 'market',
      })
    ).rejects.toBeInstanceOf(BrokerWritesDisabledError);
    await expect(broker.cancelOrder(PLACED_ORDER_ID)).rejects.toBeInstanceOf(BrokerWritesDisabledError);

    expect(sdk.calls).toEqual([]);
  });
});

/**
 * What staging runs: the paper account beside a Robinhood account and a
 * SnapTrade account at a live broker, each set to trade at once.
 */
describe('a paper_only deployment with the SnapTrade adapter', () => {
  const PAPER_ONLY: TradeExecutionMode = 'paper_only';
  const HELD = `Held by TRADE_EXECUTION_MODE=${PAPER_ONLY}`;
  const SNAPTRADE_WRITES = [OPTION_ORDER, 'trading.placeForceOrder', 'trading.cancelOrder'];

  function makePaperOnlyWorld(options: WorldOptions = {}): World {
    const world = makeWorld({ ...options, mode: PAPER_ONLY });
    world.db.addAccount(LIVE);
    world.db.seedSettings(LIVE.id, { ...TRADING, ...options.paperSettings });
    return world;
  }

  /** The calls made to SnapTrade naming the account, in order. */
  const requestsFor = (world: World, account: AccountRow): string[] =>
    world.sdk.calls
      .filter(([, sent]) => (sent as { accountId?: string }).accountId === account.externalAccountId)
      .map(([name]) => name);

  const expectNoWriteButPaper = (world: World): void => {
    for (const write of SNAPTRADE_WRITES) expect(requestsFor(world, LIVE)).not.toContain(write);
    expect(world.robinhoodBroker.placeOrder).not.toHaveBeenCalled();
    expect(world.robinhoodBroker.cancelOrder).not.toHaveBeenCalled();
  };

  it('an entry is placed on the paper account alone; the others are held by the deployment', async () => {
    const world = makePaperOnlyWorld();

    await processCallout(world, BTO_QQQ_PUT, PAPER_ONLY);

    expect(requestsFor(world, PAPER)).toEqual([BALANCE_READ, OPTION_ORDER]);
    expect(await decisionsOf(world.db, PAPER.id)).toMatchObject([{ kind: 'submitted', order: { side: 'buy' } }]);
    expectNoWriteButPaper(world);
    for (const account of [LIVE, ROBINHOOD]) {
      const [decision] = await decisionsOf(world.db, account.id);
      expect(decision).toMatchObject({ kind: 'pending_approval' });
      expect(decision!.reason).toContain(HELD);
    }
  });

  it("the Caller's exit is placed on the paper account alone", async () => {
    const world = makePaperOnlyWorld({ answers: { positions: held(HELD_QQQ_CALL) } });

    await processCallout(world, TRIM_QQQ_FIRST, PAPER_ONLY);

    expect(requestsFor(world, PAPER)).toEqual([POSITIONS_READ, OPTION_ORDER]);
    expect(await decisionsOf(world.db, PAPER.id)).toMatchObject([{ kind: 'submitted', order: { side: 'sell' } }]);
    expectNoWriteButPaper(world);
    expect((await decisionsOf(world.db, LIVE.id)).map((decision) => decision.kind)).not.toContain('submitted');
  });

  it('Max Loss, the stop rest and the own-target ladder ask nothing of SnapTrade and place nothing anywhere', async () => {
    const MESSAGE_ID = 'msg-filled-lot';
    const protect: TradeSettings = { maxLossPct: 50, exitMode: 'ladder', trimLevels: [{ gainPct: 50, portionPct: 50 }] };
    const world = makePaperOnlyWorld({ paperSettings: protect });
    world.db.seedSettings(ROBINHOOD.id, { ...TRADING, ...protect });
    world.db.seedMessage({ messageId: MESSAGE_ID, sentAt: NOW.toISOString() });
    for (const account of [PAPER, LIVE, ROBINHOOD]) {
      world.db.seedDecision(account.id, {
        ...workingBuy('limit', 1.6, MESSAGE_ID),
        order: { ...workingBuy('limit', 1.6).order!, orderId: 'filled-buy', status: 'filled', averageFillPrice: 1.59 },
      });
    }
    // Something still open, so the fill sweep has work and reaches the stop rest.
    world.db.seedDecision(ROBINHOOD.id, workingBuy('limit', 1.6));
    const { db, brokers, events } = world;

    await sweepMaxLoss({ db, brokers, events, enqueue: (_accountId, run) => run(), now: () => NOW }, new Map());
    await sweepFills({ db, brokers, events, executionMode: PAPER_ONLY, now: () => NOW });
    expect(await sweepLadders({ db, brokers, events, executionMode: PAPER_ONLY })).toBe(0);

    expect(world.sdk.calls).toEqual([]);
    expectNoWriteButPaper(world);
  });
});

describe('the dashboard routes, viewing a SnapTrade account that stores no credentials', () => {
  const PENDING_MESSAGE_ID = 'msg-pending';
  const pendingEntry: Decision = {
    at: '2026-06-09T14:27:00.000Z',
    messageId: PENDING_MESSAGE_ID,
    kind: 'pending_approval',
    code: null,
    reason: 'awaiting approval',
    ticker: 'QQQ',
    action: 'buy',
    order: {
      symbol: 'QQQ',
      side: 'buy',
      assetType: 'option',
      quantity: 1,
      orderType: 'limit',
      limitPrice: 0.97,
      option: BTO_QQQ_PUT.expectedCallout.option!,
      orderId: null,
      status: null,
    },
  };
  const NOT_CONNECTED = { error: `${PAPER.label} is not connected` };
  const approve = (request: Request): Promise<LightMyRequestResponse> =>
    request({ method: 'POST', url: `/api/trades/${PENDING_MESSAGE_ID}/approve` });

  it('status says connected, as the account list does, and offers no Robinhood login', async () => {
    const world = makeWorld();
    // A Robinhood login is in progress on the same user's other account.
    world.brokers.for(ROBINHOOD);
    const request = serve(world);

    expect((await request({ method: 'GET', url: '/api/broker/status' })).json()).toMatchObject({
      connected: true,
      tokenState: 'valid',
      authUrl: null,
    });
    expect((await request({ method: 'GET', url: '/api/accounts' })).json()).toMatchObject({
      brokers: [{ adapter: 'robinhood' }, { adapter: 'snaptrade', accounts: { [PAPER.id]: { connected: true } } }],
    });
    expect(world.sdk.calls).toEqual([]);
  });

  it('the Robinhood account beside it is still offered its own login', async () => {
    const world = makeWorld();
    world.brokers.for(ROBINHOOD);

    const status = await serve(world, ROBINHOOD)({ method: 'GET', url: '/api/broker/status' });

    expect(status.json()).toMatchObject({ connected: true, authUrl: ROBINHOOD_AUTH_URL });
  });

  it('its warm session survives every read', async () => {
    const world = makeWorld({ answers: { positions: held(), orders: { orders: [] } } });
    const warm = world.brokers.for(PAPER);
    const request = serve(world);

    for (const url of ['/api/broker/status', '/api/portfolio', '/api/trades/performance', '/api/broker/status']) {
      expect((await request({ method: 'GET', url })).statusCode).toBe(200);
    }

    expect(world.brokers.existing(PAPER.id)).toBe(warm);
  });

  it('portfolio and performance read its SnapTrade account', async () => {
    const world = makeWorld({ answers: { positions: held(HELD_QQQ_CALL), orders: { orders: [] } } });
    const request = serve(world);

    const portfolio = await request({ method: 'GET', url: '/api/portfolio' });
    const performance = await request({ method: 'GET', url: '/api/trades/performance' });

    expect(portfolio.json()).toEqual({ portfolioValueUsd: null, buyingPowerUsd: 10_000, openPositions: 1 });
    expect(performance.json()).toMatchObject({
      positions: [{ assetType: 'option', symbol: 'QQQ', quantity: 2, strike: 707, currentPrice: null }],
    });
    for (const [, sent] of world.sdk.calls) expect(sent).toMatchObject({ accountId: PAPER_SNAPTRADE_ID });
  });

  it('Approve places the sized order at SnapTrade, for one request', async () => {
    const world = makeWorld();
    world.db.seedDecision(PAPER.id, pendingEntry);

    const response = await approve(serve(world));

    expect(response.statusCode).toBe(200);
    expect(callNames(world.sdk)).toEqual([OPTION_ORDER]);
    expect(world.sdk.calls[0]![1]).toMatchObject({ accountId: PAPER_SNAPTRADE_ID, limit_price: '0.97' });
    expect(await decisionsOf(world.db, PAPER.id)).toMatchObject([
      { kind: 'submitted', order: { orderId: PLACED_ORDER_ID } },
    ]);
  });

  it('under paper_only, Approve places the paper account\'s order with no credentials stored for it', async () => {
    const world = makeWorld({ mode: 'paper_only' });
    world.db.seedDecision(PAPER.id, pendingEntry);

    const response = await approve(serve(world, PAPER, null, 'paper_only'));

    expect(await world.db.getBrokerTokens(PAPER.id)).toBeNull();
    expect(response.statusCode).toBe(200);
    expect(world.sdk.calls).toMatchObject([[OPTION_ORDER, { accountId: PAPER_SNAPTRADE_ID }]]);
    expect(await decisionsOf(world.db, PAPER.id)).toMatchObject([{ kind: 'submitted' }]);
  });

  it.each([
    ['a SnapTrade account at a live broker', LIVE],
    ['the Robinhood account', ROBINHOOD],
  ])('under paper_only, Approve is refused for %s: it is not a paper account', async (_name, account) => {
    const world = makeWorld({ mode: 'paper_only' });
    world.db.addAccount(account);
    world.db.seedDecision(account.id, pendingEntry);

    const response = await approve(serve(world, account, null, 'paper_only'));

    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: string }).error).toMatch(/paper_only.*not a paper account/);
    expect((await decisionsOf(world.db, account.id))[0]!.kind).toBe('pending_approval');
    expect(world.sdk.calls).toEqual([]);
    expect(world.robinhoodBroker.placeOrder).not.toHaveBeenCalled();
  });

  it.each([
    ['its brokerage login is broken', (db: FakeDb) => db.addAccount({ ...PAPER, needsReconnect: true })],
    ['it was disconnected', (db: FakeDb) => db.deleteBrokerTokens(PAPER.id)],
  ])('when %s it is not connected: status, portfolio, performance and Approve all say so', async (_why, sever) => {
    const world = makeWorld();
    world.db.seedDecision(PAPER.id, pendingEntry);
    const request = serve(world);
    await sever(world.db);

    expect((await request({ method: 'GET', url: '/api/broker/status' })).json()).toMatchObject({
      connected: false,
      tokenState: 'missing',
      authUrl: null,
    });
    for (const url of ['/api/portfolio', '/api/trades/performance']) {
      const response = await request({ method: 'GET', url });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual(NOT_CONNECTED);
    }
    const approved = await approve(request);
    expect(approved.statusCode).toBe(409);
    expect(approved.json()).toEqual(NOT_CONNECTED);
    expect((await decisionsOf(world.db, PAPER.id))[0]!.kind).toBe('pending_approval');
    expect(world.sdk.calls).toEqual([]);
  });
});

describe('a sync that changes a SnapTrade account row', () => {
  const CONNECTION: SnapTradeConnection = {
    id: PAPER.adapterData.connectionId,
    brokerageSlug: 'ALPACA-PAPER',
    brokerageName: 'Alpaca Paper',
    type: 'trade',
    disabled: false,
  };
  const LISTED: SnapTradeAccount = {
    id: PAPER_SNAPTRADE_ID,
    connectionId: CONNECTION.id,
    displayName: 'Individual',
    maskedAccountNumber: '1234',
    isPaper: true,
  };

  /** What SnapTrade lists right now; a test changes it between syncs. */
  interface Listing {
    connections: SnapTradeConnection[];
    accounts: SnapTradeAccount[];
  }

  function syncing(world: World, listing: Listing): () => Promise<void> {
    const request = serve(world, PAPER, {
      ownerEmail: OWNER.email,
      client: {
        portalLink: async () => 'https://app.snaptrade.com/portal',
        listConnections: async () => listing.connections,
        listAccounts: async () => listing.accounts,
      },
    });
    return async () => {
      const response = await request({ method: 'POST', url: '/api/snaptrade/sync' });
      expect(response.statusCode).toBe(200);
    };
  }

  /** The account's session as its next user gets it: from the row as stored now. */
  const sessionNow = (world: World): BrokerSession => world.brokers.for(world.db.account(PAPER.id)).session;

  it('drops the cached broker, so a login found broken stops the next use and a repaired one resumes it', async () => {
    const world = makeWorld();
    const listing: Listing = { connections: [CONNECTION], accounts: [LISTED] };
    const sync = syncing(world, listing);
    const opened = world.brokers.for(PAPER);
    await expect(opened.session.ensureReady()).resolves.toBeUndefined();

    listing.connections = [{ ...CONNECTION, disabled: true }];
    await sync();

    expect(world.brokers.existing(PAPER.id)).toBeUndefined();
    await expect(sessionNow(world).ensureReady()).rejects.toBeInstanceOf(BrokerUnavailableError);

    listing.connections = [CONNECTION];
    await sync();

    expect(world.brokers.existing(PAPER.id)).toBeUndefined();
    await expect(sessionNow(world).ensureReady()).resolves.toBeUndefined();
    expect(world.sdk.calls).toEqual([]);
  });

  it('an account SnapTrade no longer lists is dropped too, and takes no callout', async () => {
    const world = makeWorld();
    const sync = syncing(world, { connections: [], accounts: [] });
    world.brokers.for(PAPER);

    await sync();
    await processCallout(world, BTO_QQQ_PUT, 'immediate');

    expect(world.brokers.existing(PAPER.id)).toBeUndefined();
    expect(world.sdk.calls).toEqual([]);
    expect(placedOrders(world.robinhoodBroker, 'option')).toHaveLength(1);
  });

  it('leaves the Robinhood session alone', async () => {
    const world = makeWorld();
    const robinhood = world.brokers.for(ROBINHOOD);

    await syncing(world, { connections: [CONNECTION], accounts: [LISTED] })();

    expect(world.brokers.existing(ROBINHOOD.id)).toBe(robinhood);
  });
});

describe('prices that come from SnapTrade are per share already', () => {
  /** A market fill at a 25.00 premium: above the 20 the Robinhood scale fix divides by 100. */
  const FILLED_AT_25 = { orders: [optionOrder({ execution_price: '25.00', order_type: 'Market', limit_price: null })] };

  it('a market option order filled at 25.00 is recorded as 25.00', async () => {
    const world = makeWorld({ answers: { orders: FILLED_AT_25 } });
    world.db.seedDecision(PAPER.id, workingBuy('market', null));

    await sweepFills({ db: world.db, brokers: world.brokers, events: world.events, now: () => NOW });

    expect((await decisionsOf(world.db, PAPER.id))[0]!.order).toMatchObject({
      status: 'filled',
      filledQuantity: SPY_CALL_CONTRACTS,
      averageFillPrice: 25,
    });
  });

  it('the same fill reported by Robinhood is still read as 0.25', async () => {
    const db = createFakeDb();
    db.addUser(OWNER, TOKEN, ROBINHOOD.id);
    db.seedBrokerTokens(ROBINHOOD.id, fakeTokens('robinhood-token'));
    db.seedDecision(ROBINHOOD.id, workingBuy('market', null));
    const reported = makeFakeBroker({
      orders: [
        {
          orderId: PLACED_ORDER_ID,
          instrument: SPY_CALL,
          side: 'buy',
          status: 'filled',
          fillPrice: 25,
          quantity: SPY_CALL_CONTRACTS,
          createdAt: NOW.toISOString(),
        },
      ],
    });
    const brokers = createMcpRegistry(
      [{ id: 'robinhood', quotesOptions: true, open: () => ({ session: ROBINHOOD_SESSION, broker: reported }) }],
      'immediate'
    );

    await sweepFills({ db, brokers, events: new TraderEvents(), now: () => NOW });

    expect((await decisionsOf(db, ROBINHOOD.id))[0]!.order).toMatchObject({ status: 'filled', averageFillPrice: 0.25 });
  });

  it('an entry rebuilt from its orders is the 25.00 paid, where an unmarked order would read 0.25', async () => {
    const world = makeWorld({ answers: { orders: FILLED_AT_25 } });

    const orders = await world.brokers.for(PAPER).broker.getOrders();
    const unmarked = (orders ?? []).map(({ fillPricePerShare: _perShare, ...order }) => order);

    expect(resolveOptionEntry([], [], SPY_CALL, SPY_CALL_CONTRACTS, orders, null)).toBe(25);
    expect(resolveOptionEntry([], [], SPY_CALL, SPY_CALL_CONTRACTS, unmarked, null)).toBe(0.25);
  });
});

describe('the request budget of a SnapTrade account', () => {
  const ONE_MINUTE_MS = 60_000;
  const MAX_LOSS: TradeSettings = { ...TRADING, maxLossPct: 50 };
  /** The working order as SnapTrade lists it until it fills. */
  const WORKING = {
    orders: [optionOrder({ status: 'ACCEPTED', filled_quantity: '0', open_quantity: '3', execution_price: null })],
  };
  /** A filled option buy still held: what Max Loss, the stop rest and the ladder act on. */
  const FILLED_LOT_MESSAGE_ID = 'msg-filled-lot';
  const filledLot: Decision = {
    ...workingBuy('limit', 1.6, FILLED_LOT_MESSAGE_ID),
    order: { ...workingBuy('limit', 1.6).order!, orderId: 'filled-buy', status: 'filled', averageFillPrice: 1.59 },
  };

  const requestsOf = (world: World, call: string): number => callNames(world.sdk).filter((name) => name === call).length;

  /** Sweeps as the fill monitor does while an order is open: every FILL_POLL_ACTIVE_MS, for `durationMs`. */
  async function sweepFor(world: World, durationMs: number, mode: TradeExecutionMode = 'immediate'): Promise<void> {
    const orderReadAt = new Map<string, number>();
    for (let elapsed = 0; elapsed < durationMs; elapsed += FILL_POLL_ACTIVE_MS) {
      const at = new Date(NOW.getTime() + elapsed);
      await sweepFills(
        { db: world.db, brokers: world.brokers, events: world.events, executionMode: mode, now: () => at },
        undefined,
        orderReadAt
      );
    }
  }

  describe('the fill monitor', () => {
    it(`reads its orders every ${METERED_ORDER_READ_INTERVAL_MS / 1000} s while one is working: four requests a minute`, async () => {
      const world = makeWorld({ answers: { orders: WORKING } });
      world.db.seedDecision(PAPER.id, workingBuy('limit', 1.6));
      world.db.seedDecision(ROBINHOOD.id, workingBuy('limit', 1.6));

      await sweepFor(world, ONE_MINUTE_MS);

      expect(callNames(world.sdk)).toEqual([ORDERS_READ, ORDERS_READ, ORDERS_READ, ORDERS_READ]);
      // The Robinhood account beside it is read on every sweep, as before.
      expect(world.robinhoodBroker.getOrders).toHaveBeenCalledTimes(ONE_MINUTE_MS / FILL_POLL_ACTIVE_MS);
    });

    it('still records the fill, on the first read that shows it', async () => {
      const world = makeWorld({ answers: { orders: WORKING } });
      world.db.seedDecision(PAPER.id, workingBuy('limit', 1.6));

      await sweepFor(world, METERED_ORDER_READ_INTERVAL_MS);
      expect((await decisionsOf(world.db, PAPER.id))[0]!.order!.status).toBe('accepted');
      world.sdk.answers.orders = { orders: [optionOrder()] };
      await sweepFor(world, FILL_POLL_ACTIVE_MS);

      expect((await decisionsOf(world.db, PAPER.id))[0]!.order).toMatchObject({ status: 'filled', averageFillPrice: 1.59 });
    });

    it('reads nothing while it has no order working, whatever the other accounts have open', async () => {
      const world = makeWorld({ answers: { orders: WORKING } });
      world.db.seedDecision(ROBINHOOD.id, workingBuy('limit', 1.6));

      await sweepFor(world, ONE_MINUTE_MS);

      expect(world.sdk.calls).toEqual([]);
      expect(world.robinhoodBroker.getOrders).toHaveBeenCalled();
    });

    it('rests no stop on it, and still rests the Robinhood one', async () => {
      const world = makeWorld({ answers: { orders: WORKING }, paperSettings: MAX_LOSS });
      world.db.seedSettings(ROBINHOOD.id, MAX_LOSS);
      world.db.seedMessage({ messageId: FILLED_LOT_MESSAGE_ID, sentAt: NOW.toISOString() });
      for (const account of [PAPER, ROBINHOOD]) world.db.seedDecision(account.id, filledLot);
      // Something still open, so the sweep has work and reaches the stop rest.
      world.db.seedDecision(ROBINHOOD.id, workingBuy('limit', 1.6));

      await sweepFor(world, FILL_POLL_ACTIVE_MS);

      expect(placedOrders(world.robinhoodBroker, 'option')).toMatchObject([{ side: 'sell', type: 'stop' }]);
      expect(world.sdk.calls).toEqual([]);
    });
  });

  describe('the sweeps that would read it on a timer', () => {
    afterEach(() => vi.restoreAllMocks());

    it('Max Loss leaves it out, and still scans the Robinhood account', async () => {
      const world = makeWorld({ paperSettings: MAX_LOSS });
      world.db.seedSettings(ROBINHOOD.id, MAX_LOSS);
      const queued: string[] = [];

      await sweepMaxLoss(
        {
          db: world.db,
          brokers: world.brokers,
          events: world.events,
          enqueue: (accountId, run) => {
            queued.push(accountId);
            return run();
          },
          now: () => NOW,
        },
        new Map()
      );

      expect(queued).toEqual([ROBINHOOD.id]);
      expect(world.robinhoodBroker.getPositions).toHaveBeenCalled();
      expect(world.sdk.calls).toEqual([]);
    });

    it('the own-target ladder costs it nothing and sells nothing: its broker prices no option', async () => {
      const world = makeWorld({
        paperSettings: { ...TRADING, exitMode: 'ladder', trimLevels: [{ gainPct: 50, portionPct: 50 }] },
      });
      world.db.seedMessage({ messageId: FILLED_LOT_MESSAGE_ID, sentAt: NOW.toISOString() });
      world.db.seedDecision(PAPER.id, filledLot);

      const placed = await sweepLadders({
        db: world.db,
        brokers: world.brokers,
        events: world.events,
        executionMode: 'immediate',
      });

      expect(placed).toBe(0);
      expect(world.sdk.calls).toEqual([]);
    });

    it('the monitor says so once per account when it starts, with what the account asked for', async () => {
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const world = makeWorld({ paperSettings: { ...MAX_LOSS, exitMode: 'ladder' } });
      world.db.seedSettings(ROBINHOOD.id, MAX_LOSS);

      await warnOfUnprotectedAccounts(world);

      const warnings = stderr.mock.calls
        .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
        .filter((line) => line.level === 'warn');
      expect(warnings).toMatchObject([
        { accountId: PAPER.id, adapter: 'snaptrade', maxLossPct: 50, exitMode: 'ladder' },
      ]);
      expect(warnings).toHaveLength(1);
      expect(world.sdk.calls).toEqual([]);
    });
  });

  describe('the dashboard', () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    const DASHBOARD = { positions: held(HELD_QQQ_CALL), orders: { orders: [] } };
    /** One read of the header and one of the positions table: what an open dashboard costs per interval. */
    const ONE_DASHBOARD_READ = [BALANCE_READ, POSITIONS_READ, POSITIONS_READ, ORDERS_READ];
    const POLLS = 3;

    async function poll(request: Request): Promise<void> {
      for (let polled = 0; polled < POLLS; polled += 1) {
        for (const url of ['/api/portfolio', '/api/trades/performance']) {
          expect((await request({ method: 'GET', url })).statusCode).toBe(200);
        }
      }
    }

    it('however often it polls, SnapTrade is read once per interval', async () => {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW.getTime());
      const world = makeWorld({ answers: DASHBOARD });
      const request = serve(world);

      await poll(request);
      clock.mockReturnValue(NOW.getTime() + METERED_DASHBOARD_READ_INTERVAL_MS - 1);
      await poll(request);
      expect(callNames(world.sdk).sort()).toEqual([...ONE_DASHBOARD_READ].sort());

      clock.mockReturnValue(NOW.getTime() + METERED_DASHBOARD_READ_INTERVAL_MS);
      await poll(request);
      expect(callNames(world.sdk).sort()).toEqual([...ONE_DASHBOARD_READ, ...ONE_DASHBOARD_READ].sort());
    });

    it('a Robinhood account is still read on every poll', async () => {
      const world = makeWorld();

      await poll(serve(world, ROBINHOOD));

      expect(world.robinhoodBroker.getAccount).toHaveBeenCalledTimes(POLLS);
    });

    it('a failed read is not made again within the interval either', async () => {
      const world = makeWorld({ answers: { failure: new Error('SnapTrade is down') } });
      const request = serve(world);

      for (let polled = 0; polled < POLLS; polled += 1) {
        expect((await request({ method: 'GET', url: '/api/portfolio' })).statusCode).toBe(503);
      }

      expect(callNames(world.sdk).sort()).toEqual([BALANCE_READ, POSITIONS_READ].sort());
    });

    it('the live stream ticks every 10 s without asking SnapTrade again', async () => {
      const STREAM_TICK_MS = 10_000;
      const world = makeWorld({ answers: DASHBOARD });
      const app = serverOver(world, PAPER);
      await app.listen({ port: 0, host: '127.0.0.1' });
      const { port } = app.server.address() as { port: number };
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const abort = new AbortController();

      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/stream`, {
          signal: abort.signal,
          headers: { authorization: `Bearer ${TOKEN}` },
        });
        const reader = response.body!.getReader();
        let frames = '';
        while (!frames.includes('event: performance')) {
          const { value, done } = await reader.read();
          if (done) throw new Error('stream ended early');
          frames += new TextDecoder().decode(value);
        }
        expect(frames).toContain('"strike":707');

        for (let elapsed = 0; elapsed < ONE_MINUTE_MS; elapsed += STREAM_TICK_MS) {
          await vi.advanceTimersByTimeAsync(STREAM_TICK_MS);
        }

        expect(callNames(world.sdk).sort()).toEqual([ORDERS_READ, POSITIONS_READ].sort());
      } finally {
        abort.abort();
        vi.useRealTimers();
        await app.close();
      }
    }, 10_000);
  });
});
