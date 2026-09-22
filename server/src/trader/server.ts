/**
 * Trader HTTP server: the per-user REST API (feed, position performance,
 * trade settings, Robinhood connection). Message ingestion does not pass
 * through HTTP any more — the poller reads the `messages` table directly.
 *
 * Every /api route runs behind the Supabase JWT hook in auth.ts and reads or
 * writes only the acting user's rows. Kept separate from index.ts (which
 * auto-runs main() on import) so routes can be tested with fastify.inject and
 * mocked deps.
 */
import fastifyCors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

import { createLogger, errorFields } from '../shared/logger.js';
import {
  TradeSettingsSchema,
  type AssetType,
  type Decision,
  type OptionType,
} from '../shared/types.js';
import { registerAuth, requireUser } from './auth.js';
import type { ApprovalOutcome, StoredCallout, TraderDb } from './db.js';
import type { TraderEvents } from './events.js';
import { findEquityEntry, findOptionEntry } from './maxLoss.js';
import { submitOrder } from './pipeline/execute.js';
import { summarize } from './pipeline/summarize.js';
import {
  DEFAULT_RECAP_WINDOW_DAYS,
  RECAP_WINDOW_DAYS_CHOICES,
  computeRecapPerformance,
  isoDateDaysAgo,
} from './recaps/analytics.js';
import { readTokenStatus } from './rh/mcpClient.js';
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

/** Full redirect URL the user copied from the dead-end 127.0.0.1 tab. */
const BrokerCallbackBodySchema = z.object({ redirectUrl: z.string() });

const MagicLinkBodySchema = z.object({ email: z.email() });

export interface ServerDeps {
  readonly db: TraderDb;
  readonly events: TraderEvents;
  readonly brokers: McpRegistry;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const fastify = Fastify({ logger: false });

  // Browser dashboard (client/) calls /api/* cross-origin.
  // ponytail: registered instance-wide because @fastify/cors has no per-path
  // filter; /webhook is HMAC-protected and /health is public, so the extra
  // scope is harmless. Upgrade path: move /api routes into a prefixed scope.
  fastify.register(fastifyCors, { origin: true, methods: ['GET', 'PUT', 'POST'] });

  registerAuth(fastify, deps.db);

  // ---- Public -----------------------------------------------------------------

  // Keep-alive target for the supervisor's self-ping (src/index.ts) and the
  // platform health check. Its liveness signal is whether it answers at all,
  // not what it says: src/index.ts runs the Listener in the same process tree
  // and tears the tree down if it dies, so a dead Gateway means this stops
  // responding. executionMode is per-user (settings.payload), not process-wide.
  fastify.get('/health', async (_request, reply) => {
    return reply.send({ ok: true });
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
    let step = 'allowlist';
    try {
      if (!(await deps.db.isEmailAllowed(email))) {
        log.warn('magic link rejected: email not on the allowlist', { email });
        return reply.status(403).send({ error: 'this email is not invited' });
      }
      step = 'ensureUser';
      await deps.db.ensureUser(email);
      step = 'sendMagicLink';
      await deps.db.sendMagicLink(email);
    } catch (err) {
      log.error('magic-link failed', { email, step, ...errorFields(err) });
      return reply.status(500).send({ error: 'could not send sign-in link' });
    }
    log.info('sent sign-in link', { email });
    return reply.send({ ok: true });
  });

  // ---- Robinhood connection (per user) ----------------------------------------

