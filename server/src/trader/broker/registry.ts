/**
 * One broker session — and one Broker over it — per account.
 *
 * Each account is its own authorization at its own broker, so a shared client
 * would place every account's orders on whichever happened to authorize first.
 * Holding the clients here also keeps each account's pending OAuth flow
 * separate, so two people can connect at the same time.
 */
import type { TradeExecutionMode } from '../../shared/types.js';
import { BrokerUnavailableError } from './errors.js';
import type { AccountRow, BrokerAdapter, UserBroker } from './types.js';
import { guardWrites } from './writeGuard.js';

export interface McpRegistry {
  /** The account's broker session, created on first use by the account's adapter. */
  for(account: AccountRow): UserBroker;
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
    existing: (accountId: string) => brokers.get(accountId),
    drop: (accountId: string) => void brokers.delete(accountId),
  };
}
