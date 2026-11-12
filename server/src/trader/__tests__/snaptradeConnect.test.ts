/**
 * Connecting other brokers through SnapTrade: the portal link and the sync.
 *
 * SnapTrade here is a fake held by the test. The real client is built only in
 * trader/index.ts, so nothing in this file can reach SnapTrade.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { TradeSettings } from '../../shared/types.js';
import { ACCOUNT_CHANGED_CODE, ACCOUNT_NOT_NAMED_CODE, VIEWED_ACCOUNT_HEADER } from '../auth.js';
import { supportedAccounts } from '../broker/registry.js';
import type { AccountRow } from '../broker/types.js';
import type { AccountsResponse, SnapTradeSyncResponse } from '../server.js';
import {
  createSnapTradeAccess,
  type SnapTradeAccount,
  type SnapTradeClient,
  type SnapTradeConnection,
} from '../snaptrade/client.js';
import { planSnapTradeSync } from '../snaptrade/sync.js';
import { fakeAccount, fakeSnapTradeAccount, fakeTokens } from './fakeDb.js';
import { makeHarness, type Harness } from './harness.js';

const OWNER = { id: 'user-owner', email: 'owner@example.com' };
const TOKEN_OWNER = 'token-for-owner';
const ROBINHOOD = fakeAccount('account-robinhood', OWNER.id);

const FRIEND = { id: 'user-friend', email: 'friend@example.com' };
const TOKEN_FRIEND = 'token-for-friend';
const FRIEND_ROBINHOOD = fakeAccount('account-friend', FRIEND.id);

const PORTAL_URL = 'https://app.snaptrade.com/snapTrade/redeemToken?token=one-time';
const OWNER_SETTINGS: TradeSettings = {
  executionMode: 'immediate',
  maxTradesPerDay: 4,
  followedCallerIds: ['caller-1', 'caller-2'],
};

const connection = (id: string, slug: string, name: string, extra: Partial<SnapTradeConnection> = {}): SnapTradeConnection => ({
  id,
  brokerageSlug: slug,
  brokerageName: name,
  type: 'trade',
  disabled: false,
  ...extra,
});
const account = (id: string, connectionId: string, extra: Partial<SnapTradeAccount> = {}): SnapTradeAccount => ({
  id,
  connectionId,
  displayName: 'Individual',
  maskedAccountNumber: '1234',
  isPaper: false,
  ...extra,
});

const ALPACA = connection('conn-alpaca', 'ALPACA-PAPER', 'Alpaca Paper');
const ALPACA_ACCOUNT = account('st-alpaca-1', ALPACA.id, { isPaper: true });
const SCHWAB_READ = connection('conn-schwab', 'SCHWAB', 'Schwab', { type: 'read' });
const SANDBOX = connection('conn-sandbox', 'SANDBOX', 'SnapTrade Sandbox');

interface FakeSnapTrade extends SnapTradeClient {
  readonly portalLink: Mock<SnapTradeClient['portalLink']>;
  /** What SnapTrade lists right now; a test changes it between syncs. */
  connections: SnapTradeConnection[];
  accounts: SnapTradeAccount[];
  /** Makes the next reads fail, as an outage or a rate limit does. */
  failing: boolean;
}

function fakeSnapTrade(): FakeSnapTrade {
  const fake: FakeSnapTrade = {
    connections: [],
    accounts: [],
    failing: false,
    portalLink: vi.fn<SnapTradeClient['portalLink']>(async () => PORTAL_URL),
    listConnections: async () => {
      if (fake.failing) throw new Error('SnapTrade is down');
      return fake.connections;
    },
    listAccounts: async () => {
      if (fake.failing) throw new Error('SnapTrade is down');
      return fake.accounts;
    },
  };
  return fake;
}

let snapTrade: FakeSnapTrade;
let harness: Harness;

