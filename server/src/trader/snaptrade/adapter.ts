/**
 * The SnapTrade adapter: opens a SnapTrade account as the broker port.
 *
 * It takes the SDK client as a parameter and builds nothing, so it reads no
 * environment and a test hands it a fake. trader/adapters.ts registers it
 * when the deployment holds the SnapTrade keys.
 */
import { BrokerUnavailableError } from '../broker/errors.js';
import type { BrokerAdapter, BrokerSession } from '../broker/types.js';
import { SnapTradeBroker, type SnapTradeBrokerClient } from './broker.js';

/**
 * A SnapTrade account has no session of its own: the deployment's key reaches
 * every account, and the brokerage login lives at SnapTrade. So "ready" is
 * what the account's row said when the session was opened, at no request.
 *
 * A snapshot, so the sync route (server.ts), which is what changes the row,
 * drops the account from the registry: its next use opens it from the new row.
 *
 * ponytail: a login that breaks between two syncs is found when an order is
 * refused (HTTP 402); reads keep answering from SnapTrade's cache. Upgrade
 * path: SnapTrade's connection-broken webhook running the same sync.
 */
export class SnapTradeSession implements BrokerSession {
  constructor(private readonly needsReconnect: boolean) {}

  async ensureReady(): Promise<void> {
    if (this.needsReconnect) {
      throw new BrokerUnavailableError(
        'the brokerage login behind this account must be repaired in SnapTrade'
      );
    }
  }

  async ensureConnected(): Promise<void> {
    await this.ensureReady();
  }

  isConnected(): boolean {
    return !this.needsReconnect;
  }

  // The three below are the pasted-code login. SnapTrade connects in its own
  // portal, so none is pending.
  getPendingAuthUrl(): string | null {
    return null;
  }

  isAuthPending(): boolean {
    return false;
  }

  submitAuthCode(): void {
    throw new Error(
      'a SnapTrade account is connected in the SnapTrade portal, not with an authorization code'
    );
  }
}

export function createSnapTradeAdapter(client: SnapTradeBrokerClient): BrokerAdapter {
  return {
    id: 'snaptrade',
    // SnapTrade prices no option contract; marks come from the shared quote source.
    quotesOptions: false,
    open(account) {
      if (account.adapter !== 'snaptrade' || account.externalAccountId === null) {
        throw new BrokerUnavailableError('this account carries no SnapTrade account id');
      }
      return {
        session: new SnapTradeSession(account.needsReconnect),
        broker: new SnapTradeBroker(client, account.externalAccountId),
      };
    },
  };
}
