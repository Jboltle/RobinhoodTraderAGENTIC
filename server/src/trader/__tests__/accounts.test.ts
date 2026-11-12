/**
 * Account switching: GET /api/accounts and POST /api/accounts/select.
 *
 * A user lists and selects only their own accounts. Selecting changes what the
 * per-account routes read and write, and never which accounts trade.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import type { Decision } from '../../shared/types.js';
import { ACCOUNT_CHANGED_CODE, ACCOUNT_NOT_NAMED_CODE, VIEWED_ACCOUNT_HEADER } from '../auth.js';
import type { AccountRow } from '../broker/types.js';
import type { AccountsResponse } from '../server.js';
import { fakeAccount, fakeTokens } from './fakeDb.js';
import { makeHarness, placedOrders, type Harness } from './harness.js';

const OWNER = { id: 'user-owner', email: 'owner@example.com' };
const TOKEN_OWNER = 'token-for-owner';
const ROBINHOOD = fakeAccount('account-robinhood', OWNER.id);
const PAPER: AccountRow = {
  id: 'account-paper',
  userId: OWNER.id,
  adapter: 'snaptrade',
  institution: 'alpaca-paper',
  externalAccountId: 'snaptrade-account-1',
  label: 'Alpaca Paper',
  isPaper: true,
  needsReconnect: false,
  adapterData: { connectionId: 'connection-1', institutionSlug: 'ALPACA-PAPER', maskedAccountNumber: '1234' },
};

const STRANGER = { id: 'user-stranger', email: 'stranger@example.com' };
const TOKEN_STRANGER = 'token-for-stranger';
const STRANGER_ROBINHOOD = fakeAccount('account-stranger', STRANGER.id);

const ROBINHOOD_MAX_TRADES = 4;
const PAPER_MAX_TRADES = 7;

const trade = (orderId: string): Decision => ({
  at: '2026-07-20T14:31:00.000Z',
  messageId: 'msg-shared',
  kind: 'submitted',
  code: null,
  reason: `order ${orderId}`,
  ticker: 'NVDA',
  action: 'buy',
  order: {
    symbol: 'NVDA',
    side: 'buy',
    assetType: 'equity',
    quantity: 1,
    orderType: 'limit',
    limitPrice: 100,
    option: null,
    orderId,
    status: 'queued',
  },
});

/** A sized order parked for approval, as approval mode leaves it. */
const PENDING: Decision = {
  ...trade('unsent'),
  messageId: 'msg-pending',
  kind: 'pending_approval',
  order: { ...trade('unsent').order!, orderId: null, status: null },
};

let harness: Harness;

const asPageShowing = (accountId: string, method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown) =>
  harness.as(TOKEN_OWNER, {
    method,
    url,
    headers: {
      [VIEWED_ACCOUNT_HEADER]: accountId,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
const asOwner = (method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown) =>
  harness.as(TOKEN_OWNER, {
    method,
    url,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) }),
  });
const select = (accountId: unknown) => asOwner('POST', '/api/accounts/select', { accountId });
const accounts = async (): Promise<AccountsResponse> =>
  (await asOwner('GET', '/api/accounts')).json() as AccountsResponse;
const maxTradesPerDay = async (): Promise<number> =>
  ((await asOwner('GET', '/api/settings')).json() as { settings: { maxTradesPerDay: number } }).settings
    .maxTradesPerDay;
const orderIds = async (): Promise<Array<string | null | undefined>> =>
  ((await asOwner('GET', '/api/decisions')).json() as { decisions: Decision[] }).decisions.map(
    (decision) => decision.order?.orderId
  );

