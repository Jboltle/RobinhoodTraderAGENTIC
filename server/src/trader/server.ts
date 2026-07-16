/**
 * Trader HTTP server: signed Discord webhook + REST API (decisions feed,
 * position performance, runtime trade settings).
 *
 * Kept separate from index.ts (which auto-runs main() on import) so routes can
 * be tested with fastify.inject and mocked deps.
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
import { joinDecisions, type CalloutHistory } from './callouts.js';
import { runPipeline, type PipelineDeps } from './pipeline/index.js';
import type { RobinhoodMcpClient } from './rh/mcpClient.js';
import { readTokenStatus } from './rh/tokenBootstrap.js';
import { resolveSettings, writeSettingsFile } from './settings.js';

const log = createLogger('trader:server');

const DEFAULT_DECISIONS_LIMIT = 50;
// ponytail: fixed cadences — matches the old client poll rate; make these
// settings if anyone ever needs to tune them.
const SSE_PERFORMANCE_INTERVAL_MS = 5000;
const SSE_HEARTBEAT_INTERVAL_MS = 20_000;

/**
 * Webhook body = `{ envelope, settings? }`. The bot signs and sends the whole
 * wrapper; `settings` is an optional per-message override (absent = env/file
 * defaults). HMAC verification is over the raw body string, so both sides
 * changed shape together (see src/bot/forwarder.ts).
 */
const WebhookBodySchema = z.object({
  envelope: DiscordEnvelopeSchema,
  settings: TradeSettingsSchema.optional(),
});

export interface ServerDeps extends PipelineDeps {
  readonly mcp: RobinhoodMcpClient | null;
  readonly callouts: CalloutHistory;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  // Serialize pipeline so we never have two trades in flight on the same session.
  let chain: Promise<void> = Promise.resolve();

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

  fastify.post('/webhook/discord', async (request, reply) => {
    const rawBody = (request as { rawBody?: string }).rawBody ?? JSON.stringify(request.body);
    const auth = verifyWebhookBody(rawBody, request.headers, config.botTraderSecret);
    if (!auth.ok) {
      log.warn('webhook: rejected - unauthorized', { reason: auth.reason });
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const result = WebhookBodySchema.safeParse(request.body);
    if (!result.success) {
      log.warn('webhook: rejected — invalid envelope', {
        error: result.error.message,
      });
      return reply.status(400).send({ error: 'invalid envelope' });
    }

    const { envelope, settings } = result.data;
    log.info('webhook: received callout candidate', {
      messageId: envelope.messageId,
      author: envelope.authorName,
      channel: envelope.channelId,
      hasSettingsOverride: settings !== undefined,
    });

    deps.decisions.emitStage({ messageId: envelope.messageId, ticker: null, stage: 'received' });

    // Acknowledge immediately; the pipeline runs async so the bot never times out.
    chain = chain
      .then(() => runPipeline(envelope, deps, settings))
      .then(() => undefined)
      .catch((err) =>
        log.error('pipeline crashed', {
          messageId: envelope.messageId,
          error: (err as Error).message,
        })
      );

    return reply.status(202).send({ ok: true });
  });

  fastify.get('/health', async (_request, reply) => {
    const tokenStatus = deps.mcp ? await readTokenStatus(config.rhTokensPath) : null;
    return reply.send({
      ok: true,
      executionMode: config.tradeExecutionMode,
      rhConnected: deps.mcp?.isConnected() ?? false,
      rhTokenState: tokenStatus?.state ?? null,
      rhTokenExpiresInSec: tokenStatus?.expiresInSec ?? null,
      rhTools: deps.mcp?.getToolNames() ?? [],
    });
  });

  // Returns decisions newest-first (dashboard shows the latest activity on top).
  fastify.get('/api/decisions', async (request, reply) => {
    const limitRaw = (request.query as { limit?: string }).limit;
    const limit = limitRaw === undefined ? DEFAULT_DECISIONS_LIMIT : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1) {
      return reply.status(400).send({ error: 'limit must be a positive integer' });
    }
    const all = await deps.decisions.readAll();
    return reply.send({ decisions: all.reverse().slice(0, limit) });
  });

  // Today's Discord message history joined with pipeline outcomes. Backfills
  // the dashboard feed with callouts that never reached the webhook (e.g.
  // trader downtime); display-only, never enters the trade pipeline.
  fastify.get('/api/callouts', async (_request, reply) => {
    try {
      const [messages, decisions] = await Promise.all([
        deps.callouts.getToday(),
        deps.decisions.readAll(),
      ]);
      return reply.send({ callouts: joinDecisions(messages, decisions) });
    } catch (err) {
      return reply
        .status(503)
        .send({ error: 'discord unavailable', detail: (err as Error).message });
    }
  });

