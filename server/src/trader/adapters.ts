/**
 * The broker adapters a deployment has, for the registry (broker/registry.ts)
 * that every broker is opened and write-guarded through.
 */
import type { BrokerAdapter } from './broker/types.js';
import { createRobinhoodAdapter } from './robinhood/adapter.js';
import type { BrokerTokenStore } from './robinhood/types.js';
import { createSnapTradeAdapter } from './snaptrade/adapter.js';
import type { SnapTradeBrokerClient } from './snaptrade/broker.js';

/**
 * Robinhood always. SnapTrade only with a client, which exists only on a
 * deployment holding the three SnapTrade settings (snaptrade/client.ts):
 * without it a SnapTrade account is left out of trading, as it was before the
 * adapter existed.
 */
export function deployedAdapters(
  db: BrokerTokenStore,
  snapTradeClient: SnapTradeBrokerClient | null
): BrokerAdapter[] {
  return [
    createRobinhoodAdapter(db),
    ...(snapTradeClient === null ? [] : [createSnapTradeAdapter(snapTradeClient)]),
  ];
}
