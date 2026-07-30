/**
 * Trader HTTP server: signed Discord webhook + per-user REST API (feed,
 * position performance, trade settings, Robinhood connection).
 *
 * Every /api route runs behind the Supabase JWT hook in auth.ts and reads or
 * writes only the acting user's rows. Kept separate from index.ts (which
 * auto-runs main() on import) so routes can be tested with fastify.inject and
 * mocked deps.
 */
import fastifyCors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

import { config } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';
import {
  DiscordEnvelopeSchema,
  TradeSettingsSchema,
  type Decision,
} from '../shared/types.js';
import { verifyWebhookBody } from '../shared/webhookAuth.js';
import { registerAuth, requireUser } from './auth.js';
import type { StoredCallout, TraderDb } from './db.js';
import type { TraderEvents } from './events.js';
import type { MessageProcessor } from './pipeline/index.js';
import type { McpRegistry, UserBroker } from './rh/mcpRegistry.js';
import type { RobinhoodTools } from './rh/tools.js';

const log = createLogger('trader:server');

const DEFAULT_DECISIONS_LIMIT = 50;
const DEFAULT_CALLOUTS_LIMIT = 100;
/**
 * How far back the performance view looks for the order that opened a
 * position. Deeper than the feed page: a position held for weeks still needs
 * its entry price, and the feed's 50 rows would lose it.
 */
const PERFORMANCE_HISTORY_LIMIT = 500;
// ponytail: fixed cadences — matches the old client poll rate; make these
// settings if anyone ever needs to tune them.
const SSE_PERFORMANCE_INTERVAL_MS = 5000;
const SSE_HEARTBEAT_INTERVAL_MS = 20_000;
/** How long POST /api/broker/connect waits for Robinhood to hand us a URL. */
const AUTH_URL_TIMEOUT_MS = 15_000;
const AUTH_URL_POLL_MS = 100;

/**
 * Webhook body = `{ envelope }`. The bot signs and sends the whole wrapper and
 * HMAC verification is over the raw body string, so both sides change shape
 * together (see src/bot/forwarder.ts). Trade settings are per user and live in
 * the database, so no settings ride along with a message any more.
 */
const WebhookBodySchema = z.object({ envelope: DiscordEnvelopeSchema });

/** Full redirect URL the user copied from the dead-end 127.0.0.1 tab. */
const BrokerCallbackBodySchema = z.object({ redirectUrl: z.string() });

const MagicLinkBodySchema = z.object({ email: z.email() });

export interface ServerDeps {
  readonly db: TraderDb;
  readonly events: TraderEvents;
  readonly brokers: McpRegistry;
  readonly processor: MessageProcessor;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const fastify = Fastify({ logger: false });