beforeEach(() => {
  // A deployment that has an adapter for each of the owner's accounts.
  harness = makeHarness({ adapters: ['robinhood', 'snaptrade'] });
  harness.db.addUser(OWNER, TOKEN_OWNER, ROBINHOOD.id);
  harness.db.addAccount(PAPER);
  harness.db.addUser(STRANGER, TOKEN_STRANGER, STRANGER_ROBINHOOD.id);
  harness.db.seedBrokerTokens(ROBINHOOD.id, fakeTokens('robinhood-token'));
  harness.db.seedBrokerTokens(STRANGER_ROBINHOOD.id, fakeTokens('stranger-token'));
  harness.db.seedSettings(ROBINHOOD.id, {
    maxTradesPerDay: ROBINHOOD_MAX_TRADES,
    executionMode: 'immediate',
    followedCallerIds: ['caller-1', 'caller-2'],
  });
  harness.db.seedSettings(PAPER.id, { maxTradesPerDay: PAPER_MAX_TRADES });
  harness.db.seedDecision(ROBINHOOD.id, trade('robinhood-order'));
  harness.db.seedDecision(PAPER.id, trade('paper-order'));
});

describe('GET /api/accounts', () => {
  it('lists the user\'s accounts by adapter, with the selected one named', async () => {
    const response = await asOwner('GET', '/api/accounts');

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      selectedAccountId: ROBINHOOD.id,
      brokers: [
        {
          adapter: 'robinhood',
          account: {
            id: ROBINHOOD.id,
            label: 'Robinhood',
            institution: 'robinhood',
            isPaper: false,
            connected: true,
            needsReconnect: false,
            executionMode: 'immediate',
            followedCallerCount: 2,
          },
        },
        {
          adapter: 'snaptrade',
          accounts: {
            [PAPER.id]: {
              id: PAPER.id,
              label: 'Alpaca Paper',
              institution: 'alpaca-paper',
              isPaper: true,
              // A SnapTrade account stores no credentials: connected until a sync says otherwise.
              connected: true,
              needsReconnect: false,
              executionMode: 'approval',
              followedCallerCount: 0,
              externalAccountId: 'snaptrade-account-1',
              connectionId: 'connection-1',
            },
          },
        },
      ],
      canConnectSnapTrade: false,
    });
  });

  it('has no SnapTrade entry for a user with only their Robinhood account', async () => {
    const response = await harness.as(TOKEN_STRANGER, { method: 'GET', url: '/api/accounts' });

    const body = response.json() as AccountsResponse;
    expect(body.selectedAccountId).toBe(STRANGER_ROBINHOOD.id);
    expect(body.brokers.map((entry) => entry.adapter)).toEqual(['robinhood']);
  });

  it('never lists another user\'s account', async () => {
    const response = await harness.as(TOKEN_STRANGER, { method: 'GET', url: '/api/accounts' });

    expect(response.body).not.toContain(ROBINHOOD.id);
    expect(response.body).not.toContain(PAPER.id);
    expect(response.body).not.toContain('connection-1');
  });

  it('counts the whole roster for an account that follows every Caller', async () => {
    harness.db.seedSettings(PAPER.id, { followedCallerIds: null });
    for (const authorId of ['caller-1', 'caller-2', 'caller-3']) {
      await harness.db.upsertCaller({
        authorId,
        displayName: authorId,
        avatarUrl: null,
        lastSeenAt: '2026-07-20T14:00:00.000Z',
      });
    }

    const paper = (await accounts()).brokers.flatMap((entry) =>
      entry.adapter === 'snaptrade' ? Object.values(entry.accounts) : []
    );
    expect(paper.map((account) => account.followedCallerCount)).toEqual([3]);
  });

  it('carries the reconnect flag', async () => {
    harness.db.addAccount({ ...PAPER, needsReconnect: true });

    const [entry] = (await accounts()).brokers.filter((candidate) => candidate.adapter === 'snaptrade');
    expect(entry).toMatchObject({ accounts: { [PAPER.id]: { needsReconnect: true } } });
  });

  it('401s without a session', async () => {
    expect((await harness.app.inject({ method: 'GET', url: '/api/accounts' })).statusCode).toBe(401);
  });
});