  // Resolved persistent settings: state/settings.json merged over env defaults
  // (per-message payload overrides are not persistent and don't appear here).
  fastify.get('/api/settings', async (_request, reply) => {
    return reply.send({ settings: await resolveSettings() });
  });

  fastify.put('/api/settings', async (request, reply) => {
    // strict(): a typo'd key ("maxTradesperDay") must 400, not be silently
    // stripped. The webhook settings override stays non-strict for forward compat.
    const parsed = TradeSettingsSchema.strict().safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid settings', detail: parsed.error.message });
    }
    // Hot-apply for free: each message re-reads the file during resolution.
    await writeSettingsFile(parsed.data);
    return reply.send({ settings: parsed.data });
  });

  // Account snapshot for the dashboard header: total portfolio value plus a
  // count of open (quantity > 0) equity + option positions.
  fastify.get('/api/portfolio', async (_request, reply) => {
    try {
      const [buyingPower, equity, options] = await Promise.all([
        deps.tools.getBuyingPower(),
        deps.tools.getPositions(),
        deps.tools.getOptionPositions(),
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

  fastify.get('/api/trades/performance', async (_request, reply) => {
    try {
      return reply.send({ positions: await collectPerformance(deps) });
    } catch (err) {
      return reply
        .status(503)
        .send({ error: 'robinhood unavailable', detail: (err as Error).message });
    }
  });

  // SSE stream for the dashboard: replaces client-side polling of
  // /api/decisions and /api/trades/performance (both kept for curl/fallback).
  // Events: `decisions` (snapshot on connect + on every append, newest-first),
  // `performance` ({ positions, error } every 5s while connected), and `stage`
  // (live trade lifecycle: received → parsing → risk_check → executing → done).
  fastify.get('/api/stream', (request, reply) => {
    // Raw SSE writing bypasses Fastify's send path, so @fastify/cors headers
    // are lost — reflect the origin manually (simple GET, no preflight).
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
      void deps.decisions
        .readAll()
        .then((all) => send('decisions', all.reverse().slice(0, DEFAULT_DECISIONS_LIMIT)));
    };

    const pushPerformance = async (): Promise<void> => {
      try {
        send('performance', { positions: await collectPerformance(deps), error: null });
      } catch (err) {
        // Robinhood MCP down/unauthed: keep the stream alive with an error shape.
        send('performance', { positions: null, error: (err as Error).message });
      }
    };

    // Live trade lifecycle (received → parsing → risk_check → executing → done).
    const pushStage = (event: unknown): void => send('stage', event);

    pushDecisions();
    void pushPerformance();
    deps.decisions.on('decision', pushDecisions);
    deps.decisions.on('stage', pushStage);
    // ponytail: per-connection timers — N clients means N× Robinhood quote
    // traffic. Fine for a single-user dashboard; upgrade path is one shared
    // broadcast loop gated on client count. Zero clients = zero timers either way.
    const performanceTimer = setInterval(() => void pushPerformance(), SSE_PERFORMANCE_INTERVAL_MS);
    const heartbeatTimer = setInterval(
      () => reply.raw.write(': heartbeat\n\n'),
      SSE_HEARTBEAT_INTERVAL_MS
    );

    request.raw.on('close', () => {
      clearInterval(performanceTimer);
      clearInterval(heartbeatTimer);
      deps.decisions.off('decision', pushDecisions);
      deps.decisions.off('stage', pushStage);
      reply.raw.end();
    });
  });

  return fastify;
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
   * Entry from the decision log's most recent submitted order for the position.
   * ponytail: uses the order's limitPrice, so market fills report null — the
   * decision log doesn't capture fill prices. Upgrade path: poll the broker's
   * order status after submit and log the executed price.
   */
  readonly entryPrice: number | null;
  readonly currentPrice: number | null;
  readonly pctChange: number | null;
}

async function collectPerformance(deps: ServerDeps): Promise<PerformanceRow[]> {
  const [equity, options, allDecisions] = await Promise.all([
    deps.tools.getPositions(),
    deps.tools.getOptionPositions(),
    deps.decisions.readAll(),
  ]);
  // Newest first, so find() picks the most recent entry for a position.
  const submitted = allDecisions.filter((d) => d.kind === 'submitted' && d.order).reverse();

  const rows: PerformanceRow[] = [];

  for (const position of equity.positions) {
    if (position.quantity <= 0) continue;
    const entryPrice = findEquityEntry(submitted, position.symbol);
    const currentPrice = await deps.tools.getQuote(position.symbol).then((q) => q.price);
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
    const quote = await deps.tools.getOptionsMarkPrice(
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