function start(options: { executionMode?: 'immediate' | 'read_only'; keys?: boolean; ownerEmail?: string } = {}): void {
  snapTrade = fakeSnapTrade();
  harness = makeHarness({
    executionMode: options.executionMode ?? 'immediate',
    ...(options.keys === false
      ? {}
      : { snapTrade: { client: snapTrade, ownerEmail: options.ownerEmail ?? OWNER.email } }),
  });
  harness.db.addUser(OWNER, TOKEN_OWNER, ROBINHOOD.id);
  harness.db.addUser(FRIEND, TOKEN_FRIEND, FRIEND_ROBINHOOD.id);
  harness.db.seedBrokerTokens(ROBINHOOD.id, fakeTokens('robinhood-token'));
  harness.db.seedSettings(ROBINHOOD.id, OWNER_SETTINGS);
}

const post = (url: string, body: unknown = {}, token = TOKEN_OWNER, viewed: string | null = ROBINHOOD.id) =>
  harness.as(token, {
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...(viewed === null ? {} : { [VIEWED_ACCOUNT_HEADER]: viewed }) },
    payload: JSON.stringify(body),
  });
const link = (body: unknown = {}) => post('/api/snaptrade/link', body);
const sync = async (): Promise<SnapTradeSyncResponse> => {
  const response = await post('/api/snaptrade/sync');
  expect(response.statusCode).toBe(200);
  return response.json() as SnapTradeSyncResponse;
};
const listed = async (token = TOKEN_OWNER): Promise<AccountsResponse> =>
  (await harness.as(token, { method: 'GET', url: '/api/accounts' })).json() as AccountsResponse;
const snapTradeRows = async (): Promise<AccountRow[]> =>
  (await harness.db.listAccounts(OWNER.id)).accounts
    .map((listing) => listing.account)
    .filter((row) => row.adapter === 'snaptrade');
const fanOut = async (): Promise<string[]> =>
  (await harness.db.listConnectedAccounts()).map((row) => row.id);

beforeEach(() => start());

describe('who may connect another broker', () => {
  it('the owner is offered it; another user is not, and is refused on both routes', async () => {
    expect((await listed()).canConnectSnapTrade).toBe(true);
    expect((await listed(TOKEN_FRIEND)).canConnectSnapTrade).toBe(false);

    for (const url of ['/api/snaptrade/link', '/api/snaptrade/sync']) {
      const refused = await post(url, {}, TOKEN_FRIEND, FRIEND_ROBINHOOD.id);
      expect(refused.statusCode).toBe(403);
    }
    expect(snapTrade.portalLink).not.toHaveBeenCalled();
    expect(await harness.db.listAccounts(FRIEND.id)).toMatchObject({ accounts: [{ account: { id: FRIEND_ROBINHOOD.id } }] });
  });

  it('the owner email is compared without regard to case', async () => {
    start({ ownerEmail: 'Owner@Example.COM' });

    expect((await listed()).canConnectSnapTrade).toBe(true);
    expect((await link()).statusCode).toBe(200);
  });

  it('a deployment without the keys offers it to no one and refuses both routes', async () => {
    start({ keys: false });

    expect((await listed()).canConnectSnapTrade).toBe(false);
    expect((await link()).statusCode).toBe(403);
    expect((await post('/api/snaptrade/sync')).statusCode).toBe(403);
  });

  it('no client is built while any of the three settings is absent', () => {
    const keys = { clientId: 'id', consumerKey: 'key', ownerEmail: OWNER.email };

    expect(createSnapTradeAccess({ ...keys, clientId: null })).toBeNull();
    expect(createSnapTradeAccess({ ...keys, consumerKey: null })).toBeNull();
    expect(createSnapTradeAccess({ ...keys, ownerEmail: null })).toBeNull();
  });

  it('both routes must name the viewed account, like every other change', async () => {
    for (const url of ['/api/snaptrade/link', '/api/snaptrade/sync']) {
      const unnamed = await post(url, {}, TOKEN_OWNER, null);
      expect(unnamed.json()).toMatchObject({ code: ACCOUNT_NOT_NAMED_CODE });
      const stale = await post(url, {}, TOKEN_OWNER, 'account-shown-by-an-old-tab');
      expect(stale.json()).toMatchObject({ code: ACCOUNT_CHANGED_CODE });
    }
    expect(snapTrade.portalLink).not.toHaveBeenCalled();
    expect(await snapTradeRows()).toEqual([]);
  });
});