  // Browser dashboard (client/) calls /api/* cross-origin.
  // ponytail: registered instance-wide because @fastify/cors has no per-path
  // filter; /webhook is HMAC-protected and /health is public, so the extra
  // scope is harmless. Upgrade path: move /api routes into a prefixed scope.
  fastify.register(fastifyCors, { origin: true, methods: ['GET', 'PUT', 'POST'] });

  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    try {
      (request as { rawBody?: string }).rawBody = body as string;
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error);
    }
  });

  registerAuth(fastify, deps.db);

  // ---- Public -----------------------------------------------------------------

  fastify.post('/webhook/discord', async (request, reply) => {
    const rawBody = (request as { rawBody?: string }).rawBody ?? JSON.stringify(request.body);
    const auth = verifyWebhookBody(rawBody, request.headers, config.botTraderSecret);
    if (!auth.ok) {
      log.warn('webhook: rejected - unauthorized', { reason: auth.reason });
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const result = WebhookBodySchema.safeParse(request.body);
    if (!result.success) {
      log.warn('webhook: rejected — invalid envelope', { error: result.error.message });
      return reply.status(400).send({ error: 'invalid envelope' });
    }

    const { envelope } = result.data;
    log.info('webhook: received callout candidate', {
      messageId: envelope.messageId,
      author: envelope.authorName,
      channel: envelope.channelId,
    });

    // Acknowledge immediately; the fan-out runs async so the bot never times
    // out. Per-user ordering is preserved inside the processor.
    void deps.processor.process(envelope).catch((err: unknown) =>
      log.error('fan-out crashed', {
        messageId: envelope.messageId,
        error: (err as Error).message,
      })
    );

    return reply.status(202).send({ ok: true });
  });

  // Keep-alive target for the supervisor's self-ping (src/index.ts) and the
  // platform health check. Its liveness signal is whether it answers at all,
  // not what it says: src/index.ts runs the bot in the same process tree and
  // tears the tree down if the bot dies, so a dead Gateway means this stops
  // responding. The
  // body is diagnostics only — the execution kill-switch is the one piece of
  // process-wide state worth reading without an account.
  fastify.get('/health', async (_request, reply) => {
    return reply.send({ ok: true, executionMode: config.tradeExecutionMode });
  });

  // Sign-in is an emailed magic link; there are no passwords. The allowlist is
  // checked here rather than in the browser so the client can't skip it, and
  // accounts are only ever created here (via the admin API) — self-serve
  // Supabase signups stay disabled.
  fastify.post('/api/auth/magic-link', async (request, reply) => {
    const parsed = MagicLinkBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'body must be { email: string }' });
    }
    const { email } = parsed.data;
    if (!(await deps.db.isEmailAllowed(email))) {
      log.warn('magic link rejected: email not on the allowlist', { email });
      return reply.status(403).send({ error: 'this email is not invited' });
    }
    await deps.db.ensureUser(email);
    await deps.db.sendMagicLink(email);
    log.info('sent sign-in link', { email });
    return reply.send({ ok: true });
  });

  // ---- Robinhood connection (per user) ----------------------------------------

  fastify.get('/api/broker/status', async (request, reply) => {
    const { id: userId } = requireUser(request);
    const broker = deps.brokers.existing(userId);
    const tokens = broker ? await broker.mcp.getTokenStatus() : null;
    return reply.send({
      connected: broker?.mcp.isConnected() ?? false,
      authUrl: broker?.mcp.getPendingAuthUrl() ?? null,
      tokenState: tokens?.state ?? null,
      executionMode: config.tradeExecutionMode,
    });
  });

  // Robinhood only allows loopback redirect URIs, so on a deployed server the
  // post-consent redirect dead-ends on the user's own 127.0.0.1. The dashboard
  // opens the URL returned here, the user approves, then pastes the dead-end
  // redirect URL into POST /api/broker/callback.
  fastify.post('/api/broker/connect', async (request, reply) => {
    const { id: userId } = requireUser(request);
    const broker = deps.brokers.for(userId);
    if (broker.mcp.isConnected()) {
      return reply.send({ connected: true, authUrl: null });
    }

    // ensureConnected only resolves once the whole OAuth dance finishes, which
    // needs the paste this endpoint's caller hasn't made yet — so kick it off
    // and wait only for the authorization URL it produces on the way.
    void broker.mcp.ensureConnected().catch((err: unknown) =>
      log.warn('Robinhood connect failed', { userId, error: (err as Error).message })
    );

    const authUrl = await waitForAuthUrl(broker);
    if (!authUrl) {
      return reply
        .status(504)
        .send({ error: 'Robinhood did not return an authorization URL in time' });
    }
    return reply.send({ connected: false, authUrl });
  });

  fastify.post('/api/broker/callback', async (request, reply) => {
    const { id: userId } = requireUser(request);
    const parsed = BrokerCallbackBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'body must be { redirectUrl: string }' });
    }
    let url: URL;
    try {
      url = new URL(parsed.data.redirectUrl.trim());
    } catch {
      return reply.status(400).send({ error: 'redirectUrl is not a valid URL' });
    }
    const code = url.searchParams.get('code');
    if (!code) {
      return reply.status(400).send({ error: 'redirectUrl has no code parameter' });
    }
    const broker = deps.brokers.existing(userId);
    if (!broker || !broker.mcp.isAuthPending()) {
      return reply.status(409).send({ error: 'no OAuth authorization is pending' });
    }
    broker.mcp.submitAuthCode(code, url.searchParams.get('state'));
    // Token exchange happens asynchronously inside the pending connect();
    // the client polls /api/broker/status until `connected` flips.
    return reply.send({ ok: true });
  });

  fastify.post('/api/broker/disconnect', async (request, reply) => {
    const { id: userId } = requireUser(request);
    await deps.db.deleteBrokerTokens(userId);
    deps.brokers.drop(userId);
    return reply.send({ ok: true });
  });

  // ---- Feed --------------------------------------------------------------------

  // This user's trade outcomes, newest-first.
  fastify.get('/api/decisions', async (request, reply) => {
    const { id: userId } = requireUser(request);
    const limitRaw = (request.query as { limit?: string }).limit;
    const limit = limitRaw === undefined ? DEFAULT_DECISIONS_LIMIT : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1) {
      return reply.status(400).send({ error: 'limit must be a positive integer' });
    }
    return reply.send({ decisions: await deps.db.listDecisions(userId, limit) });
  });

  // Every callout the pipeline has seen, each carrying THIS user's outcome.
  // The callouts themselves are shared; the decision attached to them is not.
  fastify.get('/api/callouts', async (request, reply) => {
    const { id: userId } = requireUser(request);
    return reply.send({ callouts: await loadFeed(deps, userId) });
  });

  // ---- Settings -----------------------------------------------------------------

  fastify.get('/api/settings', async (request, reply) => {
    const { id: userId } = requireUser(request);
    return reply.send({ settings: await deps.db.getSettings(userId) });
  });

  fastify.put('/api/settings', async (request, reply) => {
    const { id: userId } = requireUser(request);
    // strict(): a typo'd key ("maxTradesperDay") must 400, not be silently
    // stripped and leave the user thinking they raised a limit they didn't.
    const parsed = TradeSettingsSchema.strict().safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid settings', detail: parsed.error.message });
    }
    return reply.send({ settings: await deps.db.saveSettings(userId, parsed.data) });
  });

  // ---- Portfolio ------------------------------------------------------------------

  // Account snapshot for the dashboard header: total portfolio value plus a
  // count of open (quantity > 0) equity + option positions.
  fastify.get('/api/portfolio', async (request, reply) => {
    const { id: userId } = requireUser(request);
    try {
      const tools = deps.brokers.for(userId).tools;
      const [buyingPower, equity, options] = await Promise.all([
        tools.getBuyingPower(),
        tools.getPositions(),
        tools.getOptionPositions(),
      ]);
      const openPositions =
        equity.positions.filter((p) => p.quantity > 0).length +
        options.positions.filter((p) => p.quantity > 0).length;
      return reply.send({
        portfolioValueUsd: buyingPower.portfolioValueUsd,
        openPositions,
      });
    } catch (err) {
      return reply
        .status(503)
        .send({ error: 'robinhood unavailable', detail: (err as Error).message });
    }
  });

  fastify.get('/api/trades/performance', async (request, reply) => {
    const { id: userId } = requireUser(request);
    try {
      return reply.send({ positions: await collectPerformance(deps, userId) });
    } catch (err) {
      return reply
        .status(503)
        .send({ error: 'robinhood unavailable', detail: (err as Error).message });
    }
  });

  // ---- Live stream ------------------------------------------------------------------

  // SSE stream for the dashboard: replaces client-side polling of
  // /api/decisions and /api/trades/performance (both kept for curl/fallback).
  // Events: `decisions` (snapshot on connect + on every append, newest-first),
  // `performance` ({ positions, error } every 5s while connected), and `stage`
  // (live trade lifecycle: received → parsing → risk_check → executing → done).
  //
  // Read with fetch, not EventSource, so it carries the same Authorization
  // header as every other route (see client/src/lib/stream.ts).
  fastify.get('/api/stream', (request, reply) => {
    const { id: userId } = requireUser(request);

    // Raw SSE writing bypasses Fastify's send path, so @fastify/cors headers
    // are lost — reflect the origin manually.
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': request.headers.origin ?? '*',
    });

    const send = (event: string, data: unknown): void => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const pushDecisions = (): void => {
      void deps.db
        .listDecisions(userId, DEFAULT_DECISIONS_LIMIT)
        .then((decisions) => send('decisions', decisions))
        .catch((err: unknown) =>
          log.warn('could not push decisions frame', { error: (err as Error).message })
        );
    };

    const pushPerformance = async (): Promise<void> => {
      try {
        send('performance', { positions: await collectPerformance(deps, userId), error: null });
      } catch (err) {
        // Robinhood MCP down/unauthed: keep the stream alive with an error shape.
        send('performance', { positions: null, error: (err as Error).message });
      }
    };

    pushDecisions();
    void pushPerformance();
    const unsubscribe = deps.events.subscribe(userId, {
      onDecision: pushDecisions,
      onStage: (event) => send('stage', event),
    });

    // ponytail: per-connection timers — N clients means N× Robinhood quote
    // traffic. Fine at invite-only scale; upgrade path is one shared broadcast
    // loop per user gated on client count. Zero clients = zero timers either way.
    const performanceTimer = setInterval(() => void pushPerformance(), SSE_PERFORMANCE_INTERVAL_MS);
    const heartbeatTimer = setInterval(
      () => reply.raw.write(': heartbeat\n\n'),
      SSE_HEARTBEAT_INTERVAL_MS
    );

    request.raw.on('close', () => {
      clearInterval(performanceTimer);
      clearInterval(heartbeatTimer);
      unsubscribe();
      reply.raw.end();
    });
  });

  return fastify;
}

