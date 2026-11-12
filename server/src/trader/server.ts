/**
 * Trader HTTP server: the per-account REST API (feed, position performance,
 * trade settings, Robinhood connection, SnapTrade connect). Message ingestion does not pass
 * through HTTP any more — the poller reads the `messages` table directly.
 *
 * Every /api route runs behind the session-token hook in auth.ts and reads or
 * writes only the acting user's selected account (requireAccount). Kept
 * separate from index.ts (which auto-runs main() on import) so routes can be
 * tested with fastify.inject and mocked deps.
 */
import fastifyCors from '@fastify/cors';
import fastifyEtag from '@fastify/etag';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

import { createLogger } from '../shared/logger.js';
import {
  TradeSettingsSchema,
  type AssetType,
  type Decision,
  type ExecutionMode,
  type OptionType,
  type TradeExecutionMode,
} from '../shared/types.js';
import { registerAuth, requireAccount, requireUser } from './auth.js';
import { cancelStops } from './stops.js';
import {
  BOOK_PERIODS,
  isoDateEt,
  periodStartDate,
  viewOf,
  type BookPeriod,
} from './book/ladder.js';
import type { ApprovalOutcome, AuthUser, StoredCallout, TraderDb, UnusableAccount } from './db.js';
import type { TraderEvents } from './events.js';
import type { OpenOptionLot } from './lots.js';
import { resolveEquityEntry, resolveOptionEntry } from './maxLoss.js';
import { submitOrder } from './pipeline/execute.js';
import { summarize } from './pipeline/summarize.js';
import {
  DEFAULT_RECAP_WINDOW_DAYS,
  RECAP_WINDOW_DAYS_CHOICES,
  computeRecapPerformance,
  isoDateDaysAgo,
} from './recaps/analytics.js';
import { readTokenStatus } from './robinhood/mcpClient.js';
import { executionModeFor } from './broker/paperAccount.js';
import type { McpRegistry } from './broker/registry.js';
import { createSpacedRead, METERED_DASHBOARD_READ_INTERVAL_MS } from './broker/requestBudget.js';
import type { AccountRow, Broker, UserBroker } from './broker/types.js';
import type { TokenState } from './robinhood/types.js';
import type { SnapTradeAccess, SnapTradeClient } from './snaptrade/client.js';
import { planSnapTradeSync, type SnapTradeSyncPlan } from './snaptrade/sync.js';

const log = createLogger('trader:server');

const DEFAULT_DECISIONS_LIMIT = 50;
const DEFAULT_CALLOUTS_LIMIT = 100;
/**
 * How far back the performance view looks for the order that opened a
 * position. Deeper than the feed page: a position held for weeks still needs
 * its entry price, and the feed's 50 rows would lose it.
 */
const PERFORMANCE_HISTORY_LIMIT = 500;
// ponytail: fixed cadences; make these settings if anyone ever needs to
// tune them.
const SSE_PERFORMANCE_INTERVAL_MS = 10_000;
const SSE_HEARTBEAT_INTERVAL_MS = 20_000;
/**
 * How often a cached connection (an open stream, the status/portfolio polls)
 * confirms its account still has stored credentials: the backstop for ones
 * removed outside this process (auth:reset).
 */
const CONNECTION_CHECK_INTERVAL_MS = 60_000;
/**
 * How far back GET /api/book reads closed rows for the today / week periods
 * before trimming to ET trading days in code. Wider than a week so the ET
 * day boundary never cuts a row off.
 */
const BOOK_RECENT_LOOKBACK_MS = 9 * 24 * 60 * 60 * 1000;
/** How long POST /api/broker/connect waits for Robinhood to hand us a URL. */
const AUTH_URL_TIMEOUT_MS = 15_000;
const AUTH_URL_POLL_MS = 100;
/**
 * A Robinhood account has one agent slot, so a login from a deployment that
 * never trades on Robinhood (staging) would take it away from the one that does.
 */
const NO_ROBINHOOD_LOGIN_MODES: ReadonlySet<TradeExecutionMode> = new Set(['read_only', 'paper_only']);
const robinhoodLoginRefused = (mode: TradeExecutionMode): string =>
  `Robinhood cannot be connected from this environment (TRADE_EXECUTION_MODE=${mode})`;
const NO_ROBINHOOD_ACCOUNT_ERROR = 'this user has no Robinhood account to connect';
/** One answer for "not the owner" and "no keys here": neither is told which. */
const SNAPTRADE_UNAVAILABLE_ERROR = 'Connecting another broker is not available for this sign-in';
const SNAPTRADE_LINK_FAILED_ERROR = 'SnapTrade did not issue a connection link. Nothing was changed. Try again.';
const SNAPTRADE_READ_FAILED_ERROR = 'SnapTrade could not be read. Nothing was changed. Try again.';
const UNUSABLE_ACCOUNT_ERROR =
  'that account cannot be used: its saved connection details cannot be read. Nothing was changed.';

/** Full redirect URL the user copied from the dead-end 127.0.0.1 tab. */
const BrokerCallbackBodySchema = z.object({ redirectUrl: z.string() });

/** `force` tears down the current session first — the settings Reconnect. */
const BrokerConnectBodySchema = z.object({ force: z.boolean().optional() });

const SelectAccountBodySchema = z.object({ accountId: z.string().min(1) });

/** `reconnect`: the connection id of one of the user's own SnapTrade accounts, to repair it. */
const SnapTradeLinkBodySchema = z.object({ reconnect: z.string().min(1).optional() });

