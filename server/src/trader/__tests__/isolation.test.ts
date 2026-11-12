/**
 * Cross-user isolation — the acceptance criterion for the multi-tenant refactor.
 *
 * User A is seeded with settings, trades, a Robinhood connection and a
 * portfolio that are all recognisably theirs. User B then calls every
 * authenticated endpoint and must never see any of it.
 *
 * Two things are checked on each call, because either alone is too weak:
 *   1. B's response body contains none of A's values.
 *   2. No query the request made was scoped to A's user id. This is the one
 *      that catches a route reading the right rows for the wrong reason.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Callout, CalloutParser, Decision, TradeSettings } from '../../shared/types.js';
import { VIEWED_ACCOUNT_HEADER } from '../auth.js';
import { createQuoteSource } from '../broker/quotes.js';
import { createMcpRegistry } from '../broker/registry.js';
import type { AccountRow, BrokerAdapter } from '../broker/types.js';
import type { StoredCallout } from '../db.js';
import { TraderEvents } from '../events.js';
import {
  BTO_QQQ_PUT,
  TRIM_QQQ_DOUBLE,
  envelopeFromFixture,
} from '../pipeline/__tests__/fixtures/discordMessages.js';
import { createMessageProcessor, type MessageProcessor } from '../pipeline/index.js';
import type { RobinhoodMcpClient } from '../robinhood/mcpClient.js';
import { createFakeDb, fakeAccount, fakeTokens, firstAccountId, type FakeDb } from './fakeDb.js';
import {
  equityPosition,
  makeFakeBroker,
  makeHarness,
  optionPosition,
  placedOrders,
  type FakeBroker,
  type Harness,
} from './harness.js';

const USER_A = { id: 'user-a', email: 'a@example.com' };
const USER_B = { id: 'user-b', email: 'b@example.com' };
/** Each user's account: what every row and broker session is keyed by, never the user id. */
const ACCOUNT_A = firstAccountId(USER_A.id);
const ACCOUNT_B = firstAccountId(USER_B.id);
const TOKEN_A = 'token-for-a';
const TOKEN_B = 'token-for-b';

const A_TRADE: Decision = {
  at: '2026-07-20T14:31:00.000Z',
  messageId: 'msg-shared',
  kind: 'submitted',
  code: null,
  reason: 'Bought 7 NVDA (market). Status: queued, order a-secret-order.',
  ticker: 'NVDA',
  action: 'buy',
  order: {
    symbol: 'NVDA',
    side: 'buy',
    assetType: 'equity',
    quantity: 7,
    orderType: 'limit',
    limitPrice: 111.11,
    option: null,
    orderId: 'a-secret-order',
    status: 'queued',
  },
};

/** A sized order of A's sitting in approval — the thing B must not be able to submit. */
const A_PENDING: Decision = {
  at: '2026-07-20T15:00:00.000Z',
  messageId: 'msg-pending',
  kind: 'pending_approval',
  code: null,
  reason: 'Approval required: BUY 7 NVDA (limit $111.11). No order submitted.',
  ticker: 'NVDA',
  action: 'buy',
  order: { ...A_TRADE.order!, orderId: null, status: null },
};

const SHARED_CALLOUT: StoredCallout = {
  messageId: 'msg-shared',
  channelId: 'chan-1',
  channelName: 'alerts',
  authorId: 'author-1',
  authorName: 'Demon Alerts',
  content: 'BUY $NVDA',
  timestamp: '2026-07-20T14:30:00.000Z',
  embeds: [],
  parse: null,
  parseStatus: 'parsed',
};

/** Anything of A's that must never appear in a response served to B. */
const A_FINGERPRINTS = ['a-secret-order', '111.11', 'a-refresh-token', '42424.42'];

let harness: Harness;

