/**
 * Trader HTTP server tests — routes exercised in-process via fastify.inject
 * with mocked parser/tools and real fs against /tmp paths.
 *
 * Covers:
 *   - webhook wrapper body ({ envelope, settings? }, valid HMAC)
 *   - per-request settings override reaching the risk filter
 *   - PUT /api/settings hot-apply (next message resolves the new file)
 *   - GET /api/settings roundtrip + PUT validation
 *   - GET /api/decisions jsonl parsing, newest-first, ?limit=
 *   - GET /api/callouts history/decision join + Discord-unavailable path
 *   - GET /api/trades/performance with mocked MCP tools + unavailable path
 *   - GET /api/stream SSE framing (snapshot, live decision push, performance)
 */

import { rm } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_DIR = `/tmp/trader-server-test-${process.pid}`;
const SECRET = 'test-webhook-secret';

vi.mock('../../shared/config.js', () => ({
  config: {
    botTraderSecret: 'test-webhook-secret',
    tradeExecutionMode: 'immediate',
    maxNotionalPctPerTrade: 5,
    maxOptionsNotionalPct: 10,
    maxSingleContractPct: 10,
    positionSmallPct: 25,
    positionMediumPct: 50,
    maxTradesPerDay: 100,
    cooldownSecondsPerTicker: 0,
    allowedTickers: [],
    blockedTickers: [],
    minConfidence: 0.7,
    regularHoursOnly: false,
    decisionLogPath: `/tmp/trader-server-test-${process.pid}/decisions.jsonl`,
    riskStatePath: `/tmp/trader-server-test-${process.pid}/risk.json`,
    settingsPath: `/tmp/trader-server-test-${process.pid}/settings.json`,
    rhTokensPath: `/tmp/trader-server-test-${process.pid}/rh-tokens.json`,
  },
  isAllowed: (v: string, allowlist: readonly string[]): boolean =>
    allowlist.length === 0 || allowlist.includes(v),
}));

import type { FastifyInstance } from 'fastify';
import type { Callout, CalloutParser, Decision } from '../../shared/types.js';
import { signWebhookBody } from '../../shared/webhookAuth.js';
import type { CalloutHistory, CalloutMessage } from '../callouts.js';
import { DecisionLog } from '../decisionLog.js';
import type { RobinhoodMcpClient } from '../rh/mcpClient.js';
import type { RobinhoodTools } from '../rh/tools.js';
import { buildServer } from '../server.js';

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

const ENVELOPE = {
  messageId: 'msg-001',
  channelId: 'chan-001',
  guildId: null,
  authorId: 'author-001',
  authorName: 'Demon Alerts',
  content: 'BUY $AAPL',
  timestamp: '2026-07-14T14:30:00.000Z',
};

const EQUITY_CALLOUT: Callout = {
  isCallout: true,
  assetType: 'equity',
  action: 'buy',
  ticker: 'AAPL',
  orderType: 'market',
  limitPrice: null,
  sizeHint: null,
  positionSize: null,
  option: null,
  confidence: 0.9,
  rationale: 'buy AAPL',
};

function makeTools(overrides: Partial<RobinhoodTools> = {}): RobinhoodTools {
  return {
    getBuyingPower: vi.fn().mockResolvedValue({ amountUsd: 10_000 }),
    getQuote: vi.fn().mockResolvedValue({ price: 150 }),
    getOptionsMarkPrice: vi.fn().mockResolvedValue({ markPrice: 0.97 }),
    placeOrder: vi.fn().mockResolvedValue({ orderId: 'eq-001', status: 'queued' }),
    placeOptionsOrder: vi.fn().mockResolvedValue({ orderId: 'opt-001', status: 'queued' }),
    getPositions: vi.fn().mockResolvedValue({ positions: [], raw: {} }),
    getOptionPositions: vi.fn().mockResolvedValue({ positions: [], raw: {} }),
    ...overrides,
  } as unknown as RobinhoodTools;
}