describe('POST /api/accounts/select', () => {
  it('switches what the settings and trades routes return', async () => {
    expect(await maxTradesPerDay()).toBe(ROBINHOOD_MAX_TRADES);
    expect(await orderIds()).toEqual(['robinhood-order']);

    const response = await select(PAPER.id);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ selectedAccountId: PAPER.id });
    expect((await accounts()).selectedAccountId).toBe(PAPER.id);
    expect(await maxTradesPerDay()).toBe(PAPER_MAX_TRADES);
    expect(await orderIds()).toEqual(['paper-order']);

    await select(ROBINHOOD.id);
    expect(await maxTradesPerDay()).toBe(ROBINHOOD_MAX_TRADES);
    expect(await orderIds()).toEqual(['robinhood-order']);
  });

  it('a settings save after a switch lands on the newly selected account only', async () => {
    await select(PAPER.id);

    await asPageShowing(PAPER.id, 'PUT', '/api/settings', { maxTradesPerDay: 2 });

    expect((await harness.db.getSettings(PAPER.id)).maxTradesPerDay).toBe(2);
    expect((await harness.db.getSettings(ROBINHOOD.id)).maxTradesPerDay).toBe(ROBINHOOD_MAX_TRADES);
  });

  it('does not change which accounts trade', async () => {
    const fanOut = async (): Promise<string[]> =>
      (await harness.db.listConnectedAccounts()).map((account) => account.id);
    const before = await fanOut();
    expect(before).toEqual([ROBINHOOD.id, PAPER.id, STRANGER_ROBINHOOD.id]);

    await select(PAPER.id);
    expect(await fanOut()).toEqual(before);
    expect(await harness.db.getBrokerTokens(ROBINHOOD.id)).not.toBeNull();
    expect(await harness.db.getBrokerTokens(PAPER.id)).toBeNull();

    await select(ROBINHOOD.id);
    expect(await fanOut()).toEqual(before);
  });

  it('refuses another user\'s account exactly as one that does not exist', async () => {
    const foreign = await select(STRANGER_ROBINHOOD.id);
    const unknown = await select('no-such-account');

    expect(foreign.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(foreign.body).toBe(unknown.body);
    // Neither user's view moved.
    expect((await accounts()).selectedAccountId).toBe(ROBINHOOD.id);
    expect(await maxTradesPerDay()).toBe(ROBINHOOD_MAX_TRADES);
    const stranger = await harness.as(TOKEN_STRANGER, { method: 'GET', url: '/api/accounts' });
    expect((stranger.json() as AccountsResponse).selectedAccountId).toBe(STRANGER_ROBINHOOD.id);
  });

  it('a user cannot be switched onto an account by its owner selecting it', async () => {
    await select(PAPER.id);

    const stranger = await harness.as(TOKEN_STRANGER, { method: 'GET', url: '/api/settings' });
    expect((stranger.json() as { settings: { maxTradesPerDay: number } }).settings.maxTradesPerDay).toBe(10);
  });

  it('400s on a body that names no account', async () => {
    for (const body of [{}, { accountId: '' }, { accountId: 7 }, { id: PAPER.id }]) {
      expect((await asOwner('POST', '/api/accounts/select', body)).statusCode).toBe(400);
    }
    expect((await accounts()).selectedAccountId).toBe(ROBINHOOD.id);
  });

  it('401s without a session and selects nothing', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/accounts/select',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ accountId: PAPER.id }),
    });

    expect(response.statusCode).toBe(401);
    expect((await accounts()).selectedAccountId).toBe(ROBINHOOD.id);
  });
});

