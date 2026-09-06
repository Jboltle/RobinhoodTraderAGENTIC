/**
 * Local sandbox for the dashboard: the real trader HTTP app (buildServer, real
 * auth hook, real approval routes) wired to the in-memory db the tests use and
 * a stubbed Robinhood session.
 *
 *   bun src/scripts/devServer.ts
 *
 * That means no Supabase project, no Docker and no broker credentials are
 * needed to click through the UI, and no order can ever reach a real account.
 * Any bearer token resolves to the one seeded user, so the browser can hold a
 * hand-made session instead of signing in. Never import this from the deployed
 * entrypoints — it is dev-only and trusts every caller.
 */
import { createLogger } from '../shared/logger.js';
import type { Decision, SubmittedOrder } from '../shared/types.js';
import { createFakeDb } from '../trader/__tests__/fakeDb.js';
import { TraderEvents } from '../trader/events.js';
import type { MessageProcessor } from '../trader/pipeline/index.js';
import type { McpRegistry, UserBroker } from '../trader/rh/mcpRegistry.js';
import type { RobinhoodMcpClient } from '../trader/rh/mcpClient.js';
import type { RobinhoodTools } from '../trader/rh/tools.js';
import { buildServer } from '../trader/server.js';

const log = createLogger('dev-server');

const PORT = 3000;
const USER = { id: 'dev-user', email: 'dev@localhost' };
const BUYING_POWER_USD = 25_000;
const PORTFOLIO_VALUE_USD = 31_480;

const db = createFakeDb();

// The browser's session is hand-made, so its token is whatever we say it is.
db.addUser(USER, 'dev-token');
db.allowEmail(USER.email);

// A roster to exercise the Following picker. Deliberately more than a handful:
// the bug this sandbox exists to check is a fresh account copying everyone.
const ROSTER = [
  ['700000000000000001', 'Demon Alerts'],
  ['700000000000000002', 'Bull Flag Bob'],
  ['700000000000000003', 'Cathie Woods Jr'],
  ['700000000000000004', 'Delta Neutral Dan'],
  ['700000000000000005', 'Gamma Gary'],
  ['700000000000000006', 'Theta Queen'],
] as const;

for (const [authorId, displayName] of ROSTER) {
  await db.upsertCaller({
    authorId,
    displayName,
    avatarUrl: null,
    lastSeenAt: new Date().toISOString(),
  });
}

const minutesAgo = (n: number): string => new Date(Date.now() - n * 60_000).toISOString();

/** A parked trade plus the callout it came from, so the Trades row renders a Caller. */
function seedPending(
  messageId: string,
  minutes: number,
  callerIndex: number,
  content: string,
  order: SubmittedOrder,
  reason: string
): void {
  const [authorId, authorName] = ROSTER[callerIndex]!;
  const at = minutesAgo(minutes);
  db.seedCallout({
    messageId,
    channelId: 'dev-channel',
    channelName: 'alerts',
    authorId,
    authorName,
    content,
    timestamp: at,
    embeds: [],
    parse: null,
    parseStatus: 'parsed',
  });
  const decision: Decision = {
    at,
    messageId,
    kind: 'pending_approval',
    code: null,
    reason,
    ticker: order.symbol,
    action: order.side,
    order,
  };
  db.seedDecision(USER.id, decision);
}

seedPending(
  'dev-msg-1',
  4,
  0,
  'Buying NVDA here, medium size',
  {
    symbol: 'NVDA',
    side: 'buy',
    assetType: 'equity',
    quantity: 4,
    orderType: 'market',
    limitPrice: null,
    option: null,
    orderId: null,
    status: null,
  },
  'awaiting approval: buy 4 NVDA at market'
);

seedPending(
  'dev-msg-2',
  9,
  3,
  'SPY 600c 2026-10-16 @ 2.40, small',
  {
    symbol: 'SPY',
    side: 'buy',
    assetType: 'option',
    quantity: 1,
    orderType: 'limit',
    limitPrice: 2.4,
    option: { optionType: 'call', strike: 600, expiration: '2026-10-16' },
    orderId: null,
    status: null,
  },
  'awaiting approval: buy 1 SPY 600C 2026-10-16 at 2.40 limit'
);

seedPending(
  'dev-msg-3',
  15,
  5,
  'Full size AMD',
  {
    symbol: 'AMD',
    side: 'buy',
    assetType: 'equity',
    quantity: 7,
    orderType: 'market',
    limitPrice: null,
    option: null,
    orderId: null,
    status: null,
  },
  'awaiting approval: buy 7 AMD at market'
);

// One settled row so the table shows pending trades sorting above history.
db.seedCallout({
  messageId: 'dev-msg-0',
  channelId: 'dev-channel',
  channelName: 'alerts',
  authorId: ROSTER[1][0],
  authorName: ROSTER[1][1],
  content: 'TSLA looks heavy, taking a starter',
  timestamp: minutesAgo(90),
  embeds: [],
  parse: null,
  parseStatus: 'parsed',
});
db.seedDecision(USER.id, {
  at: minutesAgo(90),
  messageId: 'dev-msg-0',
  kind: 'risk_rejected',
  code: 'cooldown_active',
  reason: 'TSLA traded 12 minutes ago; per-ticker cooldown still running',
  ticker: 'TSLA',
  action: 'buy',
  order: null,
});

const broker: UserBroker = {
  mcp: {
    isConnected: () => true,
    getPendingAuthUrl: () => null,
    isAuthPending: () => false,
    submitAuthCode: () => {},
    ensureConnected: async () => {},
    getTokenStatus: async () => ({ state: 'valid', expiresInSec: 3600, hasRefreshToken: true }),
    getToolNames: () => [],
  } as unknown as RobinhoodMcpClient,
  tools: {
    getBuyingPower: async () => ({
      amountUsd: BUYING_POWER_USD,
      accountNumber: 'dev-account',
      portfolioValueUsd: PORTFOLIO_VALUE_USD,
    }),
    getQuote: async () => ({ price: 172.5 }),
    getOptionsMarkPrice: async () => ({ markPrice: 2.4 }),
    placeOrder: async () => ({ orderId: `dev-eq-${Date.now()}`, status: 'queued' }),
    placeOptionsOrder: async () => ({ orderId: `dev-opt-${Date.now()}`, status: 'queued' }),
    getPositions: async () => ({ positions: [], raw: {} }),
    getOptionPositions: async () => ({ positions: [], raw: {} }),
  } as unknown as RobinhoodTools,
};

const brokers: McpRegistry = {
  for: () => broker,
  existing: () => broker,
  drop: () => {},
};

const processor: MessageProcessor = {
  process: (async () => {}) as MessageProcessor['process'],
};

const fastify = buildServer({ db, events: new TraderEvents(), brokers, processor });

await fastify.listen({ port: PORT, host: '127.0.0.1' });
log.info('dev trader listening', { url: `http://127.0.0.1:${PORT}`, user: USER.id });