describe('POST /api/snaptrade/link', () => {
  it('answers a fresh portal link for any broker, and tells caches not to keep it', async () => {
    const response = await link();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ url: PORTAL_URL });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(snapTrade.portalLink).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it('repairs one connection when it is the connection of one of the user\'s own accounts', async () => {
    harness.db.addAccount(fakeSnapTradeAccount('account-paper', OWNER.id));

    expect((await link({ reconnect: 'connection-1' })).statusCode).toBe(200);
    expect(snapTrade.portalLink).toHaveBeenCalledExactlyOnceWith('connection-1');
  });

  it('refuses a connection that is not one of the user\'s own, without asking SnapTrade', async () => {
    harness.db.addAccount(fakeSnapTradeAccount('account-friend-paper', FRIEND.id));

    expect((await link({ reconnect: 'connection-1' })).statusCode).toBe(404);
    expect((await link({ reconnect: 42 })).statusCode).toBe(400);
    expect(snapTrade.portalLink).not.toHaveBeenCalled();
  });

  it('answers 502, with nothing of the failure in it, when SnapTrade issues no link', async () => {
    snapTrade.portalLink.mockRejectedValueOnce(new Error('signature rejected for key abc'));

    const response = await link();

    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain('abc');
  });
});

describe('POST /api/snaptrade/sync', () => {
  it('adds one account per trading account, in approval mode, with the viewed account\'s other settings', async () => {
    snapTrade.connections = [ALPACA];
    snapTrade.accounts = [ALPACA_ACCOUNT];

    expect(await sync()).toEqual({
      added: 1,
      updated: 0,
      disconnected: 0,
      skippedReadOnlyConnections: 0,
      skippedSandboxConnections: 0,
      connectionsAwaitingAccounts: 0,
    });

    const [row] = await snapTradeRows();
    expect(row).toMatchObject({
      userId: OWNER.id,
      adapter: 'snaptrade',
      institution: 'alpaca-paper',
      externalAccountId: ALPACA_ACCOUNT.id,
      label: 'Alpaca Paper · Individual (…1234)',
      isPaper: true,
      needsReconnect: false,
      adapterData: { connectionId: ALPACA.id, institutionSlug: 'ALPACA-PAPER', maskedAccountNumber: '1234' },
    });
    expect(await harness.db.getSettings(row!.id)).toMatchObject({ ...OWNER_SETTINGS, executionMode: 'approval' });
    // The account it copied from is as it was.
    expect(await harness.db.getSettings(ROBINHOOD.id)).toMatchObject(OWNER_SETTINGS);
  });

  it('leaves out read-only connections and the SnapTrade sandbox', async () => {
    snapTrade.connections = [SCHWAB_READ, SANDBOX];
    snapTrade.accounts = [account('st-schwab-1', SCHWAB_READ.id), account('st-sandbox-1', SANDBOX.id), account('st-sandbox-2', SANDBOX.id)];

    expect(await sync()).toMatchObject({ added: 0, skippedReadOnlyConnections: 1, skippedSandboxConnections: 1 });
    expect(await snapTradeRows()).toEqual([]);
  });

  it('is safe to repeat: the second run adds nothing and leaves the account\'s settings alone', async () => {
    snapTrade.connections = [ALPACA];
    snapTrade.accounts = [ALPACA_ACCOUNT, ALPACA_ACCOUNT];
    await sync();
    const [row] = await snapTradeRows();
    await harness.db.saveSettings(row!.id, { executionMode: 'immediate', maxTradesPerDay: 9 });
    // The viewed account changes afterwards; an existing account must not follow it.
    await harness.db.saveSettings(ROBINHOOD.id, { ...OWNER_SETTINGS, maxTradesPerDay: 1 });

    expect(await sync()).toMatchObject({ added: 0, updated: 1, disconnected: 0 });

    expect((await snapTradeRows()).map((found) => found.id)).toEqual([row!.id]);
    expect(await harness.db.getSettings(row!.id)).toMatchObject({ executionMode: 'immediate', maxTradesPerDay: 9 });
  });

  it('marks a broken brokerage login as needing reconnect, and takes it out of the fan-out', async () => {
    snapTrade.connections = [ALPACA];
    snapTrade.accounts = [ALPACA_ACCOUNT];
    await sync();
    const [row] = await snapTradeRows();
    expect(await fanOut()).toEqual([ROBINHOOD.id, row!.id]);

    snapTrade.connections = [{ ...ALPACA, disabled: true }];
    await sync();

    expect((await snapTradeRows())[0]).toMatchObject({ id: row!.id, needsReconnect: true });
    expect(await fanOut()).toEqual([ROBINHOOD.id]);
    expect((await listed()).brokers[1]).toMatchObject({ accounts: { [row!.id]: { connected: false, needsReconnect: true } } });

    snapTrade.connections = [ALPACA];
    await sync();
    expect(await fanOut()).toEqual([ROBINHOOD.id, row!.id]);
  });

  it('marks an account SnapTrade no longer lists as disconnected, and never deletes it', async () => {
    snapTrade.connections = [ALPACA];
    snapTrade.accounts = [ALPACA_ACCOUNT, account('st-alpaca-2', ALPACA.id, { displayName: 'Roth', maskedAccountNumber: '9876' })];
    await sync();
    const [kept, gone] = await snapTradeRows();

    snapTrade.accounts = [ALPACA_ACCOUNT];
    expect(await sync()).toMatchObject({ added: 0, updated: 1, disconnected: 1 });
    // Counted once: a second run finds it already disconnected.
    expect(await sync()).toMatchObject({ disconnected: 0 });

    expect((await snapTradeRows()).map((found) => found.id)).toEqual([kept!.id, gone!.id]);
    expect(await fanOut()).toEqual([ROBINHOOD.id, kept!.id]);
    expect((await listed()).brokers[1]).toMatchObject({
      accounts: { [kept!.id]: { connected: true }, [gone!.id]: { connected: false } },
    });
  });

  it('an account whose whole connection is gone is disconnected too', async () => {
    snapTrade.connections = [ALPACA];
    snapTrade.accounts = [ALPACA_ACCOUNT];
    await sync();

    snapTrade.connections = [];
    // The daily account list may still carry the account for a while.
    expect(await sync()).toMatchObject({ disconnected: 1 });
    expect(await fanOut()).toEqual([ROBINHOOD.id]);
  });

  it('an account that comes back from disconnected waits for approval, with its other settings kept', async () => {
    snapTrade.connections = [ALPACA];
    snapTrade.accounts = [ALPACA_ACCOUNT];
    await sync();
    const [row] = await snapTradeRows();
    await harness.db.saveSettings(row!.id, { executionMode: 'immediate', maxTradesPerDay: 9 });
    snapTrade.accounts = [];
    await sync();

    snapTrade.accounts = [ALPACA_ACCOUNT];
    expect(await sync()).toMatchObject({ added: 0, updated: 1 });

    expect(await fanOut()).toEqual([ROBINHOOD.id, row!.id]);
    expect(await harness.db.getSettings(row!.id)).toMatchObject({ executionMode: 'approval', maxTradesPerDay: 9 });
  });

  it('says when a connection\'s accounts are not listed yet, instead of calling it done', async () => {
    snapTrade.connections = [ALPACA];
    snapTrade.accounts = [];

    expect(await sync()).toMatchObject({ added: 0, connectionsAwaitingAccounts: 1 });
  });

  it('changes nothing when SnapTrade cannot be read', async () => {
    snapTrade.connections = [ALPACA];
    snapTrade.accounts = [ALPACA_ACCOUNT];
    await sync();
    const before = await fanOut();

    snapTrade.failing = true;
    const response = await post('/api/snaptrade/sync');

    expect(response.statusCode).toBe(502);
    expect(await fanOut()).toEqual(before);
  });

  it('never touches the Robinhood account, or another user\'s accounts', async () => {
    harness.db.addAccount(fakeSnapTradeAccount('account-friend-paper', FRIEND.id));
    const robinhoodBefore = (await harness.db.listAccounts(OWNER.id)).accounts[0];

    snapTrade.connections = [ALPACA];
    snapTrade.accounts = [ALPACA_ACCOUNT];
    await sync();
    snapTrade.accounts = [];
    await sync();

    expect((await harness.db.listAccounts(OWNER.id)).accounts[0]).toEqual(robinhoodBefore);
    expect(await harness.db.getBrokerTokens(ROBINHOOD.id)).not.toBeNull();
    expect((await harness.db.listAccounts(FRIEND.id)).accounts).toMatchObject([
      { account: { id: FRIEND_ROBINHOOD.id } },
      { account: { id: 'account-friend-paper' }, connected: true },
    ]);
  });

  it('a connected SnapTrade account is listed with its connection, and left out of what this deployment trades', async () => {
    snapTrade.connections = [ALPACA];
    snapTrade.accounts = [ALPACA_ACCOUNT];
    await sync();
    const [row] = await snapTradeRows();

    // The harness registry holds the Robinhood adapter alone, as every deployment does today.
    expect((await listed()).brokers[1]).toMatchObject({ accounts: { [row!.id]: { connected: true, executionMode: 'approval' } } });
    expect((await supportedAccounts(harness.db, harness.brokers)).map((found) => found.id)).toEqual([ROBINHOOD.id]);
  });
});