/** One account in GET /api/accounts: what the account menu shows about it. */
export interface AccountSummary {
  readonly id: string;
  readonly label: string;
  readonly institution: string;
  readonly isPaper: boolean;
  readonly connected: boolean;
  readonly needsReconnect: boolean;
  readonly executionMode: ExecutionMode;
  /** An account that follows every Caller counts the whole roster. */
  readonly followedCallerCount: number;
}

export interface SnapTradeAccountSummary extends AccountSummary {
  readonly externalAccountId: string;
  readonly connectionId: string;
}

/** A later adapter adds one variant. */
export type BrokerEntry =
  | { readonly adapter: 'robinhood'; readonly account: AccountSummary }
  | {
      readonly adapter: 'snaptrade';
      /** Keyed by our own account id. */
      readonly accounts: Record<string, SnapTradeAccountSummary>;
    };

export interface AccountsResponse {
  /** The account every per-account route acts on for this user right now. */
  readonly selectedAccountId: string;
  /** One entry per adapter the user has an account through. */
  readonly brokers: BrokerEntry[];
  /**
   * Accounts whose saved details cannot be read: shown, so they do not vanish
   * from the menu, but never selectable. Absent when there are none.
   */
  readonly unusableAccounts?: UnusableAccount[];
  /** Whether this sign-in may connect another broker through SnapTrade. */
  readonly canConnectSnapTrade: boolean;
}

/** POST /api/snaptrade/sync: what the sync found at SnapTrade and did here. */
export interface SnapTradeSyncResponse {
  readonly added: number;
  readonly updated: number;
  readonly disconnected: number;
  readonly skippedReadOnlyConnections: number;
  readonly skippedSandboxConnections: number;
  /** Connections whose accounts SnapTrade does not list yet; sync again later. */
  readonly connectionsAwaitingAccounts: number;
}

export interface ServerDeps {
  readonly db: TraderDb;
  readonly events: TraderEvents;
  readonly brokers: McpRegistry;
  /** The deployment's TRADE_EXECUTION_MODE: anything but immediate, for the account, refuses Approve. */
  readonly executionMode: TradeExecutionMode;
  /** Null on a deployment without the SnapTrade keys: connecting other brokers is off. */
  readonly snapTrade: SnapTradeAccess | null;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const fastify = Fastify({ logger: false });

  // Browser dashboard (client/) calls /api/* cross-origin.
  // ponytail: registered instance-wide because @fastify/cors has no per-path
  // filter; /webhook is HMAC-protected and /health is public, so the extra
  // scope is harmless. Upgrade path: move /api routes into a prefixed scope.
  fastify.register(fastifyCors, { origin: true, methods: ['GET', 'PUT', 'POST'] });

  // Egress: hash every response so a poll that changed nothing returns a 304
  // with an empty body instead of re-sending 100 callouts. `no-cache` means
  // "store, but revalidate every time" — the browser's HTTP cache then sends
  // If-None-Match on its own and serves the cached body on 304, so the
  // dashboard code never sees anything but a normal 200.
  fastify.register(fastifyEtag);
  fastify.addHook('onSend', async (request, reply) => {
    if (request.method === 'GET' && request.url.startsWith('/api/') && !reply.getHeader('cache-control')) {
      reply.header('cache-control', 'private, no-cache');
    }
  });

  registerAuth(fastify, deps.db);

  const connections = createConnectionCache(deps);
  // The dashboard polls: the stream every 10 s per open tab, the header every
  // minute. A request-metered account (SnapTrade) is read from its broker at
  // most once per METERED_DASHBOARD_READ_INTERVAL_MS for each of the two, and
  // every tab and route shares that answer. Other accounts are read each time.
  const portfolios = createSpacedRead<PortfolioSnapshot>(METERED_DASHBOARD_READ_INTERVAL_MS);
  const performances = createSpacedRead<PerformanceRow[]>(METERED_DASHBOARD_READ_INTERVAL_MS);

  // ---- Public -----------------------------------------------------------------

  // Keep-alive target for the supervisor's self-ping (src/index.ts) and the
  // platform health check. Its liveness signal is whether it answers at all,
  // not what it says: src/index.ts runs the Listener in the same process tree
  // and tears the tree down if it dies, so a dead Gateway means this stops
  // responding. executionMode is per-user (settings.payload), not process-wide.
  fastify.get('/health', async (_request, reply) => {
    return reply.send({ ok: true });
  });

  // ---- Accounts ---------------------------------------------------------------

  // The user's own accounts and which of them the dashboard and Settings show.
  fastify.get('/api/accounts', async (request, reply) => {
    const selected = requireAccount(request);
    return reply.send(await listAccounts(deps, requireUser(request), selected));
  });