function makeParser(callout: Callout): CalloutParser {
  return { parse: vi.fn().mockResolvedValue(callout) };
}

interface Harness {
  readonly app: FastifyInstance;
  readonly decisions: DecisionLog;
  readonly tools: RobinhoodTools;
  readonly appendSpy: ReturnType<typeof vi.spyOn>;
}

function makeHarness(
  toolsOverrides: Partial<RobinhoodTools> = {},
  callouts: CalloutHistory = { getToday: vi.fn().mockResolvedValue([]) },
  mcp: RobinhoodMcpClient | null = null
): Harness {
  const decisions = new DecisionLog(`${TEST_DIR}/decisions.jsonl`);
  const appendSpy = vi.spyOn(decisions, 'append');
  const tools = makeTools(toolsOverrides);
  const app = buildServer({
    parser: makeParser(EQUITY_CALLOUT),
    tools,
    decisions,
    postReceipt: vi.fn().mockResolvedValue(undefined),
    mcp,
    callouts,
  });
  return { app, decisions, tools, appendSpy };
}

/** POST a signed webhook body and wait for the async pipeline decision. */
async function postWebhook(
  harness: Harness,
  body: Record<string, unknown>
): Promise<Decision> {
  const callsBefore = harness.appendSpy.mock.calls.length;
  const payload = JSON.stringify(body);
  const response = await harness.app.inject({
    method: 'POST',
    url: '/webhook/discord',
    headers: { 'content-type': 'application/json', ...signWebhookBody(payload, SECRET) },
    payload,
  });
  expect(response.statusCode).toBe(202);
  // Generous timeout: the pipeline hits the real fs, so the 1s default can flake.
  await vi.waitFor(
    () => {
      expect(harness.appendSpy.mock.calls.length).toBeGreaterThan(callsBefore);
    },
    { timeout: 5000 }
  );
  return harness.appendSpy.mock.calls.at(-1)![0] as Decision;
}

