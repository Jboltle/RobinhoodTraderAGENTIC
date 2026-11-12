/**
 * One broker session — and one Broker over it — per account.
 *
 * Each account is its own authorization at its own broker, so a shared client
 * would place every account's orders on whichever happened to authorize first.
 * Holding the clients here also keeps each account's pending OAuth flow
 * separate, so two people can connect at the same time.
 */
import { createLogger } from '../../shared/logger.js';
import type { TradeExecutionMode } from '../../shared/types.js';
import type { TraderDb } from '../db.js';
import { BrokerUnavailableError } from './errors.js';
import type { AccountRow, BrokerAdapter, UserBroker } from './types.js';
import { guardWrites } from './writeGuard.js';

const log = createLogger('trader:brokers');

export interface McpRegistry {
  /** The account's broker session, created on first use by the account's adapter. */
  for(account: AccountRow): UserBroker;
  /** Whether this deployment has the account's adapter; `for` throws for an account it lacks one for. */
  supports(account: AccountRow): boolean;
  /** The session only if one already exists — never starts an OAuth flow. */
  existing(accountId: string): UserBroker | undefined;
  drop(accountId: string): void;
}

export function createMcpRegistry(
  adapters: readonly BrokerAdapter[],
  executionMode: TradeExecutionMode
): McpRegistry {
  // ponytail: unbounded — one entry per account that has ever traded this
  // process lifetime, each holding an open MCP transport. Fine at invite-only
  // scale. Upgrade path: an LRU that closes the transport on eviction.
  const brokers = new Map<string, UserBroker>();

  return {
    for(account: AccountRow): UserBroker {
      let broker = brokers.get(account.id);
      if (!broker) {
        const adapter = adapters.find((candidate) => candidate.id === account.adapter);
        if (!adapter) {
          throw new BrokerUnavailableError(`this deployment has no ${account.adapter} adapter`);
        }
        // Guarded once, when the session is opened, whichever adapter opened
        // it: everything downstream holds the guarded Broker, and its identity
        // stays stable per session.
        const opened = adapter.open(account);
        broker = {
          session: opened.session,
          broker: guardWrites(opened.broker, executionMode),
          quotesOptions: adapter.quotesOptions,
        };
        brokers.set(account.id, broker);
      }
      return broker;
    },
    supports: (account: AccountRow) => adapters.some((candidate) => candidate.id === account.adapter),
    existing: (accountId: string) => brokers.get(accountId),
    drop: (accountId: string) => void brokers.delete(accountId),
  };
}

type ConnectedAccounts = Pick<TraderDb, 'listConnectedAccounts'>;

/**
 * The connected accounts this deployment can act on: who a callout fans out
 * to and who each monitor sweeps. An account whose adapter is not deployed
 * here (a SnapTrade row where the SnapTrade keys are absent) is left out, so
 * it costs the others nothing and writes no row per callout; restoreSessions
 * names it once at boot.
 */
export async function supportedAccounts(db: ConnectedAccounts, brokers: McpRegistry): Promise<AccountRow[]> {
  return (await db.listConnectedAccounts()).filter((account) => brokers.supports(account));
}

/**
 * Reconnect everyone who was connected before the restart, so their stored
 * tokens are refreshed and their session is warm before the first callout
 * arrives rather than during it. One account that cannot be restored never
 * stops the rest.
 */
export async function restoreSessions(db: ConnectedAccounts, brokers: McpRegistry): Promise<void> {
  const accounts = await db.listConnectedAccounts();
  log.info('restoring broker sessions', { accounts: accounts.length });
  for (const account of accounts) {
    if (!brokers.supports(account)) {
      log.warn('account left out of trading: this deployment has no adapter for it', {
        accountId: account.id,
        adapter: account.adapter,
      });
      continue;
    }
    // Async, so an adapter that throws while opening rejects here like a failed connect.
    void (async () => brokers.for(account).session.ensureConnected())().catch((err: unknown) =>
      log.warn('could not restore broker session', {
        accountId: account.id,
        error: (err as Error).message,
      })
    );
  }
}