  // Switches what the screens and Settings show and edit. Which accounts trade
  // is every connected account, whatever is selected here.
  fastify.post('/api/accounts/select', async (request, reply) => {
    const user = requireUser(request);
    const parsed = SelectAccountBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'body must be { accountId: string }' });
    }
    // An unusable account is never what the screens show: the session would
    // fall back to another account while this answered that it was selected.
    const { unusable } = await deps.db.listAccounts(user.id);
    if (unusable.some((account) => account.id === parsed.data.accountId)) {
      return reply.status(409).send({ error: UNUSABLE_ACCOUNT_ERROR });
    }
    // Someone else's account answers exactly as one that does not exist.
    if (!(await deps.db.selectAccount(user.id, parsed.data.accountId))) {
      return reply.status(404).send({ error: 'no such account' });
    }
    return reply.send({ selectedAccountId: parsed.data.accountId });
  });

  // ---- Robinhood connection (per account) -------------------------------------

  fastify.get('/api/broker/status', async (request, reply) => {
    const account = requireAccount(request);
    // The connection of record is the account's stored credentials, not the
    // in-memory session: stored tokens survive restarts and are what the
    // pipeline fans out over. An account with tokens but no warm session is
    // still connected — the next broker call (RobinhoodTools → mcp.ensureReady)
    // recreates the session from those tokens. The reverse is a stale session:
    // when the credentials are gone the warm session no longer represents a
    // connection, so it is evicted and status reports
    // disconnected instead of pretending off in-memory state.
    // A SnapTrade account stores no credentials: its row is its connection
    // (readConnection), and it never has a login URL to offer.
    const tokenState = await connections.state(account);
    return reply.send({
      // An account this deployment has no adapter for is not connected here,
      // whatever it has stored.
      connected: deps.brokers.supports(account) && (tokenState === 'valid' || tokenState === 'refreshable'),
      authUrl: deps.brokers.existing(account.id)?.session.getPendingAuthUrl() ?? null,
      tokenState,
      executionMode: (await deps.db.getSettings(account.id)).executionMode,
    });
  });

  // Robinhood only allows loopback redirect URIs, so on a deployed server the
  // post-consent redirect dead-ends on the user's own 127.0.0.1. The dashboard
  // opens the URL returned here, the user approves, then pastes the dead-end
  // redirect URL into POST /api/broker/callback.
  //
  // connect and callback are the Robinhood OAuth flow, so they act on the
  // user's direct Robinhood account whichever account is selected: a login
  // started while another account is being viewed must never land its tokens
  // on that account's row.
  fastify.post('/api/broker/connect', async (request, reply) => {
    const selected = requireAccount(request);
    if (NO_ROBINHOOD_LOGIN_MODES.has(deps.executionMode)) {
      return reply.status(409).send({ error: robinhoodLoginRefused(deps.executionMode) });
    }
    const parsed = BrokerConnectBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'body must be { force?: boolean }' });
    }
    const account = await directRobinhoodAccount(deps, selected);
    if (account === null) {
      return reply.status(409).send({ error: NO_ROBINHOOD_ACCOUNT_ERROR });
    }
    // Reconnect (settings page): drop the current session — connected but
    // wedged, or holding an abandoned OAuth flow — and run the flow again.
    // Stored tokens are kept: when they still refresh this reconnects with no
    // consent step, else the browser OAuth fallback issues a fresh auth URL.
    if (parsed.data.force === true) deps.brokers.drop(account.id);
    connections.invalidate(account.id);
    const broker = deps.brokers.for(account);
    if (broker.session.isConnected()) {
      return reply.send({ connected: true, authUrl: null });
    }

    // ensureConnected only resolves once the whole OAuth dance finishes, which
    // needs the paste this endpoint's caller hasn't made yet — so kick it off
    // and wait only for the authorization URL it produces on the way.
    void broker.session.ensureConnected().catch((err: unknown) =>
      log.warn('Robinhood connect failed', { accountId: account.id, error: (err as Error).message })
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
    const selected = requireAccount(request);
    if (NO_ROBINHOOD_LOGIN_MODES.has(deps.executionMode)) {
      return reply.status(409).send({ error: robinhoodLoginRefused(deps.executionMode) });
    }
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
    const account = await directRobinhoodAccount(deps, selected);
    const broker = account === null ? undefined : deps.brokers.existing(account.id);
    if (!broker || !broker.session.isAuthPending()) {
      return reply.status(409).send({ error: 'no OAuth authorization is pending' });
    }
    broker.session.submitAuthCode(code, url.searchParams.get('state'));
    // Token exchange happens asynchronously inside the pending connect();
    // the client polls /api/broker/status until `connected` flips.
    return reply.send({ ok: true });
  });

  fastify.post('/api/broker/disconnect', async (request, reply) => {
    const account = requireAccount(request);
    await deps.db.deleteBrokerTokens(account.id);
    deps.brokers.drop(account.id);
    connections.invalidate(account.id);
    return reply.send({ ok: true });
  });

  // ---- SnapTrade connect (owner only) -----------------------------------------
  //
  // Both routes place no order, so a read_only deployment allows them: the
  // write guard still refuses every order on every adapter. Both are changes,
  // so both must name the viewed account like any other (auth.ts): the sync
  // copies that account's settings onto a new account, and the link is issued
  // from the same dialog.

  // A fresh Connection Portal link. It lives five minutes, so the dashboard
  // asks for it as the portal opens.
  fastify.post('/api/snaptrade/link', async (request, reply) => {
    const account = requireAccount(request);
    const snapTrade = snapTradeFor(deps, requireUser(request));
    if (snapTrade === null) {
      return reply.status(403).send({ error: SNAPTRADE_UNAVAILABLE_ERROR });
    }
    const parsed = SnapTradeLinkBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'body must be { reconnect?: string }' });
    }
    const { reconnect } = parsed.data;
    if (reconnect !== undefined && !(await ownsSnapTradeConnection(deps, account.userId, reconnect))) {
      return reply.status(404).send({ error: 'no such connection' });
    }
    let url: string;
    try {
      url = await snapTrade.portalLink(reconnect);
    } catch (err: unknown) {
      log.warn('SnapTrade portal link failed', { error: (err as Error).message });
      return reply.status(502).send({ error: SNAPTRADE_LINK_FAILED_ERROR });
    }
    // The link signs its holder in to the portal: never kept by a cache.
    return reply.header('cache-control', 'no-store').send({ url });
  });

  // Makes the user's SnapTrade accounts match what SnapTrade lists.
  fastify.post('/api/snaptrade/sync', async (request, reply) => {
    const account = requireAccount(request);
    const snapTrade = snapTradeFor(deps, requireUser(request));
    if (snapTrade === null) {
      return reply.status(403).send({ error: SNAPTRADE_UNAVAILABLE_ERROR });
    }
    // Read in full before anything is written: a failed read must never be
    // taken for "SnapTrade lists nothing" and disconnect every account.
    let plan: SnapTradeSyncPlan;
    try {
      const [connections, accounts] = await Promise.all([snapTrade.listConnections(), snapTrade.listAccounts()]);
      plan = planSnapTradeSync(connections, accounts);
    } catch (err: unknown) {
      log.warn('SnapTrade sync could not read SnapTrade', { error: (err as Error).message });
      return reply.status(502).send({ error: SNAPTRADE_READ_FAILED_ERROR });
    }
    const { rows, ...found } = plan;
    const counts = await deps.db.syncSnapTradeAccounts(account.userId, account.id, rows);
    // A SnapTrade session answers from the row it was opened with, and a sync
    // is what changes that row (needs reconnect, disconnected, back again).
    // Each of the user's SnapTrade accounts is opened again on its next use.
    for (const { account: synced } of (await deps.db.listAccounts(account.userId)).accounts) {
      if (synced.adapter !== 'snaptrade') continue;
      deps.brokers.drop(synced.id);
      connections.invalidate(synced.id);
      portfolios.forget(synced.id);
      performances.forget(synced.id);
    }
    const result: SnapTradeSyncResponse = { ...counts, ...found };
    log.info('SnapTrade sync', { userId: account.userId, ...result });
    return reply.send(result);
  });

  // ---- Feed --------------------------------------------------------------------

  // The selected account's trade outcomes, newest-first.
  fastify.get('/api/decisions', async (request, reply) => {
    const account = requireAccount(request);
    const limitRaw = (request.query as { limit?: string }).limit;
    const limit = limitRaw === undefined ? DEFAULT_DECISIONS_LIMIT : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1) {
      return reply.status(400).send({ error: 'limit must be a positive integer' });
    }
    return reply.send({ decisions: await deps.db.listDecisions(account.id, limit) });
  });

  // Every callout the pipeline has seen, each carrying THIS account's outcome.
  // The callouts themselves are shared; the decision attached to them is not.
  // Egress: the etag is the feed's version, computed in one cheap query, so a
  // poll that changed nothing answers 304 without reading a single row
  // (@fastify/etag keeps an etag the route set and does the 304 itself).
  fastify.get('/api/callouts', async (request, reply) => {
    const account = requireAccount(request);
    const etag = `"${await deps.db.feedVersion(account.id, DEFAULT_CALLOUTS_LIMIT)}"`;
    reply.header('etag', etag);
    if (request.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply.send({ callouts: await loadFeed(deps, account.id) });
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
    const account = requireAccount(request);
    const { messageId } = request.params as { messageId: string };

    const pending = await findPendingApproval(deps, account.id, messageId);
    if (pending === null) {
      return reply.status(404).send({ error: 'no trade awaiting approval for that callout' });
    }
    if (pending.order === null) {
      return reply.status(409).send({ error: 'that trade has no sized order to submit' });
    }
    // The deployment's kill switch wins over the user's click: the row stays
    // pending so it can be approved once the deployment trades again.
    if (executionModeFor(deps.executionMode, account) !== 'immediate') {
      return reply.status(409).send({
        error: `this deployment is held by TRADE_EXECUTION_MODE=${deps.executionMode}; nothing can be approved here`,
      });
    }

    // Approving spends money over the account's broker session, so it must not
    // run against a stale one. The row stays pending — reconnect, then approve.
    const broker = await connectedBrokerTools(deps, account);
    if (broker === null) {
      return reply.status(409).send({ error: notConnectedError(deps, account) });
    }

    const approvedAt = new Date().toISOString();
    let outcome: ApprovalOutcome;
    try {
      if (pending.order.assetType === 'option' && pending.order.side === 'sell') {
        await cancelStops(deps.db, account.id, broker, pending.order.symbol, pending.order.option);
      }
      const placed = await submitOrder(pending.order, broker);
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

    return reply.send(await applyApproval(deps, account.id, messageId, pending, outcome));
  });

  fastify.post('/api/trades/:messageId/reject', async (request, reply) => {
    const account = requireAccount(request);
    const { messageId } = request.params as { messageId: string };

    const pending = await findPendingApproval(deps, account.id, messageId);
    if (pending === null) {
      return reply.status(404).send({ error: 'no trade awaiting approval for that callout' });
    }

    return reply.send(
      await applyApproval(deps, account.id, messageId, pending, {
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

  // ---- Book ---------------------------------------------------------------------

  // The tracked-callout book: every open Caller entry with its live mark and
  // simulated ladder, plus the entries closed within the period. Shared data
  // (same for every user; the dashboard filters by Caller and attaches the
  // user's own decisions client-side), auth still required.
  fastify.get('/api/book', async (request, reply) => {
    requireUser(request);
    const periodRaw = (request.query as { period?: string }).period ?? 'today';
    if (!BOOK_PERIODS.includes(periodRaw as BookPeriod)) {
      return reply.status(400).send({ error: `period must be one of ${BOOK_PERIODS.join(', ')}` });
    }
    const period = periodRaw as BookPeriod;
    const now = new Date();
    const today = isoDateEt(now);
    const startDate = periodStartDate(period, today);
    const [open, closedRecent] = await Promise.all([
      deps.db.listTrackedOpen(),
      deps.db.listTrackedClosedSince(
        startDate === null ? null : new Date(now.getTime() - BOOK_RECENT_LOOKBACK_MS)
      ),
    ]);
    const closed = closedRecent.filter(
      (p) => startDate === null || isoDateEt(new Date(p.closedAt!)) >= startDate
    );
    return reply.send({
      period,
      today,
      asOf: now.toISOString(),
      open: open.map(viewOf),
      closed: closed.map(viewOf),
    });
  });

  // ---- Settings -----------------------------------------------------------------

  fastify.get('/api/settings', async (request, reply) => {
    const account = requireAccount(request);
    return reply.send({ settings: await deps.db.getSettings(account.id) });
  });

  fastify.put('/api/settings', async (request, reply) => {
    const account = requireAccount(request);
    // strict(): a typo'd key ("maxTradesperDay") must 400, not be silently
    // stripped and leave the user thinking they raised a limit they didn't.
    const parsed = TradeSettingsSchema.strict().safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid settings', detail: parsed.error.message });
    }
    return reply.send({ settings: await deps.db.saveSettings(account.id, parsed.data) });
  });

  // ---- Portfolio ------------------------------------------------------------------

  // Account snapshot for the dashboard header: total portfolio value plus a
  // count of open (quantity > 0) equity + option positions.
  fastify.get('/api/portfolio', async (request, reply) => {
    const account = requireAccount(request);
    const broker = await connections.tools(account);
    if (broker === null) {
      return reply.status(409).send({ error: notConnectedError(deps, account) });
    }
    try {
      return reply.send(await portfolios.read(account, () => readPortfolio(broker)));
    } catch (err) {
      return reply
        .status(503)
        .send({ error: 'robinhood unavailable', detail: (err as Error).message });
    }
  });

  fastify.get('/api/trades/performance', async (request, reply) => {
    const account = requireAccount(request);
    const tools = await connectedBrokerTools(deps, account);
    if (tools === null) {
      return reply.status(409).send({ error: notConnectedError(deps, account) });
    }
    try {
      const history = deps.db.listDecisions(account.id, PERFORMANCE_HISTORY_LIMIT);
      const lots = deps.db.listOpenOptionLots(account.id);
      return reply.send({
        positions: await performances.read(account, () => collectPerformance(tools, history, lots)),
      });
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
  // `performance` ({ positions, error } every 10s while connected), `stage`
  // (live trade lifecycle: received → parsing → risk_check → executing → done),
  // and `book` ({ at }: the shared tracked-callout book changed; refetch it).
  //
  // Read with fetch, not EventSource, so it carries the same Authorization
  // header as every other route (see client/src/lib/stream.ts).
  //
  // The stream follows the account that was selected when it opened.
  fastify.get('/api/stream', (request, reply) => {
    const account = requireAccount(request);
    const accountId = account.id;

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
        .listDecisions(accountId, DEFAULT_DECISIONS_LIMIT)
        .then((decisions) => send('decisions', decisions))
        .catch((err: unknown) =>
          log.warn('could not push decisions frame', { error: (err as Error).message })
        );
    };

    // Egress: quotes barely move between 10s ticks (and not at all overnight),
    // so a frame identical to the last one is not worth the bytes.
    let lastPerformanceFrame = '';
    const sendPerformance = (data: { positions: unknown; error: string | null }): void => {
      const frame = JSON.stringify(data);
      if (frame === lastPerformanceFrame) return;
      lastPerformanceFrame = frame;
      reply.raw.write(`event: performance\ndata: ${frame}\n\n`);
    };

    // Egress: the connection row, the trade history and the open lots only
    // change on a (dis)connect or a logged decision, so all three are read on
    // connect and after each decision, and a tick re-fetches only live broker
    // data. Undefined = read on the next tick.
    let connection: Broker | null | undefined;
    let history: Promise<Decision[]> | undefined;
    let lots: Promise<OpenOptionLot[]> | undefined;

    // The registry is the in-memory disconnect signal: disconnect, Reconnect
    // and stale-session eviction drop or replace the session, and a finished
    // OAuth adds a connected one. Any of those re-checks the row.
    const sessionChanged = (cached: Broker | null): boolean => {
      const live = deps.brokers.existing(accountId);
      return cached === null ? live?.session.isConnected() === true : live?.broker !== cached;
    };

    const pushPerformance = async (): Promise<void> => {
      try {
        let tools = connection;
        if (tools === undefined || sessionChanged(tools)) {
          tools = await connectedBrokerTools(deps, account);
          connection = tools;
        }
        if (tools === null) {
          // No connection of record (disconnected, or the row was removed):
          // an error frame, never data from a session that outlived its row.
          sendPerformance({ positions: null, error: notConnectedError(deps, account) });
          return;
        }
        // A failed read is not kept: the next tick tries again.
        history ??= deps.db
          .listDecisions(accountId, PERFORMANCE_HISTORY_LIMIT)
          .catch((err: unknown) => {
            history = undefined;
            throw err;
          });
        lots ??= deps.db.listOpenOptionLots(accountId).catch((err: unknown) => {
          lots = undefined;
          throw err;
        });
        const read = { tools, history, lots };
        sendPerformance({
          positions: await performances.read(account, () =>
            collectPerformance(read.tools, read.history, read.lots)
          ),
          error: null,
        });
      } catch (err) {
        // Robinhood MCP down/unauthed: keep the stream alive with an error shape.
        sendPerformance({ positions: null, error: (err as Error).message });
      }
    };

    pushDecisions();
    void pushPerformance();
    const unsubscribe = deps.events.subscribe(accountId, {
      onDecision: () => {
        pushDecisions();
        connection = undefined;
        history = undefined;
        lots = undefined;
      },
      onStage: (event) => send('stage', event),
    });
    // The book is shared and the client chooses its own period, so the frame
    // is a change notice (the client refetches GET /api/book), not a snapshot.
    const unsubscribeBook = deps.events.subscribeBook((event) => send('book', event));

    // ponytail: per-connection timers — N clients means N× Robinhood quote
    // traffic. Fine at invite-only scale; upgrade path is one shared broadcast
    // loop per account gated on client count. Zero clients = zero timers either way.
    const performanceTimer = setInterval(() => void pushPerformance(), SSE_PERFORMANCE_INTERVAL_MS);
    const heartbeatTimer = setInterval(
      () => reply.raw.write(': heartbeat\n\n'),
      SSE_HEARTBEAT_INTERVAL_MS
    );
    // A row removed out of process (auth:reset) leaves the registry alone, so
    // an id-only existence check, which never fetches the token blob, backs
    // the in-memory signal up at a slower cadence.
    // ponytail: lists every connected account to test one; fine at
    // invite-only scale. Upgrade path: a per-account existence query.
    const connectionTimer = setInterval(() => {
      if (!connection) return;
      void deps.db
        .listConnectedAccounts()
        .then((connected) => {
          if (!connected.some((candidate) => candidate.id === accountId)) connection = undefined;
        })
        .catch((err: unknown) =>
          log.warn('could not check broker connection', { error: (err as Error).message })
        );
    }, CONNECTION_CHECK_INTERVAL_MS);

    request.raw.on('close', () => {
      clearInterval(performanceTimer);
      clearInterval(heartbeatTimer);
      clearInterval(connectionTimer);
      unsubscribe();
      unsubscribeBook();
      reply.raw.end();
    });
  });

  return fastify;
}

// =============================================================================
// Accounts
// =============================================================================

/**
 * The accounts of the selected account's owner, grouped by adapter. The
 * database keeps one row per account; this shape is built on read.
 */
async function listAccounts(deps: ServerDeps, user: AuthUser, selected: AccountRow): Promise<AccountsResponse> {
  const { accounts: listings, unusable } = await deps.db.listAccounts(selected.userId);
  const followsEveryone = listings.some((listing) => listing.followedCallerIds === null);
  const rosterSize = followsEveryone ? (await deps.db.listCallers()).length : 0;

  const brokers: BrokerEntry[] = [];
  const snapTradeAccounts: Record<string, SnapTradeAccountSummary> = {};
  for (const { account, connected, executionMode, followedCallerIds } of listings) {
    const summary: AccountSummary = {
      id: account.id,
      label: account.label,
      institution: account.institution,
      isPaper: account.isPaper,
      // The connection of record, whether or not this deployment has the
      // account's adapter: the status route is what says it cannot be used here.
      connected,
      needsReconnect: account.needsReconnect,
      executionMode,
      followedCallerCount: followedCallerIds?.length ?? rosterSize,
    };
    switch (account.adapter) {
      case 'robinhood':
        brokers.push({ adapter: 'robinhood', account: summary });
        break;
      case 'snaptrade':
        snapTradeAccounts[account.id] = {
          ...summary,
          // Every SnapTrade row is written with one; '' only on a hand-made row.
          externalAccountId: account.externalAccountId ?? '',
          connectionId: account.adapterData.connectionId,
        };
        break;
    }
  }
  if (Object.keys(snapTradeAccounts).length > 0) {
    brokers.push({ adapter: 'snaptrade', accounts: snapTradeAccounts });
  }
  return {
    selectedAccountId: selected.id,
    brokers,
    ...(unusable.length > 0 ? { unusableAccounts: unusable } : {}),
    canConnectSnapTrade: snapTradeFor(deps, user) !== null,
  };
}

/**
 * The SnapTrade client, for the one sign-in that may use it. The key is the
 * owner's own SnapTrade login, so every other user gets null, exactly as on a
 * deployment that has no key.
 */
const snapTradeFor = (deps: ServerDeps, user: AuthUser): SnapTradeClient | null =>
  deps.snapTrade !== null && user.email?.toLowerCase() === deps.snapTrade.ownerEmail.toLowerCase()
    ? deps.snapTrade.client
    : null;

/** Whether `connectionId` is the connection of one of the user's own SnapTrade accounts. */
async function ownsSnapTradeConnection(deps: ServerDeps, userId: string, connectionId: string): Promise<boolean> {
  const { accounts } = await deps.db.listAccounts(userId);
  return accounts.some(
    ({ account }) => account.adapter === 'snaptrade' && account.adapterData.connectionId === connectionId
  );
}

/** The direct Robinhood account of the selected account's owner; every user is created with one. */
async function directRobinhoodAccount(
  deps: ServerDeps,
  selected: AccountRow
): Promise<AccountRow | null> {
  if (selected.adapter === 'robinhood') return selected;
  const { accounts } = await deps.db.listAccounts(selected.userId);
  return accounts.find(({ account }) => account.adapter === 'robinhood')?.account ?? null;
}

/**
 * What a route answers when the account it was asked about cannot be served
 * here: no connection of record, or no adapter for it on this deployment.
 */
const notConnectedError = (deps: ServerDeps, account: AccountRow): string =>
  deps.brokers.supports(account)
    ? `${account.label} is not connected`
    : `${account.label} is not available on this deployment`;

// =============================================================================
// Approval
// =============================================================================

/** This account's decision for a callout, but only if it is awaiting approval. */
async function findPendingApproval(
  deps: ServerDeps,
  accountId: string,
  messageId: string
): Promise<Decision | null> {
  const decisions = await deps.db.decisionsByMessageId(accountId, [messageId]);
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
  accountId: string,
  messageId: string,
  pending: Decision,
  outcome: ApprovalOutcome
): Promise<{ decision: Decision }> {
  const applied = await deps.db.resolvePendingApproval(accountId, messageId, outcome);
  const decision: Decision = {
    ...pending,
    kind: outcome.kind,
    code: outcome.code,
    reason: outcome.reason,
    order: outcome.order,
  };
  if (applied) deps.events.emitDecision(accountId, decision);
  return { decision };
}

// =============================================================================
// Feed
// =============================================================================

/** A shared callout plus the selected account's outcome for it (null = not acted on). */
export interface CalloutFeedItem extends StoredCallout {
  readonly decision: Decision | null;
}

async function loadFeed(deps: ServerDeps, accountId: string): Promise<CalloutFeedItem[]> {
  const callouts = await deps.db.listCallouts(DEFAULT_CALLOUTS_LIMIT);
  const decisions = await deps.db.decisionsByMessageId(
    accountId,
    callouts.map((c) => c.messageId)
  );
  return callouts.map((callout) => ({
    ...callout,
    decision: decisions.get(callout.messageId) ?? null,
  }));
}

// =============================================================================
// Broker connection guard
// =============================================================================

interface ConnectionOfRecord {
  readonly state: TokenState;
  /** The row to open the account's broker from. */
  readonly account: AccountRow;
}

/**
 * An account's connection of record, by its adapter's own rule.
 *
 * A Robinhood account is its stored tokens. A SnapTrade account stores none:
 * it is connected exactly when the account list says so (not disconnected,
 * its brokerage login not broken), which reads as `valid`, and its broker is
 * opened from the row as it is now rather than one held since before a sync.
 * ponytail: lists every connected account to test one, as the checks below
 * do. Upgrade path: a per-account existence query.
 */
async function readConnection(deps: ServerDeps, account: AccountRow): Promise<ConnectionOfRecord> {
  if (account.adapter === 'snaptrade') {
    const listed = (await deps.db.listConnectedAccounts()).find((candidate) => candidate.id === account.id);
    return listed === undefined ? { state: 'missing', account } : { state: 'valid', account: listed };
  }
  const stored = await deps.db.getBrokerTokens(account.id);
  return { state: readTokenStatus(stored?.tokens).state, account };
}

/**
 * The account's broker, gated on the connection of record (readConnection).
 * Every route that reads or trades the account goes through
 * here, so none of them can serve from a warm in-memory session whose stored
 * connection no longer exists. Null means "not connected" — callers answer
 * 409, distinct from the 503 "broker down". An account whose adapter this
 * deployment does not have is not connected here either.
 */
async function connectedBrokerTools(
  deps: ServerDeps,
  account: AccountRow
): Promise<Broker | null> {
  if (!deps.brokers.supports(account)) return null;
  const connection = await readConnection(deps, account);
  if (connection.state !== 'missing') {
    return deps.brokers.for(connection.account).broker;
  }
  dropStaleBrokerSession(deps, account.id);
  return null;
}

/**
 * Evict a warm session that outlived its stored credentials (removed by an
 * operator reset or a disconnect made elsewhere). Sessions mid-OAuth are
 * not connected yet and are left alone so the flow they hold can finish.
 */
function dropStaleBrokerSession(deps: ServerDeps, accountId: string): void {
  if (deps.brokers.existing(accountId)?.session.isConnected()) deps.brokers.drop(accountId);
}

/** What the registry held for an account when its credentials were last read. */
interface SessionSnapshot {
  readonly session: UserBroker | undefined;
  readonly connected: boolean;
}

interface ConnectionRecord extends SessionSnapshot {
  readonly state: Promise<TokenState>;
  checkedAt: number;
}

interface ConnectionCache {
  /** The state of the account's connection of record (readConnection). */
  state(account: AccountRow): Promise<TokenState>;
  /** connectedBrokerTools, from the cached read. */
  tools(account: AccountRow): Promise<Broker | null>;
  invalidate(accountId: string): void;
}

/**
 * The connection of record for the dashboard's polled routes, shared by every
 * tab a user has open, without reading and decrypting the credentials per poll.
 *
 * Every in-process (dis)connect shows in the registry — disconnect, Reconnect
 * and stale-session eviction drop or replace the session, and a finished
 * OAuth flips it to connected — so any change there re-reads the credentials.
 * Ones removed out of process (auth:reset) leave the registry alone; an
 * id-only existence check every CONNECTION_CHECK_INTERVAL_MS catches it.
 * ponytail: the check lists every connected account to test one; fine at
 * invite-only scale. Upgrade path: a per-account existence query.
 */
function createConnectionCache(deps: ServerDeps): ConnectionCache {
  const records = new Map<string, ConnectionRecord>();

  const snapshot = (accountId: string): SessionSnapshot => {
    const session = deps.brokers.existing(accountId);
    return { session, connected: session?.session.isConnected() === true };
  };

  const registryChanged = (accountId: string, record: ConnectionRecord): boolean => {
    const live = snapshot(accountId);
    return live.session !== record.session || live.connected !== record.connected;
  };

  const read = (account: AccountRow): Promise<TokenState> => {
    const accountId = account.id;
    const record: ConnectionRecord = {
      ...snapshot(accountId),
      checkedAt: Date.now(),
      state: readConnection(deps, account).then(({ state }) => {
        if (state === 'missing') dropStaleBrokerSession(deps, accountId);
        return state;
      }),
    };
    records.set(accountId, record);
    // A failed read is not kept: the next request tries again.
    record.state.catch(() => {
      if (records.get(accountId) === record) records.delete(accountId);
    });
    return record.state;
  };

  const state = async (account: AccountRow): Promise<TokenState> => {
    const accountId = account.id;
    const record = records.get(accountId);
    if (record === undefined || registryChanged(accountId, record)) return read(account);
    if (Date.now() - record.checkedAt < CONNECTION_CHECK_INTERVAL_MS) return record.state;
    const [cached, connected] = await Promise.all([record.state, deps.db.listConnectedAccounts()]);
    record.checkedAt = Date.now();
    const stillConnected = connected.some((candidate) => candidate.id === accountId);
    return stillConnected === (cached !== 'missing') ? cached : read(account);
  };

  return {
    state,
    tools: async (account) =>
      !deps.brokers.supports(account) || (await state(account)) === 'missing'
        ? null
        : deps.brokers.for(account).broker,
    invalidate: (accountId) => void records.delete(accountId),
  };
}

/** The dashboard header's figures. */
interface PortfolioSnapshot {
  readonly portfolioValueUsd: number | null;
  readonly buyingPowerUsd: number;
  /** Equity and option positions with a quantity above zero. */
  readonly openPositions: number;
}

async function readPortfolio(broker: Broker): Promise<PortfolioSnapshot> {
  const [account, positions] = await Promise.all([broker.getAccount(), broker.getPositions()]);
  return {
    portfolioValueUsd: account.portfolioValueUsd,
    buyingPowerUsd: account.buyingPowerUsd,
    openPositions: positions.filter((p) => p.quantity > 0).length,
  };
}

async function waitForAuthUrl(broker: UserBroker): Promise<string | null> {
  const deadline = Date.now() + AUTH_URL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const authUrl = broker.session.getPendingAuthUrl();
    if (authUrl) return authUrl;
    // Already-valid stored tokens finish the connect with no consent step.
    if (broker.session.isConnected()) return null;
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
   * Entry basis matching the Robinhood app: for an option the account's own
   * open lots first; otherwise the broker's average cost when
   * the MCP reports it (equity position rows / filled option orders), else
   * the limit price of the user's most recent submitted buy. Null when
   * neither exists (e.g. a market fill on a position with no broker cost
   * data). Resolution lives in maxLoss.ts and is shared with the max-loss
   * monitor.
   */
  readonly entryPrice: number | null;
  readonly currentPrice: number | null;
  readonly pctChange: number | null;
}

async function collectPerformance(
  broker: Broker,
  history: Promise<Decision[]>,
  lots: Promise<OpenOptionLot[]>
): Promise<PerformanceRow[]> {
  const [positions, decisions, openLots] = await Promise.all([
    broker.getPositions(),
    history,
    // Lots that cannot be read price nothing: the rows still go out, options
    // priced from order history as they were before the ledger was read.
    lots.catch((err: unknown): OpenOptionLot[] => {
      log.warn('performance: ledger lots unreadable', { error: (err as Error).message });
      return [];
    }),
  ]);
  // Already newest-first, so find() picks the most recent entry for a position.
  const submitted = decisions.filter((d) => d.kind === 'submitted' && d.order);
  // Real option fills for the entry basis; degrade to the trade log when the
  // broker offers no order history or the call fails.
  const orders = await broker.getOrders().catch(() => null);

  const rows = positions
    .filter((position) => position.quantity > 0)
    .map(async (position): Promise<PerformanceRow> => {
      const { instrument, quantity } = position;
      const currentPrice = await broker.getMark(instrument);
      if (instrument.kind === 'equity') {
        const entryPrice = resolveEquityEntry(submitted, position);
        return {
          assetType: 'equity',
          symbol: instrument.symbol,
          quantity,
          entryPrice,
          currentPrice,
          pctChange: pctChange(entryPrice, currentPrice),
        };
      }
      const entryPrice = resolveOptionEntry(
        openLots,
        submitted,
        instrument,
        quantity,
        orders,
        currentPrice
      );
      return {
        assetType: 'option',
        symbol: instrument.symbol,
        quantity,
        optionType: instrument.optionType,
        strike: instrument.strike,
        expiration: instrument.expiration,
        entryPrice,
        currentPrice,
        pctChange: pctChange(entryPrice, currentPrice),
      };
    });

  return Promise.all(rows);
}

const pctChange = (entry: number | null, current: number | null): number | null =>
  entry !== null && current !== null && entry > 0 ? ((current - entry) / entry) * 100 : null;