beforeEach(async () => {
  // Same as riskFilter.test.ts: reset riskFilter's module-level daily
  // counters/cooldown map so state can't leak between tests.
  vi.resetModules();
  await rm(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Webhook: backward compat + settings override
// ---------------------------------------------------------------------------

describe('POST /webhook/discord', () => {
  it('body without settings submits under env defaults', async () => {
    const harness = makeHarness();
    const decision = await postWebhook(harness, { envelope: ENVELOPE });

    expect(decision.kind).toBe('submitted');
    expect(harness.tools.placeOrder).toHaveBeenCalledOnce();
  });

  it('rejects an unsigned request', async () => {
    const harness = makeHarness();
    const response = await harness.app.inject({
      method: 'POST',
      url: '/webhook/discord',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ envelope: ENVELOPE }),
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a bare envelope (pre-wrapper body shape)', async () => {
    const harness = makeHarness();
    const payload = JSON.stringify(ENVELOPE);
    const response = await harness.app.inject({
      method: 'POST',
      url: '/webhook/discord',
      headers: { 'content-type': 'application/json', ...signWebhookBody(payload, SECRET) },
      payload,
    });
    expect(response.statusCode).toBe(400);
  });

  it('emits lifecycle stage events from received through done', async () => {
    const harness = makeHarness();
    const stages: string[] = [];
    harness.decisions.on('stage', (e: { stage: string }) => stages.push(e.stage));

    await postWebhook(harness, { envelope: ENVELOPE });

    expect(stages[0]).toBe('received');
    expect(stages).toContain('executing');
    expect(stages.at(-1)).toBe('done');
  });

  it('per-request settings override reaches the risk filter', async () => {
    const harness = makeHarness();
    const decision = await postWebhook(harness, {
      envelope: ENVELOPE,
      settings: { minConfidence: 0.99 },
    });

    expect(decision.kind).toBe('risk_rejected');
    expect(decision.reason).toMatch(/confidence 0\.90 < threshold 0\.99/);
    expect(harness.tools.placeOrder).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Settings API
// ---------------------------------------------------------------------------

describe('/api/settings', () => {
  it('GET returns env defaults before any settings are stored', async () => {
    const harness = makeHarness();
    const response = await harness.app.inject({ method: 'GET', url: '/api/settings' });
    expect(response.statusCode).toBe(200);
    const { settings } = response.json() as { settings: Record<string, unknown> };
    expect(settings.minConfidence).toBe(0.7);
    expect(settings.executionMode).toBe('immediate');
    expect(settings.maxNotionalPct).toBe(5);
  });

  it('PUT stores validated settings and GET returns them merged over env defaults', async () => {
    const harness = makeHarness();
    const put = await harness.app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ minConfidence: 0.95, maxTradesPerDay: 2 }),
    });
    expect(put.statusCode).toBe(200);

    const get = await harness.app.inject({ method: 'GET', url: '/api/settings' });
    const { settings } = get.json() as { settings: Record<string, unknown> };
    expect(settings.minConfidence).toBe(0.95); // from file
    expect(settings.maxTradesPerDay).toBe(2);  // from file
    expect(settings.maxNotionalPct).toBe(5);   // env default fills the rest
  });

  it('PUT rejects settings that fail schema validation', async () => {
    const harness = makeHarness();
    const response = await harness.app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ minConfidence: 5 }),
    });
    expect(response.statusCode).toBe(400);
  });

  it('PUT rejects unknown keys instead of silently stripping them', async () => {
    const harness = makeHarness();
    const response = await harness.app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ maxTradesperDay: 2 }), // typo'd casing
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid settings' });
  });

  it('PUT hot-applies: the next message resolves against the new file', async () => {
    const harness = makeHarness();

    const before = await postWebhook(harness, { envelope: ENVELOPE });
    expect(before.kind).toBe('submitted');

    const put = await harness.app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ minConfidence: 0.95 }),
    });
    expect(put.statusCode).toBe(200);

    const after = await postWebhook(harness, { envelope: { ...ENVELOPE, messageId: 'msg-002' } });
    expect(after.kind).toBe('risk_rejected');
    expect(after.reason).toMatch(/confidence 0\.90 < threshold 0\.95/);
  });
});

// ---------------------------------------------------------------------------
// Decisions feed
// ---------------------------------------------------------------------------

describe('GET /api/decisions', () => {
  const decisionFixture = (messageId: string, kind: Decision['kind']): Decision => ({
    at: new Date().toISOString(),
    envelope: { ...ENVELOPE, messageId },
    callout: EQUITY_CALLOUT,
    kind,
    code: null,
    reason: `fixture ${messageId}`,
    order:
      kind === 'submitted'
        ? {
            symbol: 'QQQ',
            side: 'buy',
            assetType: 'option',
            quantity: 2,
            orderType: 'limit',
            limitPrice: 0.97,
            option: { optionType: 'put', strike: 710, expiration: '2026-06-08' },
            orderId: 'opt-001',
            status: 'queued',
          }
        : null,
  });

  it('parses the jsonl log and returns newest-first', async () => {
    const harness = makeHarness();
    await harness.decisions.append(decisionFixture('older', 'not_callout'));
    await harness.decisions.append(decisionFixture('newer', 'submitted'));

    const response = await harness.app.inject({ method: 'GET', url: '/api/decisions' });
    expect(response.statusCode).toBe(200);

    const { decisions } = response.json() as { decisions: Decision[] };
    expect(decisions.map((d) => d.envelope.messageId)).toEqual(['newer', 'older']);
    // Trade details incl. strike/expiry survive the roundtrip.
    expect(decisions[0]!.order?.option).toEqual({
      optionType: 'put',
      strike: 710,
      expiration: '2026-06-08',
    });
  });

  it('honours ?limit= and rejects invalid limits', async () => {
    const harness = makeHarness();
    await harness.decisions.append(decisionFixture('one', 'not_callout'));
    await harness.decisions.append(decisionFixture('two', 'not_callout'));

    const limited = await harness.app.inject({ method: 'GET', url: '/api/decisions?limit=1' });
    expect((limited.json() as { decisions: Decision[] }).decisions).toHaveLength(1);

    const invalid = await harness.app.inject({ method: 'GET', url: '/api/decisions?limit=zero' });
    expect(invalid.statusCode).toBe(400);
  });

  it('returns an empty feed when the log does not exist yet', async () => {
    const harness = makeHarness();
    const response = await harness.app.inject({ method: 'GET', url: '/api/decisions' });
    expect(response.json()).toEqual({ decisions: [] });
  });
});

