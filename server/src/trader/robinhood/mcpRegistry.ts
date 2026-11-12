/**
 * One Robinhood MCP client — and one RobinhoodTools — per user.
 *
 * Each user authorizes their own Robinhood account, so a shared client would
 * place every user's orders on whichever account happened to authorize first.
 * Holding the clients here also keeps each user's pending OAuth flow separate,
 * so two people can connect at the same time.
 */
import type { BrokerTokenStore } from './types.js';
import { RobinhoodMcpClient } from './mcpClient.js';
import { RobinhoodTools } from './tools.js';

export interface UserBroker {
  readonly mcp: RobinhoodMcpClient;
  readonly tools: RobinhoodTools;
}

export interface McpRegistry {
  /** The user's broker session, created on first use. */
  for(userId: string): UserBroker;
  /** The session only if one already exists — never starts an OAuth flow. */
  existing(userId: string): UserBroker | undefined;
  drop(userId: string): void;
}

export function createMcpRegistry(db: BrokerTokenStore): McpRegistry {
  // ponytail: unbounded — one entry per user who has ever traded this process
  // lifetime, each holding an open MCP transport. Fine at invite-only scale.
  // Upgrade path: an LRU that closes the transport on eviction.
  const brokers = new Map<string, UserBroker>();

  return {
    for(userId: string): UserBroker {
      let broker = brokers.get(userId);
      if (!broker) {
        const mcp = new RobinhoodMcpClient({ userId, db });
        broker = { mcp, tools: new RobinhoodTools(mcp) };
        brokers.set(userId, broker);
      }
      return broker;
    },
    existing: (userId: string) => brokers.get(userId),
    drop: (userId: string) => void brokers.delete(userId),
  };
}
