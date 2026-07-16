/**
 * Opt-in LIVE Robinhood execution test.
 *
 * ⚠️  DANGER: THIS TALKS TO A REAL BROKERAGE ACCOUNT.
 *
 * Everything here is SKIPPED by default so `npm test` never touches Robinhood.
 * Two independent opt-in switches gate the two levels of risk:
 *
 *   RUN_LIVE_TRADE_TEST=1
 *     Connects to the real Robinhood MCP (OAuth tokens must already exist at
 *     RH_TOKENS_PATH — run `bun run connect` first) and performs a READ-ONLY
 *     buying-power check. No orders are placed.
 *
 *   RUN_LIVE_TRADE_TEST=1 LIVE_TRADE_PLACE_ORDER=1
 *     Additionally places ONE minimal real order and logs the returned order id
 *     so it can be reviewed/cancelled. Configure the order via:
 *       LIVE_TRADE_SYMBOL       (default: F)
 *       LIVE_TRADE_QUANTITY     (default: 1)
 *       LIVE_TRADE_LIMIT_PRICE  (default: 1.00 — intentionally far below market
 *                                so a limit buy rests instead of filling)
 *
 * Example:
 *   RUN_LIVE_TRADE_TEST=1 npm test -- src/trader/__tests__/liveExecution.test.ts
 */

import { describe, expect, it } from 'vitest';

import { createLogger } from '../../shared/logger.js';
import { RobinhoodMcpClient } from '../rh/mcpClient.js';
import { RobinhoodTools } from '../rh/tools.js';

const log = createLogger('test:live-execution');

const RUN_LIVE = process.env.RUN_LIVE_TRADE_TEST === '1';
const PLACE_ORDER = process.env.LIVE_TRADE_PLACE_ORDER === '1';

const LIVE_ORDER = {
  symbol: process.env.LIVE_TRADE_SYMBOL ?? 'F',
  quantity: Number(process.env.LIVE_TRADE_QUANTITY ?? 1),
  limitPrice: Number(process.env.LIVE_TRADE_LIMIT_PRICE ?? 1.0),
};

const CONNECT_TIMEOUT_MS = 120_000;

async function connectTools(): Promise<{ mcp: RobinhoodMcpClient; tools: RobinhoodTools }> {
  const mcp = new RobinhoodMcpClient();
  await mcp.ensureConnected();
  log.info('connected to Robinhood MCP', { tools: mcp.getToolNames() });
  return { mcp, tools: new RobinhoodTools(mcp) };
}

describe('live Robinhood execution (opt-in)', () => {
  it.skipIf(!RUN_LIVE)(
    'connects and reads buying power (read-only)',
    async () => {
      const { tools } = await connectTools();
      const bp = await tools.getBuyingPower();

      log.info('live buying power', { amountUsd: bp.amountUsd, accountNumber: bp.accountNumber });
      expect(typeof bp.amountUsd).toBe('number');
      expect(bp.amountUsd).toBeGreaterThanOrEqual(0);
    },
    CONNECT_TIMEOUT_MS
  );

  it.skipIf(!(RUN_LIVE && PLACE_ORDER))(
    'places one minimal real order and returns an order id',
    async () => {
      const { tools } = await connectTools();

      log.warn('PLACING A REAL ORDER', LIVE_ORDER);
      const result = await tools.placeOrder({
        symbol: LIVE_ORDER.symbol,
        side: 'buy',
        orderType: 'limit',
        quantity: LIVE_ORDER.quantity,
        limitPrice: LIVE_ORDER.limitPrice,
      });

      log.warn('real order submitted — review/cancel in Robinhood', {
        orderId: result.orderId,
        status: result.status,
      });
      expect(result.orderId).toBeTruthy();
    },
    CONNECT_TIMEOUT_MS
  );
});