// ---------------------------------------------------------------------------
// Callout history backfill
// ---------------------------------------------------------------------------

describe('GET /api/callouts', () => {
  const calloutFixture = (messageId: string): CalloutMessage => ({
    messageId,
    channelId: 'chan-001',
    channelName: 'alerts',
    authorName: 'Demon Alerts',
    timestamp: '2026-07-15T14:30:00.000Z',
    content: `callout ${messageId}`,
    embeds: [],
  });

  it('joins Discord history with decision-log outcomes on message id', async () => {
    const harness = makeHarness(
      {},
      { getToday: vi.fn().mockResolvedValue([calloutFixture('msg-processed'), calloutFixture('msg-missed')]) }
    );
    await harness.decisions.append({
      at: '2026-07-15T14:30:05.000Z',
      envelope: { ...ENVELOPE, messageId: 'msg-processed' },
      callout: EQUITY_CALLOUT,
      kind: 'submitted',
      code: null,
      reason: 'fixture',
      order: null,
    });

    const response = await harness.app.inject({ method: 'GET', url: '/api/callouts' });
    expect(response.statusCode).toBe(200);

    const { callouts } = response.json() as {
      callouts: Array<{ messageId: string; decision: { kind: string } | null }>;
    };
    expect(callouts).toHaveLength(2);
    expect(callouts.find((c) => c.messageId === 'msg-processed')!.decision).toMatchObject({
      kind: 'submitted',
    });
    // The backfill case: forwarded while the trader was down, never processed.
    expect(callouts.find((c) => c.messageId === 'msg-missed')!.decision).toBeNull();
  });

  it('returns 503 when Discord is unavailable', async () => {
    const harness = makeHarness(
      {},
      { getToday: vi.fn().mockRejectedValue(new Error('discord GET failed: 401')) }
    );
    const response = await harness.app.inject({ method: 'GET', url: '/api/callouts' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: 'discord unavailable' });
  });
});

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------

