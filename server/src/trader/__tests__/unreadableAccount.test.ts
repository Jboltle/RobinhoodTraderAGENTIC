/**
 * An account row that cannot be read: a SnapTrade row whose adapter_data is
 * not what the adapter needs. It must never lock its owner out. The session
 * falls back to another of their accounts, the bad one is listed as unusable,
 * and they can select a different account.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { ACCOUNT_CHANGED_CODE, VIEWED_ACCOUNT_HEADER } from '../auth.js';
import { readAccountRows, type AccountIdentityRecord } from '../db.js';
import type { AccountsResponse } from '../server.js';
import { fakeAccount, fakeSnapTradeAccount } from './fakeDb.js';
import { makeHarness, type Harness } from './harness.js';

const OWNER = { id: 'user-owner', email: 'owner@example.com' };
const TOKEN_OWNER = 'token-for-owner';

describe('reading account rows', () => {
  const ROBINHOOD_ROW: AccountIdentityRecord = {
    id: 'account-robinhood',
    userId: OWNER.id,
    adapter: 'robinhood',
    institution: 'robinhood',
    externalAccountId: null,
    label: 'Robinhood',
    isPaper: false,
    needsReconnect: false,
    adapterData: {},
  };
  const PAPER_ROW: AccountIdentityRecord = {
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
  /** adapter_data without the connection id the SnapTrade adapter needs. */
  const BROKEN_PAPER_ROW: AccountIdentityRecord = { ...PAPER_ROW, id: 'account-broken', adapterData: {} };

  it('a selected row that cannot be read falls back to the next readable one', () => {
    // Ordered as the session query orders them: the selected account first.
    const { readable, unreadable } = readAccountRows([BROKEN_PAPER_ROW, ROBINHOOD_ROW, PAPER_ROW]);

    expect(readable[0]?.account).toMatchObject({ id: ROBINHOOD_ROW.id, adapter: 'robinhood' });
    expect(readable.map(({ account }) => account.id)).toEqual([ROBINHOOD_ROW.id, PAPER_ROW.id]);
    expect(unreadable).toEqual([BROKEN_PAPER_ROW]);
  });

  it('keeps each readable account beside the row it was read from, in order', () => {
    const { readable, unreadable } = readAccountRows([PAPER_ROW, ROBINHOOD_ROW]);

    expect(readable.map(({ row }) => row)).toEqual([PAPER_ROW, ROBINHOOD_ROW]);
    expect(readable[0]?.account).toMatchObject({ adapter: 'snaptrade', adapterData: PAPER_ROW.adapterData });
    expect(unreadable).toEqual([]);
  });

  it('answers nothing readable, rather than throwing, when no row can be read', () => {
    expect(readAccountRows([BROKEN_PAPER_ROW])).toEqual({ readable: [], unreadable: [BROKEN_PAPER_ROW] });
  });
});

describe('a selected account whose row cannot be read', () => {
  const ROBINHOOD = fakeAccount('account-robinhood', OWNER.id);
  const BROKEN = fakeSnapTradeAccount('account-broken', OWNER.id);
  const PAPER = fakeSnapTradeAccount('account-paper', OWNER.id);
  const ROBINHOOD_MAX_TRADES = 3;
  const PAPER_MAX_TRADES = 7;

  let harness: Harness;

  const asOwner = (method: 'GET' | 'POST', url: string, body?: unknown, viewedAccountId?: string) =>
    harness.as(TOKEN_OWNER, {
      method,
      url,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(viewedAccountId === undefined ? {} : { [VIEWED_ACCOUNT_HEADER]: viewedAccountId }),
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
  const select = (accountId: string) => asOwner('POST', '/api/accounts/select', { accountId });
  const accounts = async (): Promise<AccountsResponse> =>
    (await asOwner('GET', '/api/accounts')).json() as AccountsResponse;
  const maxTradesPerDay = async (): Promise<number> =>
    ((await asOwner('GET', '/api/settings')).json() as { settings: { maxTradesPerDay: number } }).settings
      .maxTradesPerDay;

  beforeEach(() => {
    harness = makeHarness();
    // The owner's oldest account is Robinhood; the one they selected is the row that breaks.
    harness.db.addUser(OWNER, TOKEN_OWNER, ROBINHOOD.id);
    harness.db.addAccount(BROKEN, { select: true });
    harness.db.addAccount(PAPER);
    harness.db.seedSettings(ROBINHOOD.id, { maxTradesPerDay: ROBINHOOD_MAX_TRADES });
    harness.db.seedSettings(PAPER.id, { maxTradesPerDay: PAPER_MAX_TRADES });
    harness.db.corruptAccount(BROKEN.id);
  });

  it('does not sign the user out: routes answer for another of their own accounts', async () => {
    const settings = await asOwner('GET', '/api/settings');

    expect(settings.statusCode).toBe(200);
    expect(await maxTradesPerDay()).toBe(ROBINHOOD_MAX_TRADES);
    expect((await accounts()).selectedAccountId).toBe(ROBINHOOD.id);
  });

  it('is listed as unusable, apart from the accounts that can be selected', async () => {
    const listed = await accounts();

    expect(listed.unusableAccounts).toEqual([
      { id: BROKEN.id, label: BROKEN.label, institution: BROKEN.institution, isPaper: true },
    ]);
    expect(JSON.stringify(listed.brokers)).not.toContain(BROKEN.id);
    expect(listed.brokers).toMatchObject([
      { adapter: 'robinhood', account: { id: ROBINHOOD.id } },
      { adapter: 'snaptrade', accounts: { [PAPER.id]: { id: PAPER.id } } },
    ]);
  });

  it('lets the user select a different account, which the routes then act on', async () => {
    const response = await select(PAPER.id);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ selectedAccountId: PAPER.id });
    expect((await accounts()).selectedAccountId).toBe(PAPER.id);
    expect(await maxTradesPerDay()).toBe(PAPER_MAX_TRADES);
  });

  it('cannot be selected again: refused, with the selection left where it was', async () => {
    await select(PAPER.id);

    const response = await select(BROKEN.id);

    expect(response.statusCode).toBe(409);
    expect((await accounts()).selectedAccountId).toBe(PAPER.id);
    expect(await maxTradesPerDay()).toBe(PAPER_MAX_TRADES);
  });

  it('a page still showing it is refused on the account, and can still read the list and switch', async () => {
    const stale = await asOwner('GET', '/api/settings', undefined, BROKEN.id);
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: ACCOUNT_CHANGED_CODE });

    const list = await asOwner('GET', '/api/accounts', undefined, BROKEN.id);
    expect(list.statusCode).toBe(200);
    expect((list.json() as AccountsResponse).selectedAccountId).toBe(ROBINHOOD.id);

    const switched = await asOwner('POST', '/api/accounts/select', { accountId: PAPER.id }, BROKEN.id);
    expect(switched.statusCode).toBe(200);
  });
});