beforeEach(() => {
  harness = makeHarness();
  harness.db.addUser(USER_A, TOKEN_A);
  harness.db.addUser(USER_B, TOKEN_B);

  harness.db.seedSettings(ACCOUNT_A, { maxTradesPerDay: 1, blockedTickers: ['NVDA'] });
  harness.db.seedDecision(ACCOUNT_A, A_TRADE);
  harness.db.seedDecision(ACCOUNT_A, A_PENDING);
  harness.db.seedBrokerTokens(ACCOUNT_A, fakeTokens('a-access-token', 'a-refresh-token'));
  // B holds their own connection: broker data only serves with a stored
  // connection of record, and a disconnected B would turn the portfolio and
  // performance checks below into vacuous 409s.
  harness.db.seedBrokerTokens(ACCOUNT_B, fakeTokens('b-access-token'));
  harness.db.seedCallout(SHARED_CALLOUT);

  harness.configureBroker(ACCOUNT_A, {
    connected: true,
    authUrl: 'https://robinhood.com/mcp/trading?state=a-only',
    portfolioValueUsd: 42_424.42,
    positions: [equityPosition('NVDA', 7)],
  });
  harness.configureBroker(ACCOUNT_B, { connected: false, portfolioValueUsd: 0 });
});

/**
 * Every authenticated endpoint, as B would call it. Each request names the
 * caller's own selected account, as the dashboard does: a change is refused
 * without it, which would leave these checks with nothing to see.
 */
const B_REQUESTS = [
  { name: 'GET /api/settings', method: 'GET' as const, url: '/api/settings' },
  {
    name: 'PUT /api/settings',
    method: 'PUT' as const,
    url: '/api/settings',
    payload: { maxTradesPerDay: 9 },
  },
  { name: 'GET /api/decisions', method: 'GET' as const, url: '/api/decisions' },
  { name: 'GET /api/callouts', method: 'GET' as const, url: '/api/callouts' },
  { name: 'GET /api/portfolio', method: 'GET' as const, url: '/api/portfolio' },
  { name: 'GET /api/trades/performance', method: 'GET' as const, url: '/api/trades/performance' },
  {
    name: 'POST /api/trades/:id/approve',
    method: 'POST' as const,
    url: '/api/trades/msg-pending/approve',
    payload: {},
  },
  {
    name: 'POST /api/trades/:id/reject',
    method: 'POST' as const,
    url: '/api/trades/msg-pending/reject',
    payload: {},
  },
  { name: 'GET /api/broker/status', method: 'GET' as const, url: '/api/broker/status' },
  { name: 'POST /api/broker/disconnect', method: 'POST' as const, url: '/api/broker/disconnect' },
  {
    name: 'POST /api/broker/callback',
    method: 'POST' as const,
    url: '/api/broker/callback',
    payload: { redirectUrl: 'http://127.0.0.1:8788/oauth/callback?code=c&state=s' },
  },
];