  fastify.get('/api/broker/status', async (request, reply) => {
    const { id: userId } = requireUser(request);
    const broker = deps.brokers.existing(userId);
    // The connection of record is the user's broker_connections row, not the
    // in-memory session: stored tokens survive restarts and are what the
    // pipeline fans out over. A user with tokens but no warm session is still
    // connected — trading recreates the session lazily from those tokens.
    const stored = await deps.db.getBrokerTokens(userId);
    const tokens = readTokenStatus(stored?.tokens);
    const settings = await deps.db.getSettings(userId);
    return reply.send({
      connected:
        tokens.state === 'valid' ||
        tokens.state === 'refreshable' ||
        (broker?.mcp.isConnected() ?? false),
      authUrl: broker?.mcp.getPendingAuthUrl() ?? null,
      tokenState: tokens.state,
      executionMode: settings.executionMode,
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

  // ---- Approval ------------------------------------------------------------
  //
  // A pending_approval row is a fully-sized order that was never submitted.
  // Approving submits exactly the quantity that was sized when the callout
  // arrived: the risk rules already ran then, and re-running them here would
  // mean a trade the user explicitly said yes to could still silently vanish.
  // The trade-off is that approving a backlog can outrun maxTradesPerDay or
  // reach past the closing bell.

  fastify.post('/api/trades/:messageId/approve', async (request, reply) => {
    const { id: userId } = requireUser(request);
    const { messageId } = request.params as { messageId: string };

    const pending = await findPendingApproval(deps, userId, messageId);
    if (pending === null) {
      return reply.status(404).send({ error: 'no trade awaiting approval for that callout' });
    }
    if (pending.order === null) {
      return reply.status(409).send({ error: 'that trade has no sized order to submit' });
    }

    const approvedAt = new Date().toISOString();
    const tools = deps.brokers.for(userId).tools;
    let outcome: ApprovalOutcome;
    try {
      const placed = await submitOrder(pending.order, tools);
      const order = {
        ...pending.order,
        orderId: placed.orderId,
        status: placed.status ?? 'submitted',
      };
      outcome = {
        kind: 'submitted',
        code: null,
        reason: `Approved — ${summarize(order, null)}`,
        order,
        approvedAt,
      };
    } catch (err) {
      outcome = {
        kind: 'execution_failed',
        code: 'execution_error',
        reason: (err as Error).message,
        order: pending.order,
        approvedAt,
      };
    }

    return reply.send(await applyApproval(deps, userId, messageId, pending, outcome));
  });

  fastify.post('/api/trades/:messageId/reject', async (request, reply) => {
    const { id: userId } = requireUser(request);
    const { messageId } = request.params as { messageId: string };

    const pending = await findPendingApproval(deps, userId, messageId);
    if (pending === null) {
      return reply.status(404).send({ error: 'no trade awaiting approval for that callout' });
    }

    return reply.send(
      await applyApproval(deps, userId, messageId, pending, {
        kind: 'rejected',
        code: null,
        reason: 'Rejected — no order submitted.',
        order: pending.order,
        approvedAt: new Date().toISOString(),
      })
    );
  });

  // The Caller roster for the settings Following picker. Shared rows, same
  // for every user; auth is still required like every other /api route.
  fastify.get('/api/callers', async (request, reply) => {
    requireUser(request);
    return reply.send({ callers: await deps.db.listCallers() });
  });

  // Performance & Metrix: caller stats computed from parsed daily recaps.
  // Shared data (same for every user), auth still required. Stats are
  // recomputed per request — a year of recaps is a few thousand trades — and
  // the AI narration is read from its cache, never generated inline.
  fastify.get('/api/recaps/performance', async (request, reply) => {
    requireUser(request);
    const daysRaw = (request.query as { days?: string }).days;
    const days = daysRaw === undefined ? DEFAULT_RECAP_WINDOW_DAYS : Number(daysRaw);
    if (!RECAP_WINDOW_DAYS_CHOICES.includes(days)) {
      return reply
        .status(400)
        .send({ error: `days must be one of ${RECAP_WINDOW_DAYS_CHOICES.join(', ')}` });
    }
    const recaps = await deps.db.listRecapsSince(isoDateDaysAgo(days));
    return reply.send({
      performance: computeRecapPerformance(recaps, days),
      insight: await deps.db.getRecapInsight(days),
    });
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
        buyingPowerUsd: buyingPower.amountUsd,
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
// Approval
// =============================================================================

/** This user's decision for a callout, but only if it is awaiting approval. */
async function findPendingApproval(
  deps: ServerDeps,
  userId: string,
  messageId: string
): Promise<Decision | null> {
  const decisions = await deps.db.decisionsByMessageId(userId, [messageId]);
  const decision = decisions.get(messageId);
  return decision?.kind === 'pending_approval' ? decision : null;
}

/**
 * Commit an approval outcome to the pending row and push it to the dashboard.
 *
 * The write is a compare-and-set on `kind = 'pending_approval'`, so two clicks
 * racing each other cannot both win. The loser still gets the decision back
 * rather than an error: the trade did get approved, just not by that request.
 */
async function applyApproval(
  deps: ServerDeps,
  userId: string,
  messageId: string,
  pending: Decision,
  outcome: ApprovalOutcome
): Promise<{ decision: Decision }> {
  const applied = await deps.db.resolvePendingApproval(userId, messageId, outcome);
  const decision: Decision = {
    ...pending,
    kind: outcome.kind,
    code: outcome.code,
    reason: outcome.reason,
    order: outcome.order,
  };
  if (applied) deps.events.emitDecision(userId, decision);
  return { decision };
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
  readonly assetType: AssetType;
  readonly symbol: string;
  readonly quantity: number;
  readonly optionType?: OptionType;
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

  const equityRows = equity.positions
    .filter((position) => position.quantity > 0)
    .map(async (position): Promise<PerformanceRow> => {
      const entryPrice = findEquityEntry(submitted, position.symbol);
      const currentPrice = await tools.getQuote(position.symbol).then((q) => q.price);
      return {
        assetType: 'equity',
        symbol: position.symbol,
        quantity: position.quantity,
        entryPrice,
        currentPrice,
        pctChange: pctChange(entryPrice, currentPrice),
      };
    });

  const optionRows = options.positions
    .filter((position) => position.quantity > 0)
    .map(async (position): Promise<PerformanceRow> => {
      const entryPrice = findOptionEntry(submitted, position);
      const quote = await tools.getOptionsMarkPrice(
        position.symbol,
        position.optionType,
        position.strike,
        position.expiration
      );
      const currentPrice = quote?.markPrice ?? null;
      return {
        assetType: 'option',
        symbol: position.symbol,
        quantity: position.quantity,
        optionType: position.optionType,
        strike: position.strike,
        expiration: position.expiration,
        entryPrice,
        currentPrice,
        pctChange: pctChange(entryPrice, currentPrice),
      };
    });

  return Promise.all([...equityRows, ...optionRows]);
}

const pctChange = (entry: number | null, current: number | null): number | null =>
  entry !== null && current !== null && entry > 0 ? ((current - entry) / entry) * 100 : null;
