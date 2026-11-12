import type { RobinhoodMcpClient } from '../robinhood/mcpClient.js';
import type { RobinhoodTools } from '../robinhood/tools.js';

// ponytail: still the Robinhood classes under their current method names. The
// instrument-keyed Broker interface replaces them when a second adapter needs it.
export interface UserBroker {
  readonly mcp: RobinhoodMcpClient;
  readonly tools: RobinhoodTools;
}

/** Opens one user's broker session; the registry holds the result per user. */
export interface BrokerAdapter {
  open(userId: string): UserBroker;
}