// =============================================================================
// Feed
// =============================================================================

/** A shared callout plus the acting user's outcome for it (null = not acted on). */
export interface CalloutFeedItem extends StoredCallout {
  readonly decision: Decision | null;
}

async function loadFeed(deps: ServerDeps, userId: string): Promise<CalloutFeedItem[]> {
  const callouts = await deps.db.listCallouts(DEFAULT_CALLOUTS_LIMIT);
  const decisions = await deps.db.decisionsByMessageId(
    userId,
    callouts.map((c) => c.messageId)
  );
  return callouts.map((callout) => ({
    ...callout,
    decision: decisions.get(callout.messageId) ?? null,
  }));
}

async function waitForAuthUrl(broker: UserBroker): Promise<string | null> {
  const deadline = Date.now() + AUTH_URL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const authUrl = broker.mcp.getPendingAuthUrl();
    if (authUrl) return authUrl;
    // Already-valid stored tokens finish the connect with no consent step.
    if (broker.mcp.isConnected()) return null;
    await new Promise((resolve) => setTimeout(resolve, AUTH_URL_POLL_MS));
  }
  return null;
}

// =============================================================================
// Position performance
// =============================================================================

interface PerformanceRow {
  readonly assetType: 'equity' | 'option';
  readonly symbol: string;
  readonly quantity: number;
  readonly optionType?: 'call' | 'put';
  readonly strike?: number;
  readonly expiration?: string;
  /**
   * Entry from the user's most recent submitted order for the position.
   * ponytail: uses the order's limitPrice, so market fills report null — the
   * trades table doesn't capture fill prices. Upgrade path: poll the broker's
   * order status after submit and record the executed price.
   */
  readonly entryPrice: number | null;
  readonly currentPrice: number | null;
  readonly pctChange: number | null;
}