describe('GET /api/trades/performance', () => {
  it('joins open positions with decision-log entries and live quotes', async () => {
    const harness = makeHarness({
      getPositions: vi.fn().mockResolvedValue({
        positions: [{ symbol: 'AAPL', quantity: 10, raw: {} }],
        raw: {},
      }),
      getOptionPositions: vi.fn().mockResolvedValue({
        positions: [
          {
            symbol: 'QQQ',
            optionType: 'put',
            strike: 710,
            expiration: '2026-06-08',
            quantity: 2,
            raw: {},
          },
        ],
        raw: {},
      }),
      getQuote: vi.fn().mockResolvedValue({ price: 165 }),
      getOptionsMarkPrice: vi.fn().mockResolvedValue({ markPrice: 1.94 }),
    });

    await harness.decisions.append({
      at: new Date().toISOString(),
      envelope: ENVELOPE,
      callout: EQUITY_CALLOUT,
      kind: 'submitted',
      code: null,
      reason: 'fixture',
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
    });
    await harness.decisions.append({
      at: new Date().toISOString(),
      envelope: ENVELOPE,
      callout: EQUITY_CALLOUT,
      kind: 'submitted',
      code: null,
      reason: 'fixture',
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
    });

    const response = await harness.app.inject({ method: 'GET', url: '/api/trades/performance' });
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
    expect(option.currentPrice).toBe(1.94);
    expect(option.pctChange).toBeCloseTo(100);
  });

  it('entry price comes from the buy even when a sell decision is newer', async () => {
    const harness = makeHarness({
      getPositions: vi.fn().mockResolvedValue({
        positions: [{ symbol: 'AAPL', quantity: 5, raw: {} }],
        raw: {},
      }),
      getQuote: vi.fn().mockResolvedValue({ price: 165 }),
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
    await harness.decisions.append({
      at: '2026-07-14T14:00:00.000Z',
      envelope: ENVELOPE,
      callout: EQUITY_CALLOUT,
      kind: 'submitted',
      code: null,
      reason: 'buy fixture',
      order: equityOrder('buy', 150),
    });
    await harness.decisions.append({
      at: '2026-07-14T15:00:00.000Z',
      envelope: { ...ENVELOPE, messageId: 'msg-trim' },
      callout: EQUITY_CALLOUT,
      kind: 'submitted',
      code: null,
      reason: 'trim fixture',
      order: equityOrder('sell', 160),
    });

    const response = await harness.app.inject({ method: 'GET', url: '/api/trades/performance' });
    expect(response.statusCode).toBe(200);

    const { positions } = response.json() as {
      positions: Array<{ symbol: string; entryPrice: number; pctChange: number }>;
    };
    const equity = positions.find((p) => p.symbol === 'AAPL')!;
    expect(equity.entryPrice).toBe(150); // buy, not the newer sell's 160
    expect(equity.pctChange).toBeCloseTo(10);
  });

  it('returns a clear error payload when Robinhood MCP is unavailable', async () => {
    const harness = makeHarness({
      getPositions: vi.fn().mockRejectedValue(new Error('MCP transport closed')),
    });

    const response = await harness.app.inject({ method: 'GET', url: '/api/trades/performance' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: 'robinhood unavailable' });
  });
});

// ---------------------------------------------------------------------------
// Portfolio summary
// ---------------------------------------------------------------------------

describe('GET /api/portfolio', () => {
  it('returns portfolio value and counts only open positions', async () => {
    const harness = makeHarness({
      getBuyingPower: vi.fn().mockResolvedValue({
        amountUsd: 10_000,
        accountNumber: 'acct-1',
        portfolioValueUsd: 25_431.5,
      }),
      getPositions: vi.fn().mockResolvedValue({
        positions: [
          { symbol: 'AAPL', quantity: 10, raw: {} },
          { symbol: 'MSFT', quantity: 0, raw: {} }, // closed — not counted
        ],
        raw: {},
      }),
      getOptionPositions: vi.fn().mockResolvedValue({
        positions: [
          {
            symbol: 'QQQ',
            optionType: 'put',
            strike: 710,
            expiration: '2026-06-08',
            quantity: 2,
            raw: {},
          },
        ],
        raw: {},
      }),
    });

    const response = await harness.app.inject({ method: 'GET', url: '/api/portfolio' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ portfolioValueUsd: 25_431.5, openPositions: 2 });
  });

  it('returns 503 when Robinhood MCP is unavailable', async () => {
    const harness = makeHarness({
      getBuyingPower: vi.fn().mockRejectedValue(new Error('MCP transport closed')),
    });

    const response = await harness.app.inject({ method: 'GET', url: '/api/portfolio' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: 'robinhood unavailable' });
  });
});

// ---------------------------------------------------------------------------
// OAuth-over-dashboard
// ---------------------------------------------------------------------------

function makeMcp(overrides: Partial<RobinhoodMcpClient> = {}): RobinhoodMcpClient {
  return {
    isConnected: vi.fn().mockReturnValue(false),
    getPendingAuthUrl: vi.fn().mockReturnValue('https://robinhood.com/mcp/trading?state=abc'),
    isAuthPending: vi.fn().mockReturnValue(true),
    submitAuthCode: vi.fn(),
    ...overrides,
  } as unknown as RobinhoodMcpClient;
}

describe('GET /api/auth/status', () => {
  it('reports pending auth URL while disconnected', async () => {
    const harness = makeHarness({}, undefined, makeMcp());
    const response = await harness.app.inject({ method: 'GET', url: '/api/auth/status' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      connected: false,
      authUrl: 'https://robinhood.com/mcp/trading?state=abc',
      executionMode: 'immediate',
    });
  });

  it('reports disconnected with no URL when mcp is null (approval mode)', async () => {
    const harness = makeHarness();
    const response = await harness.app.inject({ method: 'GET', url: '/api/auth/status' });
    expect(response.json()).toMatchObject({ connected: false, authUrl: null });
  });
});

describe('POST /api/auth/callback', () => {
  const post = (harness: Harness, body: unknown) =>
    harness.app.inject({
      method: 'POST',
      url: '/api/auth/callback',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });

  it('extracts code and state from the pasted redirect URL', async () => {
    const mcp = makeMcp();
    const harness = makeHarness({}, undefined, mcp);
    const response = await post(harness, {
      redirectUrl: '  http://127.0.0.1:8788/oauth/callback?code=the-code&state=the-state ',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(mcp.submitAuthCode).toHaveBeenCalledWith('the-code', 'the-state');
  });

  it('400s on an unparseable URL and on a URL without a code', async () => {
    const harness = makeHarness({}, undefined, makeMcp());
    expect((await post(harness, { redirectUrl: 'not a url' })).statusCode).toBe(400);
    expect(
      (await post(harness, { redirectUrl: 'http://127.0.0.1:8788/oauth/callback?state=x' }))
        .statusCode
    ).toBe(400);
    expect((await post(harness, { wrong: 'shape' })).statusCode).toBe(400);
  });

  it('409s when no auth is pending or mcp is null', async () => {
    const noPending = makeHarness(
      {},
      undefined,
      makeMcp({ isAuthPending: vi.fn().mockReturnValue(false) })
    );
    const url = 'http://127.0.0.1:8788/oauth/callback?code=x&state=y';
    expect((await post(noPending, { redirectUrl: url })).statusCode).toBe(409);

    const nullMcp = makeHarness();
    expect((await post(nullMcp, { redirectUrl: url })).statusCode).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// SSE stream
// ---------------------------------------------------------------------------

describe('GET /api/stream', () => {
  // inject() can't consume a never-ending hijacked stream, so listen on an
  // ephemeral port and read real SSE frames over http.
  it('streams a decisions snapshot, live appends, and performance frames', async () => {
    const harness = makeHarness();
    await harness.decisions.append({
      at: new Date().toISOString(),
      envelope: ENVELOPE,
      callout: EQUITY_CALLOUT,
      kind: 'not_callout',
      code: 'not_callout',
      reason: 'seed',
      order: null,
    });

    await harness.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = harness.app.server.address() as { port: number };
    const abort = new AbortController();

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/stream`, {
        signal: abort.signal,
        headers: { origin: 'http://localhost:3001' },
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

      // A new append pushes a fresh decisions frame.
      await harness.decisions.append({
        at: new Date().toISOString(),
        envelope: { ...ENVELOPE, messageId: 'msg-live' },
        callout: EQUITY_CALLOUT,
        kind: 'not_callout',
        code: 'not_callout',
        reason: 'live-push',
        order: null,
      });
      await readUntil((t) => t.includes('"reason":"live-push"'));

      // Lifecycle stage events are forwarded as `stage` frames.
      harness.decisions.emitStage({ messageId: 'msg-live', ticker: 'AAPL', stage: 'executing' });
      await readUntil((t) => t.includes('event: stage') && t.includes('"stage":"executing"'));
    } finally {
      abort.abort();
      await harness.app.close();
    }
  }, 10_000);
});
