/**
 * The SnapTrade adapter opens an account row as a session and a broker. The
 * client is a fake: opening an account, and asking whether it is ready, must
 * cost no SnapTrade request.
 */
import { describe, expect, it } from 'vitest';

import { BrokerUnavailableError } from '../../broker/errors.js';
import type { AccountRow } from '../../broker/types.js';
import { createSnapTradeAdapter } from '../adapter.js';
import type { SnapTradeBrokerClient } from '../broker.js';

const SNAPTRADE_ACCOUNT_ID = 'snaptrade-account-1';

const ACCOUNT: AccountRow = {
  id: 'account-1',
  userId: 'user-1',
  adapter: 'snaptrade',
  institution: 'alpaca-paper',
  externalAccountId: SNAPTRADE_ACCOUNT_ID,
  label: 'Alpaca Paper',
  isPaper: true,
  needsReconnect: false,
  adapterData: { connectionId: 'connection-1', institutionSlug: 'ALPACA-PAPER', maskedAccountNumber: null },
};

interface Fake {
  readonly client: SnapTradeBrokerClient;
  /** The account id of every request made. */
  readonly requests: string[];
}

function fakeClient(): Fake {
  const requests: string[] = [];
  const unused = async (): Promise<never> => {
    throw new Error('the adapter made a SnapTrade call the test did not expect');
  };
  const client: SnapTradeBrokerClient = {
    accountInformation: {
      getUserAccountBalance: async ({ accountId }) => {
        requests.push(accountId);
        return { data: [{ currency: { code: 'USD' }, cash: 100, buying_power: 100 }] };
      },
      getAllAccountPositions: unused,
      getUserAccountRecentOrders: unused,
    },
    trading: {
      getUserAccountQuotes: unused,
      placeMlegOrder: unused,
      placeForceOrder: unused,
      cancelOrder: unused,
    },
  };
  return { client, requests };
}

describe('the SnapTrade adapter', () => {
  it('is the snaptrade adapter and prices no option', () => {
    const adapter = createSnapTradeAdapter(fakeClient().client);

    expect(adapter.id).toBe('snaptrade');
    expect(adapter.quotesOptions).toBe(false);
  });

  it('opens an account ready, at no request, with a broker on its SnapTrade account id', async () => {
    const { client, requests } = fakeClient();

    const { session, broker } = createSnapTradeAdapter(client).open(ACCOUNT);
    await expect(session.ensureReady()).resolves.toBeUndefined();
    await expect(session.ensureConnected()).resolves.toBeUndefined();
    expect(session.isConnected()).toBe(true);
    expect(requests).toStrictEqual([]);

    expect(await broker.getAccount()).toStrictEqual({ buyingPowerUsd: 100, portfolioValueUsd: null });
    expect(requests).toStrictEqual([SNAPTRADE_ACCOUNT_ID]);
  });

  it('opens an account whose brokerage login is broken as unavailable', async () => {
    const { session } = createSnapTradeAdapter(fakeClient().client).open({
      ...ACCOUNT,
      needsReconnect: true,
    });

    await expect(session.ensureReady()).rejects.toBeInstanceOf(BrokerUnavailableError);
    await expect(session.ensureConnected()).rejects.toBeInstanceOf(BrokerUnavailableError);
    expect(session.isConnected()).toBe(false);
  });

  it('has no authorization flow to wait on or finish', () => {
    const { session } = createSnapTradeAdapter(fakeClient().client).open(ACCOUNT);

    expect(session.getPendingAuthUrl()).toBeNull();
    expect(session.isAuthPending()).toBe(false);
    expect(() => session.submitAuthCode('code', null)).toThrow(/SnapTrade portal/);
  });

  it('refuses an account with no SnapTrade account id, and one of another adapter', () => {
    const adapter = createSnapTradeAdapter(fakeClient().client);

    expect(() => adapter.open({ ...ACCOUNT, externalAccountId: null })).toThrow(BrokerUnavailableError);
    expect(() => adapter.open({ ...ACCOUNT, adapter: 'robinhood', adapterData: {} })).toThrow(
      BrokerUnavailableError
    );
  });
});
