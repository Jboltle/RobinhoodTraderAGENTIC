/**
 * One broker session — and one Broker over it — per user.
 *
 * Each user authorizes their own Robinhood account, so a shared client would
 * place every user's orders on whichever account happened to authorize first.
 * Holding the clients here also keeps each user's pending OAuth flow separate,
 * so two people can connect at the same time.
 */
import type { TradeExecutionMode } from '../../shared/types.js';
import type { BrokerAdapter, UserBroker } from './types.js';
import { guardWrites } from './writeGuard.js';

export interface McpRegistry {
  /** The user's broker session, created on first use. */
  for(userId: string): UserBroker;
  /** The session only if one already exists — never starts an OAuth flow. */
  existing(userId: string): UserBroker | undefined;
  drop(userId: string): void;
}

export function createMcpRegistry(
  adapter: BrokerAdapter,
  executionMode: TradeExecutionMode
): McpRegistry {
  // ponytail: unbounded — one entry per user who has ever traded this process
  // lifetime, each holding an open MCP transport. Fine at invite-only scale.
  // Upgrade path: an LRU that closes the transport on eviction.
  const brokers = new Map<string, UserBroker>();

  return {
    for(userId: string): UserBroker {
      let broker = brokers.get(userId);
      if (!broker) {
        // Guarded once, when the session is opened: everything downstream holds
        // the guarded Broker, and its identity stays stable per session.
        const opened = adapter.open(userId);
        broker = { ...opened, broker: guardWrites(opened.broker, executionMode) };
        brokers.set(userId, broker);
      }
      return broker;
    },
    existing: (userId: string) => brokers.get(userId),
    drop: (userId: string) => void brokers.delete(userId),
  };
}