describe('a read_only deployment', () => {
  beforeEach(() => start({ executionMode: 'read_only' }));

  it('allows the SnapTrade link and sync: neither places an order', async () => {
    snapTrade.connections = [ALPACA];
    snapTrade.accounts = [ALPACA_ACCOUNT];

    expect((await link()).json()).toEqual({ url: PORTAL_URL });
    expect(await sync()).toMatchObject({ added: 1 });
    expect((await listed()).canConnectSnapTrade).toBe(true);
  });

  it('still refuses the Robinhood connect and callback', async () => {
    for (const [url, body] of [
      ['/api/broker/connect', {}],
      ['/api/broker/callback', { redirectUrl: 'http://127.0.0.1:8788/oauth/callback?code=abc' }],
    ] as const) {
      const response = await post(url, body);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: expect.stringContaining('read_only') });
    }
    expect(harness.brokers.existing(ROBINHOOD.id)).toBeUndefined();
  });
});

describe('planSnapTradeSync', () => {
  it('names accounts so two at one broker can be told apart, with or without a number', () => {
    const plan = planSnapTradeSync(
      [ALPACA],
      [
        account('a', ALPACA.id, { displayName: 'Individual', maskedAccountNumber: '****1234' }),
        account('b', ALPACA.id, { displayName: '  ', maskedAccountNumber: null }),
      ]
    );

    expect(plan.rows.map((row) => row.label)).toEqual(['Alpaca Paper · Individual (…1234)', 'Alpaca Paper · Account']);
  });

  it('skips an account whose connection is not listed', () => {
    expect(planSnapTradeSync([ALPACA], [account('orphan', 'conn-unknown')]).rows).toEqual([]);
  });
});
