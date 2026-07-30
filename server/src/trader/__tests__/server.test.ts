/**
 * Trader HTTP server tests — routes exercised in-process via fastify.inject
 * against the in-memory db and stubbed broker sessions.
 *
 * Covers:
 *   - webhook wrapper body ({ envelope }, valid HMAC) handing off to the fan-out
 *   - GET/PUT /api/settings round-trip and validation
 *   - GET /api/decisions ordering and ?limit=
 *   - GET /api/callouts joining shared callouts with the caller's outcomes
 *   - GET /api/portfolio and /api/trades/performance, incl. the unavailable path
 *   - the Robinhood connect/callback/disconnect flow
 *   - GET /api/stream SSE framing (snapshot, live push, performance)
 *
 * Auth is covered by auth.test.ts and per-user scoping by isolation.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { config } from '../../shared/config.js';
import type { Decision } from '../../shared/types.js';
import { signWebhookBody } from '../../shared/webhookAuth.js';
import type { StoredCallout } from '../db.js';
import { fakeTokens } from './fakeDb.js';
import { makeHarness, type Harness } from './harness.js';

// Sign with whatever secret the server verifies against: the vitest dummy is
// only injected when .env doesn't already define BOT_TRADER_SECRET, so a
// hardcoded 'test-dummy-secret' 401s on machines with a populated .env.
const SECRET = config.botTraderSecret;
const USER = { id: 'user-1', email: 'user@example.com' };
const TOKEN = 'a-valid-token';

const ENVELOPE = {
  messageId: 'msg-001',
  channelId: 'chan-001',
  guildId: null,
  authorId: 'author-001',
  authorName: 'Demon Alerts',
  content: 'BUY $AAPL',
  timestamp: '2026-07-14T14:30:00.000Z',
};

const decisionFixture = (messageId: string, overrides: Partial<Decision> = {}): Decision => ({
  at: '2026-07-14T14:30:05.000Z',
  messageId,
  kind: 'submitted',
  code: null,
  reason: `fixture ${messageId}`,
  ticker: 'AAPL',
  action: 'buy',
  order: null,
  ...overrides,
});

const calloutFixture = (messageId: string, timestamp: string): StoredCallout => ({
  messageId,
  channelId: 'chan-001',
  channelName: 'alerts',
  authorId: 'author-001',
  authorName: 'Demon Alerts',
  content: `callout ${messageId}`,
  timestamp,
  embeds: [],
  parse: null,
  parseStatus: 'parsed',
});

let harness: Harness;
const get = (url: string) => harness.as(TOKEN, { method: 'GET', url });
const send = (method: 'PUT' | 'POST', url: string, body: unknown) =>
  harness.as(TOKEN, {
    method,
    url,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });

beforeEach(() => {
  harness = makeHarness();
  harness.db.addUser(USER, TOKEN);
});

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

describe('POST /webhook/discord', () => {
  const post = (body: unknown) => {
    const payload = JSON.stringify(body);
    return harness.app.inject({
      method: 'POST',
      url: '/webhook/discord',
      headers: { 'content-type': 'application/json', ...signWebhookBody(payload, SECRET) },
      payload,
    });
  };

  it('acknowledges immediately and hands the envelope to the fan-out', async () => {
    const response = await post({ envelope: ENVELOPE });

    expect(response.statusCode).toBe(202);
    expect(harness.process).toHaveBeenCalledOnce();
    expect(harness.process.mock.calls[0]![0]).toMatchObject({ messageId: 'msg-001' });
  });

  it('rejects a bare envelope (pre-wrapper body shape)', async () => {
    expect((await post(ENVELOPE)).statusCode).toBe(400);
    expect(harness.process).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

describe('/api/settings', () => {
  it('GET returns the schema defaults before anything is stored', async () => {
    const response = await get('/api/settings');
    expect(response.statusCode).toBe(200);

    const { settings } = response.json() as { settings: Record<string, unknown> };
    expect(settings.minConfidence).toBe(0.7);
    expect(settings.executionMode).toBe('immediate');
    expect(settings.maxNotionalPct).toBe(5);
    expect(settings.allowedTickers).toEqual([]);
  });

  it('PUT stores validated settings and GET returns them over the defaults', async () => {
    const put = await send('PUT', '/api/settings', { minConfidence: 0.95, maxTradesPerDay: 2 });
    expect(put.statusCode).toBe(200);

    const { settings } = (await get('/api/settings')).json() as {
      settings: Record<string, unknown>;
    };
    expect(settings.minConfidence).toBe(0.95);
    expect(settings.maxTradesPerDay).toBe(2);
    expect(settings.maxNotionalPct).toBe(5); // default fills the rest
  });

  it('PUT rejects settings that fail schema validation', async () => {
    expect((await send('PUT', '/api/settings', { minConfidence: 5 })).statusCode).toBe(400);
  });

  it('PUT rejects unknown keys instead of silently stripping them', async () => {
    const response = await send('PUT', '/api/settings', { maxTradesperDay: 2 }); // typo'd casing
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid settings' });
  });
});

// ---------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------

describe('GET /api/decisions', () => {
  it('returns the caller\u2019s decisions newest-first', async () => {
    harness.db.seedDecision(USER.id, decisionFixture('older', { at: '2026-07-14T10:00:00.000Z' }));
    harness.db.seedDecision(USER.id, decisionFixture('newer', { at: '2026-07-14T12:00:00.000Z' }));

    const response = await get('/api/decisions');
    expect(response.statusCode).toBe(200);

    const { decisions } = response.json() as { decisions: Decision[] };
    expect(decisions.map((d) => d.messageId)).toEqual(['newer', 'older']);
  });

  it('honours ?limit= and rejects invalid limits', async () => {
    harness.db.seedDecision(USER.id, decisionFixture('one', { at: '2026-07-14T10:00:00.000Z' }));
    harness.db.seedDecision(USER.id, decisionFixture('two', { at: '2026-07-14T11:00:00.000Z' }));

    const limited = await get('/api/decisions?limit=1');
    expect((limited.json() as { decisions: Decision[] }).decisions).toHaveLength(1);
    expect((await get('/api/decisions?limit=zero')).statusCode).toBe(400);
  });

  it('returns an empty feed for a user who has never traded', async () => {
    expect((await get('/api/decisions')).json()).toEqual({ decisions: [] });
  });
});

describe('GET /api/callouts', () => {
  it('attaches the caller\u2019s outcome to each shared callout', async () => {
    harness.db.seedCallout(calloutFixture('msg-acted', '2026-07-15T14:30:00.000Z'));
    harness.db.seedCallout(calloutFixture('msg-untouched', '2026-07-15T14:00:00.000Z'));
    harness.db.seedDecision(USER.id, decisionFixture('msg-acted'));

    const response = await get('/api/callouts');
    expect(response.statusCode).toBe(200);

    const { callouts } = response.json() as {
      callouts: Array<{ messageId: string; decision: { kind: string } | null }>;
    };
    expect(callouts.map((c) => c.messageId)).toEqual(['msg-acted', 'msg-untouched']);
    expect(callouts[0]!.decision).toMatchObject({ kind: 'submitted' });
    // Nothing acted on it for this user, and there is no "backfill" concept:
    // the callout is simply in the feed with no decision.
    expect(callouts[1]!.decision).toBeNull();
  });
});

describe('GET /api/callers', () => {
  it('returns the shared Caller roster', async () => {
    await harness.db.upsertCaller({
      authorId: 'author-001',
      displayName: 'Demon Alerts',
      avatarUrl: 'https://cdn.discordapp.com/avatars/author-001/abc.png',
      lastSeenAt: '2026-07-15T14:30:00.000Z',
    });

    const response = await get('/api/callers');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      callers: [
        {
          authorId: 'author-001',
          displayName: 'Demon Alerts',
          avatarUrl: 'https://cdn.discordapp.com/avatars/author-001/abc.png',
          lastSeenAt: '2026-07-15T14:30:00.000Z',
        },
      ],
    });
  });

  it('is rejected without a bearer token like every other private route', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/callers' });
    expect(response.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Portfolio / performance
// ---------------------------------------------------------------------------

describe('GET /api/trades/performance', () => {
  it('joins open positions with the caller\u2019s submitted orders and live quotes', async () => {
    harness.configureBroker(USER.id, {
      equityPositions: [{ symbol: 'AAPL', quantity: 10, raw: {} }],
      optionPositions: [
        { symbol: 'QQQ', optionType: 'put', strike: 710, expiration: '2026-06-08', quantity: 2, raw: {} },
      ],
      quotePrice: 165,
      markPrice: 1.94,
    });

    harness.db.seedDecision(
      USER.id,
      decisionFixture('eq', {
        order: {
          symbol: 'AAPL',
          side: 'buy',
          assetType: 'equity',
          quantity: 10,
          orderType: 'limit',
          limitPrice: 150,
          option: null,
          orderId: 'eq-001',
          status: 'queued',
        },
      })
    );
    harness.db.seedDecision(
      USER.id,
      decisionFixture('opt', {
        ticker: 'QQQ',
        order: {
          symbol: 'QQQ',
          side: 'buy',
          assetType: 'option',
          quantity: 2,
          orderType: 'limit',
          limitPrice: 0.97,
          option: { optionType: 'put', strike: 710, expiration: '2026-06-08' },
          orderId: 'opt-001',
          status: 'queued',
        },
      })
    );

    const response = await get('/api/trades/performance');
    expect(response.statusCode).toBe(200);

    const { positions } = response.json() as {
      positions: Array<{ symbol: string; entryPrice: number; currentPrice: number; pctChange: number }>;
    };
    expect(positions).toHaveLength(2);

    const equity = positions.find((p) => p.symbol === 'AAPL')!;
    expect(equity.entryPrice).toBe(150);
    expect(equity.currentPrice).toBe(165);
    expect(equity.pctChange).toBeCloseTo(10);

    const option = positions.find((p) => p.symbol === 'QQQ')!;
    expect(option.entryPrice).toBe(0.97);
    expect(option.pctChange).toBeCloseTo(100);
  });

  it('entry price comes from the buy even when a sell decision is newer', async () => {
    harness.configureBroker(USER.id, {
      equityPositions: [{ symbol: 'AAPL', quantity: 5, raw: {} }],
      quotePrice: 165,
    });

    const equityOrder = (side: 'buy' | 'sell', limitPrice: number) => ({
      symbol: 'AAPL',
      side,
      assetType: 'equity' as const,
      quantity: 5,
      orderType: 'limit' as const,
      limitPrice,
      option: null,
      orderId: `eq-${side}`,
      status: 'queued',
    });
    harness.db.seedDecision(
      USER.id,
      decisionFixture('buy', { at: '2026-07-14T14:00:00.000Z', order: equityOrder('buy', 150) })
    );
    harness.db.seedDecision(
      USER.id,
      decisionFixture('trim', { at: '2026-07-14T15:00:00.000Z', order: equityOrder('sell', 160) })
    );

    const { positions } = (await get('/api/trades/performance')).json() as {
      positions: Array<{ symbol: string; entryPrice: number }>;
    };
    expect(positions.find((p) => p.symbol === 'AAPL')!.entryPrice).toBe(150);
  });

  it('returns a clear error payload when Robinhood MCP is unavailable', async () => {
    harness.configureBroker(USER.id, {
      toolsOverrides: {
        getPositions: vi.fn().mockRejectedValue(new Error('MCP transport closed')),
      },
    });

    const response = await get('/api/trades/performance');
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: 'robinhood unavailable' });
  });
});

describe('GET /api/portfolio', () => {
  it('returns portfolio value and counts only open positions', async () => {
    harness.configureBroker(USER.id, {
      portfolioValueUsd: 25_431.5,
      equityPositions: [
        { symbol: 'AAPL', quantity: 10, raw: {} },
        { symbol: 'MSFT', quantity: 0, raw: {} }, // closed — not counted
      ],
      optionPositions: [
        { symbol: 'QQQ', optionType: 'put', strike: 710, expiration: '2026-06-08', quantity: 2, raw: {} },
      ],
    });

    const response = await get('/api/portfolio');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ portfolioValueUsd: 25_431.5, openPositions: 2 });
  });

  it('returns 503 when Robinhood MCP is unavailable', async () => {
    harness.configureBroker(USER.id, {
      toolsOverrides: {
        getBuyingPower: vi.fn().mockRejectedValue(new Error('MCP transport closed')),
      },
    });

    const response = await get('/api/portfolio');
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: 'robinhood unavailable' });
  });
});

// ---------------------------------------------------------------------------
// Robinhood connection
// ---------------------------------------------------------------------------

describe('/api/broker', () => {
  it('status reports the pending auth URL while disconnected', async () => {
    harness.configureBroker(USER.id, {
      authUrl: 'https://robinhood.com/mcp/trading?state=abc',
      authPending: true,
    });
    harness.brokerFor(USER.id); // the registry only reports sessions that exist

    const response = await get('/api/broker/status');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      connected: false,
      authUrl: 'https://robinhood.com/mcp/trading?state=abc',
    });
  });

  it('status reports no session before the user has ever connected', async () => {
    expect((await get('/api/broker/status')).json()).toMatchObject({
      connected: false,
      authUrl: null,
    });
  });

  it('connect returns the authorization URL to open', async () => {
    harness.configureBroker(USER.id, {
      authUrl: 'https://robinhood.com/mcp/trading?state=abc',
    });

    const response = await send('POST', '/api/broker/connect', {});
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      connected: false,
      authUrl: 'https://robinhood.com/mcp/trading?state=abc',
    });
  });

  it('connect short-circuits when the session is already live', async () => {
    harness.configureBroker(USER.id, { connected: true });

    const response = await send('POST', '/api/broker/connect', {});
    expect(response.json()).toEqual({ connected: true, authUrl: null });
  });

  it('callback extracts code and state from the pasted redirect URL', async () => {
    harness.configureBroker(USER.id, { authPending: true });
    const broker = harness.brokerFor(USER.id);

    const response = await send('POST', '/api/broker/callback', {
      redirectUrl: '  http://127.0.0.1:8788/oauth/callback?code=the-code&state=the-state ',
    });

    expect(response.statusCode).toBe(200);
    expect(broker.mcp.submitAuthCode).toHaveBeenCalledWith('the-code', 'the-state');
  });

  it('callback 400s on an unparseable URL and on a URL without a code', async () => {
    harness.configureBroker(USER.id, { authPending: true });
    harness.brokerFor(USER.id);

    expect((await send('POST', '/api/broker/callback', { redirectUrl: 'not a url' })).statusCode).toBe(400);
    expect(
      (
        await send('POST', '/api/broker/callback', {
          redirectUrl: 'http://127.0.0.1:8788/oauth/callback?state=x',
        })
      ).statusCode
    ).toBe(400);
    expect((await send('POST', '/api/broker/callback', { wrong: 'shape' })).statusCode).toBe(400);
  });

  it('callback 409s when no auth is pending', async () => {
    const url = 'http://127.0.0.1:8788/oauth/callback?code=x&state=y';
    expect((await send('POST', '/api/broker/callback', { redirectUrl: url })).statusCode).toBe(409);

    harness.configureBroker(USER.id, { authPending: false });
    harness.brokerFor(USER.id);
    expect((await send('POST', '/api/broker/callback', { redirectUrl: url })).statusCode).toBe(409);
  });

  it('disconnect drops the stored tokens and the live session', async () => {
    harness.db.seedBrokerTokens(USER.id, fakeTokens('abc'));
    harness.brokerFor(USER.id);

    const response = await send('POST', '/api/broker/disconnect', {});
    expect(response.statusCode).toBe(200);
    expect(await harness.db.getBrokerTokens(USER.id)).toBeNull();
    expect(harness.brokers.existing(USER.id)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SSE stream
// ---------------------------------------------------------------------------

describe('GET /api/stream', () => {
  // inject() can't consume a never-ending hijacked stream, so listen on an
  // ephemeral port and read real SSE frames over http.
  it('streams a decisions snapshot, live pushes, and performance frames', async () => {
    harness.db.seedDecision(USER.id, decisionFixture('seed', { reason: 'seed' }));

    await harness.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = harness.app.server.address() as { port: number };
    const abort = new AbortController();

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/stream`, {
        signal: abort.signal,
        headers: { origin: 'http://localhost:3001', authorization: `Bearer ${TOKEN}` },
      });
      expect(response.headers.get('content-type')).toBe('text/event-stream');
      expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:3001');

      const reader = response.body!.getReader();
      let buffer = '';
      const readUntil = async (predicate: (text: string) => boolean): Promise<void> => {
        while (!predicate(buffer)) {
          const { value, done } = await reader.read();
          if (done) throw new Error('stream ended early');
          buffer += new TextDecoder().decode(value);
        }
      };

      // Snapshot + first performance frame arrive on connect.
      await readUntil((t) => t.includes('event: decisions') && t.includes('event: performance'));
      expect(buffer).toContain('"reason":"seed"');
      expect(buffer).toContain('"positions":[]');

      // A new decision pushes a fresh decisions frame.
      harness.db.seedDecision(USER.id, decisionFixture('live', { reason: 'live-push' }));
      harness.events.emitDecision(USER.id, decisionFixture('live', { reason: 'live-push' }));
      await readUntil((t) => t.includes('"reason":"live-push"'));

      // Lifecycle stage events are forwarded as `stage` frames.
      harness.events.emitStage(USER.id, {
        messageId: 'msg-live',
        ticker: 'AAPL',
        stage: 'executing',
      });
      await readUntil((t) => t.includes('event: stage') && t.includes('"stage":"executing"'));
    } finally {
      abort.abort();
      await harness.app.close();
    }
  }, 10_000);
});