describe('a selection that does not name one of the user\'s accounts', () => {
  it.each([
    ['another user\'s account', STRANGER_ROBINHOOD.id],
    ['an account that no longer exists', 'account-deleted'],
    ['nothing', null],
  ])('pointing at %s falls back to the user\'s oldest account', async (_name, selection) => {
    harness.db.corruptSelection(OWNER.id, selection);
    harness.db.calls.length = 0;

    expect((await accounts()).selectedAccountId).toBe(ROBINHOOD.id);
    expect(await maxTradesPerDay()).toBe(ROBINHOOD_MAX_TRADES);
    expect(await orderIds()).toEqual(['robinhood-order']);
    for (const call of harness.db.calls) {
      expect(call.scopeId).toBe(ROBINHOOD.id);
    }
  });
});

describe('the Robinhood login while another account is selected', () => {
  const AUTH_URL = 'https://robinhood.com/mcp/trading?state=abc';

  beforeEach(async () => {
    await select(PAPER.id);
  });

  it('connect starts the flow on the direct Robinhood account', async () => {
    harness.configureBroker(ROBINHOOD.id, { authUrl: AUTH_URL });

    const response = await asOwner('POST', '/api/broker/connect', {});

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ connected: false, authUrl: AUTH_URL });
    expect(harness.brokerFor(ROBINHOOD.id).session.ensureConnected).toHaveBeenCalled();
    expect(harness.brokers.existing(PAPER.id)).toBeUndefined();
  });

  it('callback hands the code to the direct Robinhood account\'s session', async () => {
    harness.configureBroker(ROBINHOOD.id, { authPending: true });

    const response = await asOwner('POST', '/api/broker/callback', {
      redirectUrl: 'http://127.0.0.1:8788/oauth/callback?code=the-code&state=the-state',
    });

    expect(response.statusCode).toBe(200);
    expect(harness.brokerFor(ROBINHOOD.id).session.submitAuthCode).toHaveBeenCalledWith('the-code', 'the-state');
    expect(harness.brokers.existing(PAPER.id)).toBeUndefined();
  });

  it('connect is still refused on a read_only deployment', async () => {
    harness = makeHarness({ executionMode: 'read_only' });
    harness.db.addUser(OWNER, TOKEN_OWNER, ROBINHOOD.id);
    harness.db.addAccount(PAPER, { select: true });

    const response = await asOwner('POST', '/api/broker/connect', {});

    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: string }).error).toContain('cannot be connected from this environment');
    expect(harness.brokers.existing(ROBINHOOD.id)).toBeUndefined();
  });

  it('status and the broker routes describe the selected account, by its own name', async () => {
    expect((await asOwner('GET', '/api/broker/status')).json()).toMatchObject({
      connected: false,
      tokenState: 'missing',
    });

    const portfolio = await asOwner('GET', '/api/portfolio');
    expect(portfolio.statusCode).toBe(409);
    expect(portfolio.json()).toEqual({ error: 'Alpaca Paper is not connected' });
  });

  it('disconnect leaves the Robinhood connection alone', async () => {
    const response = await asPageShowing(PAPER.id, 'POST', '/api/broker/disconnect', {});

    expect(response.statusCode).toBe(200);
    expect(await harness.db.getBrokerTokens(ROBINHOOD.id)).not.toBeNull();
  });
});

