import type { BrokerAdapter } from '../broker/types.js';
import { RobinhoodBroker } from './broker.js';
import { RobinhoodMcpClient } from './mcpClient.js';
import { RobinhoodTools } from './tools.js';
import type { BrokerTokenStore } from './types.js';

export function createRobinhoodAdapter(db: BrokerTokenStore): BrokerAdapter {
  return {
    open(userId) {
      const mcp = new RobinhoodMcpClient({ userId, db });
      return { session: mcp, broker: new RobinhoodBroker(new RobinhoodTools(mcp)) };
    },
  };
}
