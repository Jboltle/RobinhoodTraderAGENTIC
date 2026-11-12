/**
 * A SnapTrade account wired in: the real SnapTrade adapter, registered through
 * the registry, over a fake of the SDK client that records every call. So each
 * test can say what a path asks of SnapTrade, and how many requests it costs
 * against the 10 a minute an account is allowed.
 *
 * The SnapTrade account here stores no credentials, as a real one does not.
 * No test builds the SDK client: nothing here can reach SnapTrade.
 */
import type { AccountPosition, AllAccountPositionsResponse } from 'snaptrade-typescript-sdk';
import { describe, expect, it, vi } from 'vitest';

import { type CalloutParser, type Decision, type TradeExecutionMode, type TradeSettings } from '../../shared/types.js';
import { deployedAdapters } from '../adapters.js';
import { BrokerWritesDisabledError } from '../broker/errors.js';
import { createQuoteSource } from '../broker/quotes.js';
import { createMcpRegistry, supportedAccounts, type McpRegistry } from '../broker/registry.js';
import type { BrokerSession } from '../broker/types.js';
import { TraderEvents } from '../events.js';
import {
  BTO_QQQ_PUT,
  TRIM_QQQ_FIRST,
  envelopeFromFixture,
  type DiscordMessageFixture,
} from '../pipeline/__tests__/fixtures/discordMessages.js';
import { createMessageProcessor } from '../pipeline/index.js';
import { createSnapTradeAdapter } from '../snaptrade/adapter.js';
import { createSnapTrade } from '../snaptrade/client.js';
import {
  callNames,
  fakeSnapTradeClient,
  type FakeSnapTradeAnswers,
  type FakeSnapTradeClient,
} from '../snaptrade/__tests__/fakeClient.js';
import { optionOrderPlaced, optionPosition } from '../snaptrade/__tests__/fixtures/unverified.js';
import { createFakeDb, fakeAccount, fakeSnapTradeAccount, fakeTokens, type FakeDb } from './fakeDb.js';
import { makeFakeBroker, placedOrders, type FakeBroker } from './harness.js';

const OWNER = { id: 'user-owner', email: 'owner@example.com' };
const TOKEN = 'token-for-owner';
const ROBINHOOD = fakeAccount('account-robinhood', OWNER.id);
/** Connected by its row alone: nothing is stored under it. */
const PAPER = fakeSnapTradeAccount('account-paper', OWNER.id);
/** SnapTrade's own id for the account: what every request must name. */
const PAPER_SNAPTRADE_ID = PAPER.externalAccountId;

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

const ROBINHOOD_SESSION: BrokerSession = {
  ensureReady: async () => undefined,
  ensureConnected: async () => undefined,
  isConnected: () => true,
  getPendingAuthUrl: () => null,
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