// A page names the account it is showing on every request (x-viewed-account).
// The header never chooses the account; it only gets a request refused when
// the selection has moved under that page.
describe('a page still showing an account that is no longer selected', () => {
  beforeEach(async () => {
    // Both accounts hold the same callout for approval, as a fan-out leaves them.
    harness.db.seedDecision(ROBINHOOD.id, PENDING);
    harness.db.seedDecision(PAPER.id, PENDING);
    // The page loaded while paper was selected; another tab then switched back.
    await select(PAPER.id);
    await select(ROBINHOOD.id);
  });

  it('cannot save its settings onto the account now selected', async () => {
    const response = await asPageShowing(PAPER.id, 'PUT', '/api/settings', { maxTradesPerDay: 1 });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: ACCOUNT_CHANGED_CODE });
    expect((await harness.db.getSettings(ROBINHOOD.id)).maxTradesPerDay).toBe(ROBINHOOD_MAX_TRADES);
    expect((await harness.db.getSettings(PAPER.id)).maxTradesPerDay).toBe(PAPER_MAX_TRADES);
  });

  it('cannot approve the same callout on the account now selected', async () => {
    const response = await asPageShowing(PAPER.id, 'POST', '/api/trades/msg-pending/approve', {});

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: ACCOUNT_CHANGED_CODE });
    expect(harness.fakeBroker(ROBINHOOD.id).placeOrder).not.toHaveBeenCalled();
    for (const accountId of [ROBINHOOD.id, PAPER.id]) {
      const decisions = await harness.db.decisionsByMessageId(accountId, ['msg-pending']);
      expect(decisions.get('msg-pending')?.kind).toBe('pending_approval');
    }
  });

  it('is refused its reads too, and touches no account doing so', async () => {
    harness.db.calls.length = 0;

    for (const url of ['/api/settings', '/api/decisions', '/api/callouts', '/api/broker/status', '/api/stream']) {
      const response = await asPageShowing(PAPER.id, 'GET', url);
      expect(response.statusCode, url).toBe(409);
      expect(response.body, url).not.toContain('robinhood-order');
    }
    expect(harness.db.calls).toEqual([]);
  });

  it('can still read what is selected now, select, and sign out', async () => {
    const list = await asPageShowing(PAPER.id, 'GET', '/api/accounts');
    expect(list.statusCode).toBe(200);
    expect((list.json() as AccountsResponse).selectedAccountId).toBe(ROBINHOOD.id);

    expect((await asPageShowing('account-long-gone', 'POST', '/api/accounts/select', { accountId: PAPER.id })).statusCode).toBe(200);
    expect((await asPageShowing(ROBINHOOD.id, 'POST', '/api/auth/logout')).statusCode).toBe(200);
  });

  it('a page showing the selected account goes through', async () => {
    const response = await asPageShowing(ROBINHOOD.id, 'PUT', '/api/settings', { maxTradesPerDay: 1 });

    expect(response.statusCode).toBe(200);
    expect((await harness.db.getSettings(ROBINHOOD.id)).maxTradesPerDay).toBe(1);
  });

  it('a read that names no account is not checked', async () => {
    const response = await asOwner('GET', '/api/settings');

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ settings: { maxTradesPerDay: ROBINHOOD_MAX_TRADES } });
  });

  it('naming another user\'s account gets nothing but the refusal', async () => {
    const response = await asPageShowing(STRANGER_ROBINHOOD.id, 'GET', '/api/settings');

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: expect.stringContaining('selected account changed'),
      code: ACCOUNT_CHANGED_CODE,
    });
  });
});