async function collectPerformance(deps: ServerDeps, userId: string): Promise<PerformanceRow[]> {
  const tools: RobinhoodTools = deps.brokers.for(userId).tools;
  const [equity, options, decisions] = await Promise.all([
    tools.getPositions(),
    tools.getOptionPositions(),
    deps.db.listDecisions(userId, PERFORMANCE_HISTORY_LIMIT),
  ]);
  // Already newest-first, so find() picks the most recent entry for a position.
  const submitted = decisions.filter((d) => d.kind === 'submitted' && d.order);

  const rows: PerformanceRow[] = [];

  for (const position of equity.positions) {
    if (position.quantity <= 0) continue;
    const entryPrice = findEquityEntry(submitted, position.symbol);
    const currentPrice = await tools.getQuote(position.symbol).then((q) => q.price);
    rows.push({
      assetType: 'equity',
      symbol: position.symbol,
      quantity: position.quantity,
      entryPrice,
      currentPrice,
      pctChange: pctChange(entryPrice, currentPrice),
    });
  }

  for (const position of options.positions) {
    if (position.quantity <= 0) continue;
    const entryPrice = findOptionEntry(submitted, position);
    const quote = await tools.getOptionsMarkPrice(
      position.symbol,
      position.optionType,
      position.strike,
      position.expiration
    );
    const currentPrice = quote?.markPrice ?? null;
    rows.push({
      assetType: 'option',
      symbol: position.symbol,
      quantity: position.quantity,
      optionType: position.optionType,
      strike: position.strike,
      expiration: position.expiration,
      entryPrice,
      currentPrice,
      pctChange: pctChange(entryPrice, currentPrice),
    });
  }

  return rows;
}

function findEquityEntry(submitted: readonly Decision[], symbol: string): number | null {
  const match = submitted.find(
    (d) => d.order!.side === 'buy' && d.order!.assetType === 'equity' && d.order!.symbol === symbol
  );
  return match?.order?.limitPrice ?? null;
}

function findOptionEntry(
  submitted: readonly Decision[],
  position: { symbol: string; optionType: 'call' | 'put'; strike: number; expiration: string }
): number | null {
  const match = submitted.find((d) => {
    const order = d.order!;
    return (
      order.side === 'buy' &&
      order.assetType === 'option' &&
      order.symbol === position.symbol &&
      order.option !== null &&
      order.option.optionType === position.optionType &&
      Math.abs(order.option.strike - position.strike) < 0.0001 &&
      order.option.expiration === position.expiration
    );
  });
  return match?.order?.limitPrice ?? null;
}

const pctChange = (entry: number | null, current: number | null): number | null =>
  entry !== null && current !== null && entry > 0 ? ((current - entry) / entry) * 100 : null;
