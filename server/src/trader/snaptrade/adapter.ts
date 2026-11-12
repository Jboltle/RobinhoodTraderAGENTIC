/**
 * The SnapTrade adapter: opens a SnapTrade account as the broker port.
 *
 * It takes the SDK client as a parameter and builds nothing, so it reads no
 * environment and a test hands it a fake.
 *
 * Not registered yet. `UserBroker.session` (broker/types.ts) is the Robinhood
 * session class, which no other session can be, so this cannot be typed as a
 * BrokerAdapter. Once that field is an interface of the six methods on
 * SnapTradeSession, `createSnapTradeAdapter` returns a BrokerAdapter as it
 * stands and SnapTradeAdapter below goes.
 */
import { BrokerUnavailableError } from '../broker/errors.js';
import type { AccountRow, Broker, BrokerAdapter } from '../broker/types.js';
import { SnapTradeBroker, type SnapTradeBrokerClient } from './broker.js';

/**
 * A SnapTrade account has no session of its own: the deployment's key reaches
 * every account, and the brokerage login lives at SnapTrade. So "ready" is
 * what the account's row said when the session was opened, at no request.
 *
 * ponytail: a snapshot. A login that breaks afterwards is found when an order
 * is refused (HTTP 402); reads keep answering from SnapTrade's cache. Upgrade
 * path: the sync drops the account from the registry when `needsReconnect`
 * changes, so the next use opens it from the new row.
 */
export class SnapTradeSession {
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

  // The three below are Robinhood's pasted-code OAuth, which the session type
  // still asks for. SnapTrade connects in its own portal, so none is pending.
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

export interface OpenedSnapTradeAccount {
  readonly session: SnapTradeSession;
  readonly broker: Broker;
}

export interface SnapTradeAdapter extends Omit<BrokerAdapter, 'open'> {
  open(account: AccountRow): OpenedSnapTradeAccount;
}

export function createSnapTradeAdapter(client: SnapTradeBrokerClient): SnapTradeAdapter {
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