describe('user B cannot see user A', () => {
  for (const request of B_REQUESTS) {
    it(`${request.name} leaks nothing of A's`, async () => {
      harness.db.calls.length = 0;

      const response = await harness.as(TOKEN_B, {
        method: request.method,
        url: request.url,
        headers: {
          [VIEWED_ACCOUNT_HEADER]: ACCOUNT_B,
          ...(request.payload ? { 'content-type': 'application/json' } : {}),
        },
        ...(request.payload ? { payload: JSON.stringify(request.payload) } : {}),
      });

      const body = response.body;
      for (const fingerprint of A_FINGERPRINTS) {
        expect(body).not.toContain(fingerprint);
      }
      expect(harness.db.calls.map((c) => c.scopeId)).not.toContain(ACCOUNT_A);
      for (const call of harness.db.calls) {
        expect(call.scopeId).toBe(ACCOUNT_B);
      }
    });
  }

  it("serves B their own settings, not A's", async () => {
    const response = await harness.as(TOKEN_B, { method: 'GET', url: '/api/settings' });
    const { settings } = response.json() as { settings: { maxTradesPerDay: number; blockedTickers: string[] } };
    expect(settings.maxTradesPerDay).toBe(10); // schema default, not A's 1
    expect(settings.blockedTickers).toEqual([]); // not A's ['NVDA']
  });

  it("B writing settings does not touch A's row", async () => {
    await harness.as(TOKEN_B, {
      method: 'PUT',
      url: '/api/settings',
      headers: { 'content-type': 'application/json', [VIEWED_ACCOUNT_HEADER]: ACCOUNT_B },
      payload: JSON.stringify({ maxTradesPerDay: 9 }),
    });

    const asA = await harness.as(TOKEN_A, { method: 'GET', url: '/api/settings' });
    expect((asA.json() as { settings: { maxTradesPerDay: number } }).settings.maxTradesPerDay).toBe(1);
  });

  it("B's feed shows the shared callout with no decision attached", async () => {
    const response = await harness.as(TOKEN_B, { method: 'GET', url: '/api/callouts' });
    const { callouts } = response.json() as {
      callouts: Array<{ messageId: string; decision: unknown }>;
    };
    // The callout itself is shared by design; A's outcome for it is not.
    expect(callouts).toHaveLength(1);
    expect(callouts[0]!.messageId).toBe('msg-shared');
    expect(callouts[0]!.decision).toBeNull();

    const asA = await harness.as(TOKEN_A, { method: 'GET', url: '/api/callouts' });
    const aFeed = asA.json() as { callouts: Array<{ decision: { kind: string } | null }> };
    expect(aFeed.callouts[0]!.decision).toMatchObject({ kind: 'submitted' });
  });

  it("B's decisions feed is empty while A's is not", async () => {
    const asB = await harness.as(TOKEN_B, { method: 'GET', url: '/api/decisions' });
    expect((asB.json() as { decisions: Decision[] }).decisions).toEqual([]);

    const asA = await harness.as(TOKEN_A, { method: 'GET', url: '/api/decisions' });
    expect((asA.json() as { decisions: Decision[] }).decisions).toHaveLength(2);
  });

  // Approve is the one endpoint that spends money, so "B sees nothing of A's"
  // is not enough here: B must also not be able to act on A's parked trade.
  it("B cannot approve A's pending trade", async () => {
    const response = await harness.as(TOKEN_B, {
      method: 'POST',
      url: '/api/trades/msg-pending/approve',
      headers: { 'content-type': 'application/json', [VIEWED_ACCOUNT_HEADER]: ACCOUNT_B },
      payload: '{}',
    });

    expect(response.statusCode).toBe(404);
    expect(harness.fakeBroker(ACCOUNT_B).placeOrder).not.toHaveBeenCalled();
    expect(harness.fakeBroker(ACCOUNT_A).placeOrder).not.toHaveBeenCalled();

    const asA = await harness.as(TOKEN_A, { method: 'GET', url: '/api/decisions' });
    const pending = (asA.json() as { decisions: Decision[] }).decisions.find(
      (d) => d.messageId === 'msg-pending'
    );
    expect(pending!.kind).toBe('pending_approval');
  });

  it("B's broker status reports B's own connection, not A's pending auth URL", async () => {
    const response = await harness.as(TOKEN_B, { method: 'GET', url: '/api/broker/status' });
    // Connected via B's own stored tokens; A's pending consent URL must not leak.
    expect(response.json()).toMatchObject({ connected: true, authUrl: null });

    const asA = await harness.as(TOKEN_A, { method: 'GET', url: '/api/broker/status' });
    expect(asA.json()).toMatchObject({ connected: true });
  });

  it("B disconnecting leaves A's broker tokens in place", async () => {
    await harness.as(TOKEN_B, {
      method: 'POST',
      url: '/api/broker/disconnect',
      headers: { [VIEWED_ACCOUNT_HEADER]: ACCOUNT_B },
    });
    expect(await harness.db.getBrokerTokens(ACCOUNT_A)).not.toBeNull();
  });

  it("B's portfolio and performance come from B's empty account", async () => {
    const portfolio = await harness.as(TOKEN_B, { method: 'GET', url: '/api/portfolio' });
    expect(portfolio.json()).toMatchObject({ portfolioValueUsd: 0, openPositions: 0 });

    const performance = await harness.as(TOKEN_B, {
      method: 'GET',
      url: '/api/trades/performance',
    });
    expect((performance.json() as { positions: unknown[] }).positions).toEqual([]);

    const asA = await harness.as(TOKEN_A, { method: 'GET', url: '/api/trades/performance' });
    const aPositions = asA.json() as { positions: Array<{ symbol: string; entryPrice: number }> };
    expect(aPositions.positions).toHaveLength(1);
    expect(aPositions.positions[0]).toMatchObject({ symbol: 'NVDA', entryPrice: 111.11 });
  });

  it("B's SSE stream carries only B's live events", async () => {
    await harness.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = harness.app.server.address() as { port: number };
    const abort = new AbortController();

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/stream`, {
        signal: abort.signal,
        headers: { authorization: `Bearer ${TOKEN_B}` },
      });
      const reader = response.body!.getReader();
      let buffer = '';
      const readUntil = async (predicate: (text: string) => boolean): Promise<void> => {
        while (!predicate(buffer)) {
          const { value, done } = await reader.read();
          if (done) throw new Error('stream ended early');
          buffer += new TextDecoder().decode(value);
        }
      };

      await readUntil((t) => t.includes('event: decisions'));
      expect(buffer).toContain('event: decisions\ndata: []');

      // A trades while B is listening; B's stream must stay silent about it.
      harness.events.emitStage(ACCOUNT_A, {
        messageId: 'msg-shared',
        ticker: 'NVDA',
        stage: 'executing',
      });
      harness.events.emitDecision(ACCOUNT_A, A_TRADE);
      harness.events.emitStage(ACCOUNT_B, {
        messageId: 'msg-own',
        ticker: 'TSLA',
        stage: 'executing',
      });

      await readUntil((t) => t.includes('"ticker":"TSLA"'));
      expect(buffer).not.toContain('NVDA');
      expect(buffer).not.toContain('a-secret-order');
    } finally {
      abort.abort();
      await harness.app.close();
    }
  }, 10_000);
});


// =============================================================================
// Accounts of one user are as separate as two users
//
// The ids below are deliberately not the owner's user id: every read and write
// has to go by account, and one that went by user would find nothing.
// =============================================================================

const OWNER = { id: 'user-owner', email: 'owner@example.com' };
const TOKEN_OWNER = 'token-for-owner';
const ROBINHOOD = fakeAccount('account-robinhood', OWNER.id);
const PAPER: AccountRow = {
  id: 'account-paper',
  userId: OWNER.id,
  adapter: 'snaptrade',
  institution: 'alpaca-paper',
  externalAccountId: 'snaptrade-account-1',
  label: 'Alpaca Paper',
  isPaper: true,
  needsReconnect: false,
  adapterData: { connectionId: 'connection-1', institutionSlug: 'ALPACA-PAPER', maskedAccountNumber: '1234' },
};

/** Auto-executing and following everyone, with the calendar guards relaxed. */
const TRADING: TradeSettings = {
  executionMode: 'immediate',
  followedCallerIds: null,
  regularHoursOnly: false,
  cooldownSeconds: 0,
  optionsFullPct: 10,
  maxSingleContractPct: 10,
};

const CONTRACT = { optionType: 'call', strike: 707, expiration: '2026-06-11' } as const;
const ENTRY_PREMIUM = 1;
// Both fake accounts have $10,000 buying power and a contract costs $100, so
// each account's own "small" percentage is its own contract count.
const ROBINHOOD_SMALL_PCT = 4;
const ROBINHOOD_CONTRACTS = 4;
const PAPER_SMALL_PCT = 2;
const PAPER_CONTRACTS = 2;

const ENTRY_FIXTURE = {
  ...BTO_QQQ_PUT,
  id: 'entry-qqq-707c',
  content: 'BTO $QQQ 707c 06/11 1.00',
  timestamp: '2026-06-11T13:30:00.000Z',
};
const ENTRY_ENVELOPE = envelopeFromFixture(ENTRY_FIXTURE);
const ENTRY_CALLOUT: Callout = {
  ...BTO_QQQ_PUT.expectedCallout,
  limitPrice: ENTRY_PREMIUM,
  option: CONTRACT,
};
// "TRIM TRIM": sell all but one of what this Caller's entry left the account holding.
const TRIM_ENVELOPE = envelopeFromFixture(TRIM_QQQ_DOUBLE);
const TRIM_CALLOUT = TRIM_QQQ_DOUBLE.expectedCallout;

describe('two accounts of one user', () => {
  const READY_SESSION = {
    isConnected: vi.fn().mockReturnValue(true),
    ensureReady: vi.fn().mockResolvedValue(undefined),
  } as unknown as RobinhoodMcpClient;

  let db: FakeDb;
  let events: TraderEvents;
  let fakes: Map<string, FakeBroker>;
  let opened: Array<{ adapter: string; accountId: string }>;
  let processor: MessageProcessor;

  /** Each account already holds what its own entry bought; only a sell reads positions. */
  const brokerHolding = (contracts: number): FakeBroker =>
    makeFakeBroker({
      equityMark: 710,
      optionMark: null,
      positions: [optionPosition('QQQ', CONTRACT.optionType, CONTRACT.strike, CONTRACT.expiration, contracts)],
    });

  beforeEach(() => {
    db = createFakeDb();
    events = new TraderEvents();
    db.addUser(OWNER, TOKEN_OWNER, ROBINHOOD.id);
    db.addAccount(PAPER);
    db.seedBrokerTokens(ROBINHOOD.id, fakeTokens('robinhood-token'));
    db.seedBrokerTokens(PAPER.id, fakeTokens('paper-token'));
    db.seedSettings(ROBINHOOD.id, { ...TRADING, optionsSmallPct: ROBINHOOD_SMALL_PCT });
    db.seedSettings(PAPER.id, { ...TRADING, optionsSmallPct: PAPER_SMALL_PCT });
    // The entry's author is what a later trim is matched against.
    db.seedMessage({ messageId: ENTRY_ENVELOPE.messageId, sentAt: ENTRY_ENVELOPE.timestamp, authorId: ENTRY_ENVELOPE.authorId });

    fakes = new Map([
      [ROBINHOOD.id, brokerHolding(ROBINHOOD_CONTRACTS)],
      [PAPER.id, brokerHolding(PAPER_CONTRACTS)],
    ]);
    opened = [];
    const adapter = (id: BrokerAdapter['id'], quotesOptions: boolean): BrokerAdapter => ({
      id,
      quotesOptions,
      open(account) {
        opened.push({ adapter: id, accountId: account.id });
        return { session: READY_SESSION, broker: fakes.get(account.id)! };
      },
    });
    const brokers = createMcpRegistry([adapter('robinhood', true), adapter('snaptrade', false)], 'immediate');

    const parser: CalloutParser = {
      parse: vi.fn(async (envelope) =>
        envelope.messageId === ENTRY_ENVELOPE.messageId ? ENTRY_CALLOUT : TRIM_CALLOUT
      ),
    };
    processor = createMessageProcessor({
      parser,
      db,
      events,
      brokers,
      quotes: createQuoteSource({ db, brokers }),
      executionMode: 'immediate',
    });
  });

  const decisionFor = async (accountId: string, messageId: string): Promise<Decision | undefined> =>
    (await db.decisionsByMessageId(accountId, [messageId])).get(messageId);

  /** What the fill monitor writes once the broker reports the buy filled. */
  const fillEntry = async (accountId: string): Promise<void> => {
    const { order } = (await decisionFor(accountId, ENTRY_ENVELOPE.messageId))!;
    await db.updateOrder(accountId, ENTRY_ENVELOPE.messageId, {
      ...order!,
      status: 'filled',
      filledQuantity: order!.quantity,
      averageFillPrice: ENTRY_PREMIUM,
    });
  };

  it('both take the same callout, each sized by its own settings on its own broker', async () => {
    await processor.process(ENTRY_ENVELOPE);

    const onRobinhood = await decisionFor(ROBINHOOD.id, ENTRY_ENVELOPE.messageId);
    const onPaper = await decisionFor(PAPER.id, ENTRY_ENVELOPE.messageId);
    expect(onRobinhood).toMatchObject({ kind: 'submitted', order: { side: 'buy', quantity: ROBINHOOD_CONTRACTS } });
    expect(onPaper).toMatchObject({ kind: 'submitted', order: { side: 'buy', quantity: PAPER_CONTRACTS } });

    expect(placedOrders(fakes.get(ROBINHOOD.id)!, 'option')).toMatchObject([
      { side: 'buy', quantity: ROBINHOOD_CONTRACTS, limitPrice: ENTRY_PREMIUM },
    ]);
    expect(placedOrders(fakes.get(PAPER.id)!, 'option')).toMatchObject([
      { side: 'buy', quantity: PAPER_CONTRACTS, limitPrice: ENTRY_PREMIUM },
    ]);
    // Each account was opened once, by the adapter its row names.
    expect(opened).toEqual(
      expect.arrayContaining([
        { adapter: 'robinhood', accountId: ROBINHOOD.id },
        { adapter: 'snaptrade', accountId: PAPER.id },
      ])
    );
    expect(opened).toHaveLength(2);
    // Nothing was read or written under the owner's user id.
    expect(db.calls.map((call) => call.scopeId)).not.toContain(OWNER.id);
  });

  it('a trim sells only that account\'s own lot', async () => {
    await processor.process(ENTRY_ENVELOPE);
    await fillEntry(ROBINHOOD.id);
    await fillEntry(PAPER.id);
    expect((await db.listOpenOptionLots(ROBINHOOD.id)).map((lot) => lot.openQty)).toEqual([ROBINHOOD_CONTRACTS]);
    expect((await db.listOpenOptionLots(PAPER.id)).map((lot) => lot.openQty)).toEqual([PAPER_CONTRACTS]);

    await processor.process(TRIM_ENVELOPE);

    const robinhoodSell = await decisionFor(ROBINHOOD.id, TRIM_ENVELOPE.messageId);
    const paperSell = await decisionFor(PAPER.id, TRIM_ENVELOPE.messageId);
    expect(robinhoodSell).toMatchObject({
      kind: 'submitted',
      order: { side: 'sell', quantity: ROBINHOOD_CONTRACTS - 1, lots: [{ quantity: ROBINHOOD_CONTRACTS - 1 }] },
    });
    expect(paperSell).toMatchObject({
      kind: 'submitted',
      order: { side: 'sell', quantity: PAPER_CONTRACTS - 1, lots: [{ quantity: PAPER_CONTRACTS - 1 }] },
    });

    const sells = (accountId: string): number[] =>
      placedOrders(fakes.get(accountId)!, 'option')
        .filter((order) => order.side === 'sell')
        .map((order) => order.quantity);
    expect(sells(ROBINHOOD.id)).toEqual([ROBINHOOD_CONTRACTS - 1]);
    expect(sells(PAPER.id)).toEqual([PAPER_CONTRACTS - 1]);
    // One runner left on each, counted from that account's own ledger.
    expect((await db.listOpenOptionLots(ROBINHOOD.id)).map((lot) => lot.openQty)).toEqual([1]);
    expect((await db.listOpenOptionLots(PAPER.id)).map((lot) => lot.openQty)).toEqual([1]);
  });

  it('an account that never took the entry sells nothing on the exit', async () => {
    // Paper stops following before the entry, so only Robinhood buys.
    db.seedSettings(PAPER.id, { ...TRADING, followedCallerIds: [] });
    await processor.process(ENTRY_ENVELOPE);
    await fillEntry(ROBINHOOD.id);
    expect(await decisionFor(PAPER.id, ENTRY_ENVELOPE.messageId)).toBeUndefined();

    // It follows again by the time of the trim, and holds the same contract
    // at its broker from elsewhere: the Caller's exit still has no lot of
    // theirs to sell there.
    db.seedSettings(PAPER.id, { ...TRADING });
    db.seedMessage({ messageId: 'paper-own-buy', sentAt: ENTRY_ENVELOPE.timestamp, authorId: 'another-caller' });
    db.seedDecision(PAPER.id, {
      at: ENTRY_ENVELOPE.timestamp,
      messageId: 'paper-own-buy',
      kind: 'submitted',
      code: null,
      reason: 'filled',
      ticker: 'QQQ',
      action: 'buy',
      order: {
        symbol: 'QQQ',
        side: 'buy',
        assetType: 'option',
        quantity: PAPER_CONTRACTS,
        orderType: 'limit',
        limitPrice: ENTRY_PREMIUM,
        option: CONTRACT,
        orderId: 'paper-own-buy',
        status: 'filled',
        filledQuantity: PAPER_CONTRACTS,
        averageFillPrice: ENTRY_PREMIUM,
      },
    });

    await processor.process(TRIM_ENVELOPE);

    expect(await decisionFor(ROBINHOOD.id, TRIM_ENVELOPE.messageId)).toMatchObject({
      kind: 'submitted',
      order: { side: 'sell', quantity: ROBINHOOD_CONTRACTS - 1 },
    });
    expect(await decisionFor(PAPER.id, TRIM_ENVELOPE.messageId)).toMatchObject({ kind: 'risk_rejected' });
    expect(placedOrders(fakes.get(PAPER.id)!, 'option')).toHaveLength(0);
    expect((await db.listOpenOptionLots(PAPER.id)).map((lot) => lot.openQty)).toEqual([PAPER_CONTRACTS]);
  });

  it('the daily trade cap counts each account on its own', async () => {
    db.seedSettings(ROBINHOOD.id, { ...TRADING, maxTradesPerDay: 1 });
    db.seedSettings(PAPER.id, { ...TRADING, maxTradesPerDay: 1 });
    db.seedDecision(ROBINHOOD.id, {
      at: new Date().toISOString(),
      messageId: 'earlier-today',
      kind: 'submitted',
      code: null,
      reason: 'earlier trade',
      ticker: 'SPY',
      action: 'buy',
      order: null,
    });

    await processor.process(ENTRY_ENVELOPE);

    expect(await decisionFor(ROBINHOOD.id, ENTRY_ENVELOPE.messageId)).toMatchObject({
      kind: 'risk_rejected',
      code: 'daily_cap_reached',
    });
    expect(await decisionFor(PAPER.id, ENTRY_ENVELOPE.messageId)).toMatchObject({ kind: 'submitted' });
  });

  it('live events reach only the account they belong to', async () => {
    const heard: string[] = [];
    events.subscribe(ROBINHOOD.id, { onDecision: () => heard.push('robinhood') });
    events.subscribe(PAPER.id, { onDecision: () => heard.push('paper') });
    events.subscribe(OWNER.id, { onDecision: () => heard.push('owner user id') });
    db.seedSettings(PAPER.id, { ...TRADING, followedCallerIds: [] });

    await processor.process(ENTRY_ENVELOPE);

    expect(heard).toEqual(['robinhood']);
  });

  it('one account waiting on its broker does not hold up the other', async () => {
    let answerRobinhood: () => void = () => undefined;
    fakes.get(ROBINHOOD.id)!.getAccount.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answerRobinhood = () => resolve({ buyingPowerUsd: 10_000, portfolioValueUsd: 0 });
        })
    );

    const processing = processor.process(ENTRY_ENVELOPE);

    await vi.waitFor(() => expect(placedOrders(fakes.get(PAPER.id)!, 'option')).toHaveLength(1));
    expect(placedOrders(fakes.get(ROBINHOOD.id)!, 'option')).toHaveLength(0);

    answerRobinhood();
    await processing;
    expect(placedOrders(fakes.get(ROBINHOOD.id)!, 'option')).toHaveLength(1);
  });
});

describe('routes act on the selected account, never on the user id', () => {
  const ROBINHOOD_TRADE: Decision = { ...A_TRADE, messageId: 'msg-shared' };
  const PAPER_TRADE: Decision = {
    ...A_TRADE,
    reason: 'Bought 3 TSLA on the paper account, order paper-secret-order.',
    ticker: 'TSLA',
    order: { ...A_TRADE.order!, symbol: 'TSLA', quantity: 3, orderId: 'paper-secret-order' },
  };
  const PAPER_FINGERPRINTS = ['paper-secret-order', 'TSLA'];

  let harness: Harness;

  beforeEach(() => {
    harness = makeHarness();
    harness.db.addUser(OWNER, TOKEN_OWNER, ROBINHOOD.id);
    harness.db.addAccount(PAPER);
    harness.db.seedBrokerTokens(ROBINHOOD.id, fakeTokens('robinhood-token'));
    harness.db.seedSettings(ROBINHOOD.id, { maxTradesPerDay: 4 });
    harness.db.seedSettings(PAPER.id, { maxTradesPerDay: 7 });
    harness.db.seedDecision(ROBINHOOD.id, ROBINHOOD_TRADE);
    harness.db.seedDecision(ROBINHOOD.id, A_PENDING);
    harness.db.seedDecision(PAPER.id, PAPER_TRADE);
    harness.db.seedCallout(SHARED_CALLOUT);
    harness.configureBroker(ROBINHOOD.id, { connected: true, positions: [equityPosition('NVDA', 7)] });
  });

  for (const request of B_REQUESTS) {
    it(`${request.name} is scoped to the selected account`, async () => {
      harness.db.calls.length = 0;

      const response = await harness.as(TOKEN_OWNER, {
        method: request.method,
        url: request.url,
        headers: {
          [VIEWED_ACCOUNT_HEADER]: ROBINHOOD.id,
          ...(request.payload ? { 'content-type': 'application/json' } : {}),
        },
        ...(request.payload ? { payload: JSON.stringify(request.payload) } : {}),
      });

      expect(response.statusCode).toBeLessThan(500);
      for (const fingerprint of PAPER_FINGERPRINTS) {
        expect(response.body).not.toContain(fingerprint);
      }
      for (const call of harness.db.calls) {
        expect(call.scopeId).toBe(ROBINHOOD.id);
      }
    });
  }

  it('reads the selected account\'s settings and trades, and the other one\'s once that is selected', async () => {
    const settings = async (): Promise<number> =>
      (
        (await harness.as(TOKEN_OWNER, { method: 'GET', url: '/api/settings' })).json() as {
          settings: { maxTradesPerDay: number };
        }
      ).settings.maxTradesPerDay;
    const orderIds = async (): Promise<Array<string | null | undefined>> =>
      (
        (await harness.as(TOKEN_OWNER, { method: 'GET', url: '/api/decisions' })).json() as {
          decisions: Decision[];
        }
      ).decisions.map((decision) => decision.order?.orderId);

    expect(await settings()).toBe(4);
    expect(await orderIds()).toEqual([null, 'a-secret-order']);

    harness.db.addAccount(PAPER, { select: true });

    expect(await settings()).toBe(7);
    expect(await orderIds()).toEqual(['paper-secret-order']);
  });

  it('a settings save lands on the selected account only', async () => {
    await harness.as(TOKEN_OWNER, {
      method: 'PUT',
      url: '/api/settings',
      headers: { 'content-type': 'application/json', [VIEWED_ACCOUNT_HEADER]: ROBINHOOD.id },
      payload: JSON.stringify({ maxTradesPerDay: 2 }),
    });

    expect((await harness.db.getSettings(ROBINHOOD.id)).maxTradesPerDay).toBe(2);
    expect((await harness.db.getSettings(PAPER.id)).maxTradesPerDay).toBe(7);
  });

  it('approving submits on the selected account\'s broker', async () => {
    const response = await harness.as(TOKEN_OWNER, {
      method: 'POST',
      url: '/api/trades/msg-pending/approve',
      headers: { 'content-type': 'application/json', [VIEWED_ACCOUNT_HEADER]: ROBINHOOD.id },
      payload: '{}',
    });

    expect(response.statusCode).toBe(200);
    expect(placedOrders(harness.fakeBroker(ROBINHOOD.id), 'equity')).toHaveLength(1);
    expect((await harness.db.decisionsByMessageId(ROBINHOOD.id, ['msg-pending'])).get('msg-pending')?.kind).toBe('submitted');
    expect((await harness.db.decisionsByMessageId(PAPER.id, ['msg-pending'])).size).toBe(0);
  });
});