// A page that never learned which account it is showing (its account list
// failed to load, or it runs a bundle from before the header existed) sends no
// x-viewed-account. Whatever it does would land on whichever account is
// selected now, so a request that changes something is refused without it.
describe('a request that changes something, from a page that names no account', () => {
  const ACTIONS = [
    { name: 'approve', method: 'POST', url: '/api/trades/msg-pending/approve', body: {} },
    { name: 'reject', method: 'POST', url: '/api/trades/msg-pending/reject', body: {} },
    { name: 'settings save', method: 'PUT', url: '/api/settings', body: { maxTradesPerDay: 1 } },
    { name: 'disconnect', method: 'POST', url: '/api/broker/disconnect', body: {} },
  ] as const;

  const pendingKind = async (accountId: string): Promise<string | undefined> =>
    (await harness.db.decisionsByMessageId(accountId, ['msg-pending'])).get('msg-pending')?.kind;

  beforeEach(() => {
    // Both accounts hold the same callout for approval, as a fan-out leaves them.
    harness.db.seedDecision(ROBINHOOD.id, PENDING);
    harness.db.seedDecision(PAPER.id, PENDING);
    harness.db.seedBrokerTokens(PAPER.id, fakeTokens('paper-token'));
  });

  for (const action of ACTIONS) {
    it(`${action.name} is refused, and nothing is written or placed`, async () => {
      harness.db.calls.length = 0;

      const response = await asOwner(action.method, action.url, action.body);

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: expect.stringContaining('Reload'),
        code: ACCOUNT_NOT_NAMED_CODE,
      });
      expect(harness.db.calls).toEqual([]);
      for (const account of [ROBINHOOD, PAPER]) {
        expect(await pendingKind(account.id), account.id).toBe('pending_approval');
        expect(await harness.db.getBrokerTokens(account.id), account.id).not.toBeNull();
        expect(harness.brokers.existing(account.id), account.id).toBeUndefined();
      }
      expect((await harness.db.getSettings(ROBINHOOD.id)).maxTradesPerDay).toBe(ROBINHOOD_MAX_TRADES);
      expect((await harness.db.getSettings(PAPER.id)).maxTradesPerDay).toBe(PAPER_MAX_TRADES);
    });
  }

  it('each goes through once the page names the selected account', async () => {
    const settings = await asPageShowing(ROBINHOOD.id, 'PUT', '/api/settings', { maxTradesPerDay: 1 });
    expect(settings.statusCode).toBe(200);
    expect((await harness.db.getSettings(ROBINHOOD.id)).maxTradesPerDay).toBe(1);

    const approve = await asPageShowing(ROBINHOOD.id, 'POST', '/api/trades/msg-pending/approve', {});
    expect(approve.statusCode).toBe(200);
    expect(await pendingKind(ROBINHOOD.id)).toBe('submitted');

    harness.db.seedDecision(ROBINHOOD.id, { ...PENDING, messageId: 'msg-other' });
    const reject = await asPageShowing(ROBINHOOD.id, 'POST', '/api/trades/msg-other/reject', {});
    expect(reject.statusCode).toBe(200);
    expect((await harness.db.decisionsByMessageId(ROBINHOOD.id, ['msg-other'])).get('msg-other')?.kind).toBe('rejected');

    const disconnect = await asPageShowing(ROBINHOOD.id, 'POST', '/api/broker/disconnect', {});
    expect(disconnect.statusCode).toBe(200);
    expect(await harness.db.getBrokerTokens(ROBINHOOD.id)).toBeNull();
  });

  it('with both accounts pending on one callout, approve acts on the named and selected one only', async () => {
    const response = await asPageShowing(ROBINHOOD.id, 'POST', '/api/trades/msg-pending/approve', {});

    expect(response.statusCode).toBe(200);
    expect(placedOrders(harness.fakeBroker(ROBINHOOD.id), 'equity')).toHaveLength(1);
    expect(await pendingKind(ROBINHOOD.id)).toBe('submitted');
    expect(await pendingKind(PAPER.id)).toBe('pending_approval');
    expect(harness.brokers.existing(PAPER.id)).toBeUndefined();

    // The same page, once paper is selected elsewhere: the paper row is not approved through it.
    await select(PAPER.id);
    const stale = await asPageShowing(ROBINHOOD.id, 'POST', '/api/trades/msg-pending/approve', {});
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: ACCOUNT_CHANGED_CODE });
    expect(await pendingKind(PAPER.id)).toBe('pending_approval');
    expect(harness.brokers.existing(PAPER.id)).toBeUndefined();
  });

  it('the Robinhood login, selecting and signing out need not name one', async () => {
    harness.configureBroker(ROBINHOOD.id, { connected: true });

    expect((await asOwner('POST', '/api/broker/connect', {})).statusCode).toBe(200);
    expect((await asOwner('POST', '/api/broker/callback', { redirectUrl: 'not a url' })).statusCode).toBe(400);
    expect((await select(PAPER.id)).statusCode).toBe(200);
    expect((await asOwner('POST', '/api/auth/logout')).statusCode).toBe(200);
  });
});
