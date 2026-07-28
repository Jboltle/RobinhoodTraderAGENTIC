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
import { beforeEach, describe, expect, it } from 'vitest';

import type { Decision } from '../../shared/types.js';
import type { StoredCallout } from '../db.js';
import { fakeTokens } from './fakeDb.js';
import { makeHarness, type Harness } from './harness.js';

const USER_A = { id: 'user-a', email: 'a@example.com' };
const USER_B = { id: 'user-b', email: 'b@example.com' };
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

const SHARED_CALLOUT: StoredCallout = {
  messageId: 'msg-shared',
  channelId: 'chan-1',
  channelName: 'alerts',
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

  harness.db.seedSettings(USER_A.id, { maxTradesPerDay: 1, blockedTickers: ['NVDA'] });
  harness.db.seedDecision(USER_A.id, A_TRADE);
  harness.db.seedBrokerTokens(USER_A.id, fakeTokens('a-access-token', 'a-refresh-token'));
  harness.db.seedCallout(SHARED_CALLOUT);

  harness.configureBroker(USER_A.id, {
    connected: true,
    authUrl: 'https://robinhood.com/mcp/trading?state=a-only',
    portfolioValueUsd: 42_424.42,
    equityPositions: [{ symbol: 'NVDA', quantity: 7, raw: {} }],
  });
  harness.configureBroker(USER_B.id, { connected: false, portfolioValueUsd: 0 });
});

/** Every authenticated endpoint, as B would call it. */
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
        ...(request.payload
          ? {
              headers: { 'content-type': 'application/json' },
              payload: JSON.stringify(request.payload),
            }
          : {}),
      });

      const body = response.body;
      for (const fingerprint of A_FINGERPRINTS) {
        expect(body).not.toContain(fingerprint);
      }
      expect(harness.db.calls.map((c) => c.userId)).not.toContain(USER_A.id);
      for (const call of harness.db.calls) {
        expect(call.userId).toBe(USER_B.id);
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
      headers: { 'content-type': 'application/json' },
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
    expect((asA.json() as { decisions: Decision[] }).decisions).toHaveLength(1);
  });

  it("B's broker status reports B's session, not A's live connection", async () => {
    const response = await harness.as(TOKEN_B, { method: 'GET', url: '/api/broker/status' });
    expect(response.json()).toMatchObject({ connected: false, authUrl: null });

    const asA = await harness.as(TOKEN_A, { method: 'GET', url: '/api/broker/status' });
    expect(asA.json()).toMatchObject({ connected: true });
  });

  it("B disconnecting leaves A's broker tokens in place", async () => {
    await harness.as(TOKEN_B, { method: 'POST', url: '/api/broker/disconnect' });
    expect(await harness.db.getBrokerTokens(USER_A.id)).not.toBeNull();
  });

  it("B's portfolio and performance come from B's empty account", async () => {
    const portfolio = await harness.as(TOKEN_B, { method: 'GET', url: '/api/portfolio' });
    expect(portfolio.json()).toEqual({ portfolioValueUsd: 0, openPositions: 0 });

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
      harness.events.emitStage(USER_A.id, {
        messageId: 'msg-shared',
        ticker: 'NVDA',
        stage: 'executing',
      });
      harness.events.emitDecision(USER_A.id, A_TRADE);
      harness.events.emitStage(USER_B.id, {
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

