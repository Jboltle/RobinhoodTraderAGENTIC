/**
 * The only place in the codebase that talks to the database.
 *
 * Every query runs through Drizzle over one direct Postgres connection
 * (SUPABASE_DB_URL), sign-in included: accounts, invites and sessions are rows
 * here like everything else.
 *
 * Every method that touches per-user data takes `userId` as its first
 * argument, so a caller cannot forget to scope a query. The shared-data and
 * auth methods are grouped separately below and are the only ones without it.
 *
 * The connection authenticates as the database owner and is not subject to
 * RLS, so RLS is not what scopes these queries. This module is.
 *
 * Schema is owned by supabase/migrations/ and mirrored for the type system in
 * ./db/schema.ts — reconcile all three when it changes. Notable shape:
 *   users               the account: id, email and trade settings as typed
 *                       columns (defaults mirror TradeSettingsSchema)
 *   sessions            signed-in browsers by token hash, fk -> users
 *   trades              per-user decision audit log, fk -> users
 *   broker_connections  user_id pk (exactly one Robinhood connection per user),
 *                       fk -> users, ciphertext only
 *   messages            raw Discord archive written by the Listener
 *                       (server/listener) + the trader's verdict columns
 *                       (disposition/parse/processed_at); the poller's work
 *                       queue AND the feed source
 *   callers / recaps / recap_insights   shared, no user scope
 *   allowed_emails      invite list: an email here gets its users row at first
 *                       sign-in
 */
import { and, asc, count, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { config } from '../shared/config.js';
import {
  TERMINAL_ORDER_STATES,
  TradeSettingsSchema,
  defaultSettings,
  type Callout,
  type Decision,
  type OptionContract,
  type ResolvedTradeSettings,
  type SubmittedOrder,
  type TradeSettings,
} from '../shared/types.js';
import {
  EmbedLike,
  MAX_CONTENT_LENGTH,
  assembleMessageText,
  truncateSafe,
} from '../shared/embedText.js';
import type { TrackedPosition } from './book/ladder.js';
import { hashSessionToken } from './credentials.js';
import {
  allowedEmails,
  brokerConnections,
  callers,
  messages,
  recapInsights,
  recaps,
  sessions,
  trackedCallouts,
  trades,
  users,
} from './db/schema.js';
import { decryptTokens, encryptTokens } from './rh/tokenCrypto.js';
import type { RecapParse, RecapParseStatus } from './recaps/parser.js';
import type { PersistedState } from './rh/types.js';

/**
 * The trader's verdict on a captured Message. Null on the row means the poller
 * has not judged it yet. A Callout IS a message with disposition 'callout' —
 * the check constraint keeps `parse` present exactly then.
 */
export type MessageDisposition = 'callout' | 'not_callout' | 'failed' | 'missed' | 'recap';

/**
 * Legacy wire alias of MessageDisposition on the feed API, kept so the client
 * needs no changes: callout→parsed, missed→skipped, the rest map one-to-one.
 */
export type CalloutFeedStatus = 'parsed' | 'not_callout' | 'failed' | 'skipped';

const FEED_STATUS: Record<Exclude<MessageDisposition, 'recap'>, CalloutFeedStatus> = {
  callout: 'parsed',
  not_callout: 'not_callout',
  failed: 'failed',
  missed: 'skipped',
};

/** A feed item: a judged message row trimmed to the shape the dashboard reads. */
export interface StoredCallout {
  readonly messageId: string;
  readonly channelId: string;
  readonly channelName: string | null;
  /** '' only on rows migrated from before Caller Following existed. */
  readonly authorId: string | null;
  readonly authorName: string;
  /** Flattened at read: raw text + embed text, one field for display/search. */
  readonly content: string;
  readonly timestamp: string;
  readonly embeds: readonly Record<string, unknown>[];
  readonly parse: Callout | null;
  readonly parseStatus: CalloutFeedStatus;
}

/** An unprocessed `messages` row, as the poller consumes it. */
export interface PendingMessage {
  readonly messageId: string;
  readonly channelId: string;
  readonly channelName: string | null;
  readonly authorId: string;
  readonly authorName: string;
  /** Recovered from the raw snapshot (raw.author.avatar_url); null when absent. */
  readonly authorAvatarUrl: string | null;
  /** Raw text + attachment URLs, exactly as the Listener stored it. */
  readonly content: string;
  readonly embeds: readonly Record<string, unknown>[];
  readonly sentAt: string;
  readonly deletedAt: string | null;
  /** Non-null only on crash replay: the verdict was written but the row was never marked processed. */
  readonly disposition: MessageDisposition | null;
  /** The message this one replies to (raw.reference_id); null when it is not a reply. */
  readonly replyToMessageId: string | null;
}

/** A judged callout and who posted it: the card a reply can point at. */
export interface CalloutCard {
  readonly authorId: string;
  readonly parse: Callout;
}

/** A row in the shared `callers` table: one Caller (Discord author) in the roster. */
export interface Caller {
  readonly authorId: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly lastSeenAt: string;
}

/** A row in the shared `recaps` table: raw daily-recap post plus the cached parse. */
export interface StoredRecap {
  readonly messageId: string;
  readonly channelId: string;
  readonly postedAt: string;
  /** ISO trading day from the recap header; null for non-recap channel posts. */
  readonly recapDate: string | null;
  readonly content: string;
  readonly contentHash: string;
  readonly parse: RecapParse | null;
  readonly parseStatus: RecapParseStatus;
  readonly parserVersion: number;
}

/** Enough of a recaps row to decide whether a fetched message needs a re-save. */
export interface StoredRecapMeta {
  readonly messageId: string;
  readonly contentHash: string;
  readonly parserVersion: number;
}

export interface StoredRecapInsight {
  readonly windowDays: number;
  readonly generatedAt: string;
  readonly content: string;
}

/** The state a pending-approval row moves to once the user acts on it. */
export interface ApprovalOutcome {
  readonly kind: Extract<Decision['kind'], 'submitted' | 'execution_failed' | 'rejected'>;
  readonly code: Decision['code'];
  readonly reason: string;
  /** The submitted order for 'submitted'; the unchanged sized order otherwise. */
  readonly order: Decision['order'];
  readonly approvedAt: string;
}

/** A user identified by a live session token. */
export interface AuthUser {
  readonly id: string;
  readonly email: string | null;
}

/** A placed order whose broker state is not yet terminal, with its owner. */
export interface OpenOrderRow {
  readonly userId: string;
  readonly decision: Decision;
}

export interface TraderDb {
  // ---- Per-user: userId always first ----------------------------------------

  getSettings(userId: string): Promise<ResolvedTradeSettings>;
  saveSettings(userId: string, settings: TradeSettings): Promise<ResolvedTradeSettings>;

  listDecisions(userId: string, limit: number): Promise<Decision[]>;
  recordDecision(userId: string, decision: Decision): Promise<void>;
  /**
   * Move a pending-approval row to its post-approval state, in place.
   *
   * Scoped to `kind = 'pending_approval'` so it doubles as a compare-and-set:
   * returns false when the row is already gone or already resolved, which is
   * what stops a double-click from submitting the same order twice.
   */
  resolvePendingApproval(
    userId: string,
    messageId: string,
    outcome: ApprovalOutcome
  ): Promise<boolean>;
  /** Decisions for the given callouts, keyed by message id. */
  decisionsByMessageId(userId: string, messageIds: readonly string[]): Promise<Map<string, Decision>>;
  /**
   * Replace the stored order on one decision row: the fill monitor's write.
   * Keyed like recordDecision's uniqueness, so it reaches synthetic rows
   * (max_loss_exit) as well as callout-driven ones.
   */
  updateOrder(userId: string, messageId: string, order: SubmittedOrder): Promise<void>;
  /**
   * A hash of everything this user's feed page (listCallouts(limit) joined
   * with their decisions) is built from: equal versions mean an identical
   * page. Computed in the database, so only the hash crosses the wire.
   */
  feedVersion(userId: string, limit: number): Promise<string>;

  /** Submitted orders since `since` — the daily cap counter. */
  countSubmittedSince(userId: string, since: Date): Promise<number>;
  /** When this user last submitted an order for `ticker`; null if never. */
  lastSubmittedAt(userId: string, ticker: string): Promise<Date | null>;

  getBrokerTokens(userId: string): Promise<PersistedState | null>;
  saveBrokerTokens(userId: string, state: PersistedState): Promise<void>;
  deleteBrokerTokens(userId: string): Promise<void>;

  // ---- Shared data: not user-scoped -----------------------------------------

  /** Users with a broker connection — the pipeline's fan-out set. */
  listBrokerUserIds(): Promise<string[]>;
  /**
   * Every user's placed orders since `since` whose broker state is not yet
   * terminal: the fill monitor's work list. Cross-user by design (one sweep
   * serves everyone); each row carries its owner.
   */
  listOpenOrders(since: Date): Promise<OpenOrderRow[]>;

  /** The poller's work queue: unjudged rows, oldest first. */
  listUnprocessedMessages(limit: number): Promise<PendingMessage[]>;
  /** Record the pipeline's verdict on a message. `parse` only for 'callout'. */
  setMessageDisposition(
    messageId: string,
    disposition: MessageDisposition,
    parse: Callout | null
  ): Promise<void>;
  /**
   * Atomically take ownership of an unprocessed row for `instanceId`. True
   * when this instance may handle it: unclaimed, already ours, or claimed
   * before `staleBefore` by an instance that never finished. False means
   * another live instance owns it — do not fan out.
   */
  claimMessage(messageId: string, instanceId: string, staleBefore: Date): Promise<boolean>;
  /** Instance currently holding the claim on a row, for diagnostics. */
  getMessageClaimant(messageId: string): Promise<string | null>;
  /** Take the row off the work queue once fully handled (fan-out included). */
  markMessageProcessed(messageId: string): Promise<void>;
  /**
   * Call `onMessage` whenever the Listener commits a row, and again after the
   * listening connection reconnects, since rows committed during the gap
   * notified nobody. Resolves whether a probe sent through the pool came
   * back: transaction-mode pooling accepts LISTEN but never delivers.
   */
  listenForMessages(onMessage: () => void): Promise<boolean>;

  /** The feed: judged messages (recaps excluded), newest first. */
  listCallouts(limit: number): Promise<StoredCallout[]>;
  /**
   * The Caller's buy callouts in `ticker` sent before `before`, newest first:
   * the entries a ticker-only exit ("out of NBIS") can be closing.
   */
  listCallerEntries(authorId: string, ticker: string, before: Date, limit: number): Promise<Callout[]>;
  /** The stored callout for one message, with its author; null unless it was judged a callout. */
  getMessageParse(messageId: string): Promise<CalloutCard | null>;

  /** Insert a Caller or refresh their display name/avatar/last-seen. */
  upsertCaller(caller: Caller): Promise<void>;
  listCallers(): Promise<Caller[]>;

  saveRecap(recap: StoredRecap): Promise<void>;
  /** Hash + parser version for the given message ids, for sweep upsert decisions. */
  listRecapMetas(messageIds: readonly string[]): Promise<Map<string, StoredRecapMeta>>;
  /** Daily recaps (rows with a recap_date) on or after `sinceDate` (ISO date). */
  listRecapsSince(sinceDate: string): Promise<StoredRecap[]>;
  latestRecapPostedAt(): Promise<string | null>;
  /** Rows whose cached parse predates `version` — re-parsed from raw at sweep. */
  listRecapsWithStaleParse(version: number): Promise<StoredRecap[]>;

  getRecapInsight(windowDays: number): Promise<StoredRecapInsight | null>;
  saveRecapInsight(insight: StoredRecapInsight): Promise<void>;

  /**
   * Open a tracked callout. A second open for the same message (crash replay)
   * is dropped, so a row's marks and fills are never reset.
   */
  openTrackedCallout(position: TrackedPosition): Promise<void>;
  /** Write a tracked position back in full (marks, ladder, fills, close). */
  saveTrackedCallout(position: TrackedPosition): Promise<void>;
  /** The book monitor's work list: open positions, oldest first. */
  listTrackedOpen(): Promise<TrackedPosition[]>;
  /** The Caller's newest open entry in this exact contract; what their exit closes. */
  findTrackedOpen(authorId: string, ticker: string, option: OptionContract): Promise<TrackedPosition | null>;
  /** Closed positions, newest close first; `since` null = all of them. */
  listTrackedClosedSince(since: Date | null): Promise<TrackedPosition[]>;

  // ---- Auth ------------------------------------------------------------------

  /**
   * The account a sign-in names: the user with this email, created on the
   * spot when the email is on the invite list. Null when it is neither.
   */
  userForSignIn(email: string): Promise<AuthUser | null>;
  /** Start a session for `token` (only its hash is stored), ending at `expiresAt`. */
  createSession(userId: string, token: string, expiresAt: Date): Promise<void>;
  /** End the session for `token`, if it exists. */
  deleteSession(token: string): Promise<void>;
  findUserByEmail(email: string): Promise<AuthUser | null>;
  /** Resolve a bearer token to its user; null when unknown or expired. */
  verifyAccessToken(token: string): Promise<AuthUser | null>;
}

/** Notified by the Listener's insert (server/listener/src/listener/db.py). */
const MESSAGES_CHANNEL = 'messages_captured';
/** How long the startup probe gets to come back before notifications are written off. */
const LISTEN_PROBE_TIMEOUT_MS = 5000;

export function createTraderDb(): TraderDb {
  // prepare: false keeps the connection usable behind a transaction-mode
  // pooler, should one ever sit in front of the database.
  // Remote URLs often omit sslmode; TLS is required anyway, and 'require' does
  // not verify the certificate (Railway's Postgres serves a self-signed one).
  // TLS stays off for local Postgres, which has none, and on Railway's private
  // network, which WireGuard already encrypts. (The Bun-era leak that first
  // forced this is in docs/reports/2026-10-20-bun-tls-upgrade-leak.md.)
  const { hostname } = new URL(config.supabaseDbUrl);
  const plaintext =
    /^(localhost|127\.0\.0\.1|host\.docker\.internal)$/i.test(hostname) ||
    hostname.endsWith('.railway.internal');
  const client = postgres(config.supabaseDbUrl, {
    prepare: false,
    ssl: plaintext ? false : 'require',
    // Pooler startups can omit public; unqualified "broker_connections" then
    // fails as relation-not-exist and Drizzle reports only the SQL.
    connection: { options: '-c search_path=public' },
  });
  return new DrizzleTraderDb(drizzle(client), client);
}

// =============================================================================
// Implementation
// =============================================================================

class DrizzleTraderDb implements TraderDb {
  constructor(
    private readonly db: PostgresJsDatabase,
    private readonly client: postgres.Sql
  ) {}

  async getSettings(userId: string): Promise<ResolvedTradeSettings> {
    const [row] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    // The auth sync trigger gives every user a row; a manually deleted one
    // falls back to the schema defaults rather than an error.
    return row ? toSettings(row) : defaultSettings();
  }

  async saveSettings(userId: string, settings: TradeSettings): Promise<ResolvedTradeSettings> {
    const payload = TradeSettingsSchema.parse(settings);
    await this.db.update(users).set(payload).where(eq(users.id, userId));
    return payload;
  }

  async listDecisions(userId: string, limit: number): Promise<Decision[]> {
    const rows = await this.db
      .select()
      .from(trades)
      .where(eq(trades.userId, userId))
      .orderBy(desc(trades.timestamp))
      .limit(limit);
    return rows.map(toDecision);
  }

  async recordDecision(userId: string, decision: Decision): Promise<void> {
    // Backstop for the poller claim: one decision per user per message
    // (trades_user_message_uidx) — a second write for the same pair is dropped.
    await this.db.insert(trades).values({
      userId,
      messageId: decision.messageId,
      kind: decision.kind,
      code: decision.code,
      reason: decision.reason,
      ticker: decision.ticker,
      action: decision.action,
      orderPayload: decision.order,
      timestamp: new Date(decision.at),
    }).onConflictDoNothing({ target: [trades.userId, trades.messageId] });
  }

  async resolvePendingApproval(
    userId: string,
    messageId: string,
    outcome: ApprovalOutcome
  ): Promise<boolean> {
    const updated = await this.db
      .update(trades)
      .set({
        kind: outcome.kind,
        code: outcome.code,
        reason: outcome.reason,
        orderPayload: outcome.order,
        approvedAt: new Date(outcome.approvedAt),
      })
      .where(
        and(
          eq(trades.userId, userId),
          eq(trades.messageId, messageId),
          eq(trades.kind, 'pending_approval')
        )
      )
      .returning({ messageId: trades.messageId });
    return updated.length > 0;
  }

  async updateOrder(userId: string, messageId: string, order: SubmittedOrder): Promise<void> {
    await this.db
      .update(trades)
      .set({ orderPayload: order })
      .where(and(eq(trades.userId, userId), eq(trades.messageId, messageId)));
  }

  async listOpenOrders(since: Date): Promise<OpenOrderRow[]> {
    // Placed orders only (an orderId exists), state not terminal. The jsonb
    // reads stay in SQL so a thousand historical rows never cross the wire.
    const terminal = [...TERMINAL_ORDER_STATES];
    const rows = await this.db
      .select()
      .from(trades)
      .where(
        and(
          inArray(trades.kind, ['submitted', 'max_loss_exit']),
          gte(trades.timestamp, since),
          sql`${trades.orderPayload} ->> 'orderId' is not null`,
          sql`lower(coalesce(${trades.orderPayload} ->> 'status', '')) not in ${terminal}`
        )
      )
      .orderBy(asc(trades.timestamp));
    return rows.map((row) => ({ userId: row.userId, decision: toDecision(row) }));
  }

  async decisionsByMessageId(
    userId: string,
    messageIds: readonly string[]
  ): Promise<Map<string, Decision>> {
    if (messageIds.length === 0) return new Map();
    const rows = await this.db
      .select()
      .from(trades)
      .where(and(eq(trades.userId, userId), inArray(trades.messageId, [...messageIds])))
      .orderBy(asc(trades.timestamp));
    // Ascending order means the last write for a message id wins, which is the
    // newest outcome — a retried message shows its final state.
    return new Map(rows.map((row) => [row.messageId, toDecision(row)]));
  }

  async feedVersion(userId: string, limit: number): Promise<string> {
    // Same rows, filter and order as listCallouts, hashing every column the
    // feed shows (content and embeds change on Discord embed unfurls without
    // edited_at moving), plus the user's trades rows for those messages.
    const [row] = await this.db.execute<{ version: string }>(sql`
      with feed as (
        select id, channel_id, channel_name, author_id, author_name, content, embeds,
               sent_at, disposition, parse
          from messages
         where disposition is not null and disposition <> 'recap'
         order by sent_at desc
         limit ${limit}
      )
      select md5(concat_ws('#',
        ${userId}::text,
        (select string_agg(md5(feed::text), ',' order by sent_at desc, id) from feed),
        (select string_agg(md5(t::text), ',' order by t.timestamp, t.id)
           from trades t
          where t.user_id = ${userId} and t.message_id in (select id from feed))
      )) as version
    `);
    return row!.version;
  }

  async countSubmittedSince(userId: string, since: Date): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(trades)
      .where(
        and(eq(trades.userId, userId), eq(trades.kind, 'submitted'), gte(trades.timestamp, since))
      );
    return row?.value ?? 0;
  }

  async lastSubmittedAt(userId: string, ticker: string): Promise<Date | null> {
    const [row] = await this.db
      .select({ timestamp: trades.timestamp })
      .from(trades)
      .where(
        and(
          eq(trades.userId, userId),
          eq(trades.kind, 'submitted'),
          eq(trades.ticker, ticker.toUpperCase())
        )
      )
      .orderBy(desc(trades.timestamp))
      .limit(1);
    return row?.timestamp ?? null;
  }

  async getBrokerTokens(userId: string): Promise<PersistedState | null> {
    const [row] = await this.db
      .select({ encryptedTokens: brokerConnections.encryptedTokens })
      .from(brokerConnections)
      .where(eq(brokerConnections.userId, userId))
      .limit(1);
    if (!row) return null;
    const blob = Buffer.from(row.encryptedTokens, 'base64');
    return JSON.parse(decryptTokens(blob, config.rhTokensVaultKey)) as PersistedState;
  }

  async saveBrokerTokens(userId: string, state: PersistedState): Promise<void> {
    const blob = encryptTokens(JSON.stringify(state), config.rhTokensVaultKey);
    const encryptedTokens = blob.toString('base64');
    await this.db
      .insert(brokerConnections)
      .values({ userId, encryptedTokens })
      .onConflictDoUpdate({
        target: brokerConnections.userId,
        set: { encryptedTokens, updatedAt: new Date() },
      });
  }

  async deleteBrokerTokens(userId: string): Promise<void> {
    await this.db.delete(brokerConnections).where(eq(brokerConnections.userId, userId));
  }

  async listBrokerUserIds(): Promise<string[]> {
    const rows = await this.db.select({ userId: brokerConnections.userId }).from(brokerConnections);
    return rows.map((row) => row.userId);
  }

  async listUnprocessedMessages(limit: number): Promise<PendingMessage[]> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(isNull(messages.processedAt))
      .orderBy(asc(messages.sentAt))
      .limit(limit);
    return rows.map(toPendingMessage);
  }

  async setMessageDisposition(
    messageId: string,
    disposition: MessageDisposition,
    parse: Callout | null
  ): Promise<void> {
    await this.db.update(messages).set({ disposition, parse }).where(eq(messages.id, messageId));
  }

  async claimMessage(messageId: string, instanceId: string, staleBefore: Date): Promise<boolean> {
    const rows = await this.db
      .update(messages)
      .set({ claimedAt: new Date(), claimedBy: instanceId })
      .where(
        and(
          eq(messages.id, messageId),
          isNull(messages.processedAt),
          or(
            isNull(messages.claimedAt),
            eq(messages.claimedBy, instanceId),
            lt(messages.claimedAt, staleBefore)
          )
        )
      )
      .returning({ id: messages.id });
    return rows.length > 0;
  }

  async getMessageClaimant(messageId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ claimedBy: messages.claimedBy })
      .from(messages)
      .where(eq(messages.id, messageId));
    return row?.claimedBy ?? null;
  }

  async markMessageProcessed(messageId: string): Promise<void> {
    // claimed_at is released so a row the Listener re-opens (recap edits)
    // can be claimed again; claimed_by stays as the record of who handled it.
    await this.db
      .update(messages)
      .set({ processedAt: new Date(), claimedAt: null })
      .where(eq(messages.id, messageId));
  }

  async listenForMessages(onMessage: () => void): Promise<boolean> {
    let heard = (): void => {};
    const delivered = new Promise<boolean>((resolve) => {
      heard = () => resolve(true);
    });
    await this.client.listen(
      MESSAGES_CHANNEL,
      () => {
        heard();
        onMessage();
      },
      onMessage
    );
    await this.client.notify(MESSAGES_CHANNEL, 'probe');
    const timedOut = new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), LISTEN_PROBE_TIMEOUT_MS).unref();
    });
    return Promise.race([delivered, timedOut]);
  }

  async listCallouts(limit: number): Promise<StoredCallout[]> {
    // Egress: only what the feed shows — never raw, the full Discord payload.
    const rows = await this.db
      .select({
        id: messages.id,
        channelId: messages.channelId,
        channelName: messages.channelName,
        authorId: messages.authorId,
        authorName: messages.authorName,
        content: messages.content,
        embeds: messages.embeds,
        sentAt: messages.sentAt,
        disposition: messages.disposition,
        parse: messages.parse,
      })
      .from(messages)
      .where(and(isNotNull(messages.disposition), ne(messages.disposition, 'recap')))
      .orderBy(desc(messages.sentAt))
      .limit(limit);
    return rows.map(toStoredCallout);
  }

  async listCallerEntries(
    authorId: string,
    ticker: string,
    before: Date,
    limit: number
  ): Promise<Callout[]> {
    // ponytail: filters parse jsonb without an index, fine at a few thousand
    // rows. Upgrade path: an index on (author_id, sent_at).
    const rows = await this.db
      .select({ parse: messages.parse })
      .from(messages)
      .where(
        and(
          eq(messages.authorId, authorId),
          eq(messages.disposition, 'callout'),
          lt(messages.sentAt, before),
          sql`${messages.parse}->>'action' = 'buy'`,
          sql`${messages.parse}->>'ticker' = ${ticker.toUpperCase()}`
        )
      )
      .orderBy(desc(messages.sentAt))
      .limit(limit);
    return rows.flatMap((row) => (row.parse ? [row.parse] : []));
  }

  async getMessageParse(messageId: string): Promise<CalloutCard | null> {
    const [row] = await this.db
      .select({ authorId: messages.authorId, parse: messages.parse })
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.disposition, 'callout')));
    return row?.parse ? { authorId: row.authorId, parse: row.parse } : null;
  }

  async upsertCaller(caller: Caller): Promise<void> {
    await this.db
      .insert(callers)
      .values({
        authorId: caller.authorId,
        displayName: caller.displayName,
        avatarUrl: caller.avatarUrl,
        lastSeenAt: new Date(caller.lastSeenAt),
      })
      .onConflictDoUpdate({
        target: callers.authorId,
        set: {
          displayName: caller.displayName,
          lastSeenAt: new Date(caller.lastSeenAt),
          // Null avatar (old-bot envelopes) must not clobber a stored one:
          // omitting the column leaves the existing value untouched on conflict.
          ...(caller.avatarUrl !== null && { avatarUrl: caller.avatarUrl }),
        },
      });
  }

  async listCallers(): Promise<Caller[]> {
    const rows = await this.db.select().from(callers).orderBy(asc(callers.displayName));
    return rows.map((row) => ({
      authorId: row.authorId,
      displayName: row.displayName,
      avatarUrl: row.avatarUrl,
      lastSeenAt: row.lastSeenAt.toISOString(),
    }));
  }

  async saveRecap(recap: StoredRecap): Promise<void> {
    const values = {
      messageId: recap.messageId,
      channelId: recap.channelId,
      postedAt: new Date(recap.postedAt),
      recapDate: recap.recapDate,
      content: recap.content,
      contentHash: recap.contentHash,
      parse: recap.parse,
      parseStatus: recap.parseStatus,
      parserVersion: recap.parserVersion,
    };
    await this.db
      .insert(recaps)
      .values(values)
      .onConflictDoUpdate({ target: recaps.messageId, set: values });
  }

  async listRecapMetas(messageIds: readonly string[]): Promise<Map<string, StoredRecapMeta>> {
    // Unlike PostgREST (where `in` filters ride in the query string), a SQL IN
    // list has no practical size limit at this scale — no chunking needed.
    if (messageIds.length === 0) return new Map();
    const rows = await this.db
      .select({
        messageId: recaps.messageId,
        contentHash: recaps.contentHash,
        parserVersion: recaps.parserVersion,
      })
      .from(recaps)
      .where(inArray(recaps.messageId, [...messageIds]));
    return new Map(rows.map((row) => [row.messageId, row]));
  }

  async listRecapsSince(sinceDate: string): Promise<StoredRecap[]> {
    const rows = await this.db
      .select()
      .from(recaps)
      .where(gte(recaps.recapDate, sinceDate))
      .orderBy(asc(recaps.recapDate));
    return rows.map(toStoredRecap);
  }

  async latestRecapPostedAt(): Promise<string | null> {
    const [row] = await this.db
      .select({ postedAt: recaps.postedAt })
      .from(recaps)
      .orderBy(desc(recaps.postedAt))
      .limit(1);
    return row ? row.postedAt.toISOString() : null;
  }

  async listRecapsWithStaleParse(version: number): Promise<StoredRecap[]> {
    const rows = await this.db.select().from(recaps).where(lt(recaps.parserVersion, version));
    return rows.map(toStoredRecap);
  }

  async getRecapInsight(windowDays: number): Promise<StoredRecapInsight | null> {
    const [row] = await this.db
      .select()
      .from(recapInsights)
      .where(eq(recapInsights.windowDays, windowDays))
      .limit(1);
    if (!row) return null;
    return {
      windowDays: row.windowDays,
      generatedAt: row.generatedAt.toISOString(),
      content: row.content,
    };
  }

  async saveRecapInsight(insight: StoredRecapInsight): Promise<void> {
    const values = {
      windowDays: insight.windowDays,
      generatedAt: new Date(insight.generatedAt),
      content: insight.content,
    };
    await this.db
      .insert(recapInsights)
      .values(values)
      .onConflictDoUpdate({ target: recapInsights.windowDays, set: values });
  }

  async openTrackedCallout(position: TrackedPosition): Promise<void> {
    await this.db
      .insert(trackedCallouts)
      .values(fromTrackedPosition(position))
      .onConflictDoNothing({ target: trackedCallouts.messageId });
  }

  async saveTrackedCallout(position: TrackedPosition): Promise<void> {
    const { messageId, ...values } = fromTrackedPosition(position);
    await this.db.update(trackedCallouts).set(values).where(eq(trackedCallouts.messageId, messageId));
  }

  async listTrackedOpen(): Promise<TrackedPosition[]> {
    const rows = await this.db
      .select()
      .from(trackedCallouts)
      .where(isNull(trackedCallouts.closedAt))
      .orderBy(asc(trackedCallouts.openedAt));
    return rows.map(toTrackedPosition);
  }

  async findTrackedOpen(
    authorId: string,
    ticker: string,
    option: OptionContract
  ): Promise<TrackedPosition | null> {
    const [row] = await this.db
      .select()
      .from(trackedCallouts)
      .where(
        and(
          isNull(trackedCallouts.closedAt),
          eq(trackedCallouts.authorId, authorId),
          eq(trackedCallouts.ticker, ticker.toUpperCase()),
          eq(trackedCallouts.optionType, option.optionType),
          eq(trackedCallouts.strike, option.strike),
          eq(trackedCallouts.expiration, option.expiration)
        )
      )
      .orderBy(desc(trackedCallouts.openedAt))
      .limit(1);
    return row ? toTrackedPosition(row) : null;
  }

  async listTrackedClosedSince(since: Date | null): Promise<TrackedPosition[]> {
    const rows = await this.db
      .select()
      .from(trackedCallouts)
      .where(
        since === null
          ? isNotNull(trackedCallouts.closedAt)
          : and(isNotNull(trackedCallouts.closedAt), gte(trackedCallouts.closedAt, since))
      )
      .orderBy(desc(trackedCallouts.closedAt));
    return rows.map(toTrackedPosition);
  }

  async userForSignIn(email: string): Promise<AuthUser | null> {
    const normalized = email.trim().toLowerCase();
    const existing = await this.findUserByEmail(normalized);
    if (existing) return existing;

    const [invite] = await this.db
      .select({ email: allowedEmails.email })
      .from(allowedEmails)
      .where(eq(allowedEmails.email, normalized))
      .limit(1);
    if (!invite) return null;

    // Two first sign-ins racing: the loser inserts nothing and reads the winner's row.
    const [created] = await this.db
      .insert(users)
      .values({ email: normalized })
      .onConflictDoNothing({ target: users.email })
      .returning({ id: users.id, email: users.email });
    return created ?? this.findUserByEmail(normalized);
  }

  async createSession(userId: string, token: string, expiresAt: Date): Promise<void> {
    // A new sign-in is also when the user's expired sessions are cleared out.
    await this.db
      .delete(sessions)
      .where(and(eq(sessions.userId, userId), lt(sessions.expiresAt, new Date())));
    await this.db.insert(sessions).values({ tokenHash: hashSessionToken(token), userId, expiresAt });
  }

  async deleteSession(token: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.tokenHash, hashSessionToken(token)));
  }

  async findUserByEmail(email: string): Promise<AuthUser | null> {
    const [row] = await this.db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.email, email.trim().toLowerCase()))
      .limit(1);
    return row ?? null;
  }

  async verifyAccessToken(token: string): Promise<AuthUser | null> {
    const [row] = await this.db
      .select({ id: users.id, email: users.email })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.tokenHash, hashSessionToken(token)), gt(sessions.expiresAt, new Date())))
      .limit(1);
    return row ?? null;
  }
}

// =============================================================================
// Row mapping — Drizzle rows are already camelCase and typed; what remains is
// Date -> ISO string conversion and trimming table rows to their public shapes.
// =============================================================================

function toSettings(row: typeof users.$inferSelect): ResolvedTradeSettings {
  return {
    executionMode: row.executionMode,
    equitySmallPct: row.equitySmallPct,
    equityMediumPct: row.equityMediumPct,
    equityFullPct: row.equityFullPct,
    optionsSmallPct: row.optionsSmallPct,
    optionsMediumPct: row.optionsMediumPct,
    optionsFullPct: row.optionsFullPct,
    optionsLottoPct: row.optionsLottoPct,
    maxSingleContractPct: row.maxSingleContractPct,
    maxTradesPerDay: row.maxTradesPerDay,
    cooldownSeconds: row.cooldownSeconds,
    allowedTickers: row.allowedTickers,
    blockedTickers: row.blockedTickers,
    minConfidence: row.minConfidence,
    regularHoursOnly: row.regularHoursOnly,
    allowLottoTrades: row.allowLottoTrades,
    followedCallerIds: row.followedCallerIds,
    maxLossPct: row.maxLossPct,
    maxLossUsd: row.maxLossUsd,
  };
}

function toDecision(row: typeof trades.$inferSelect): Decision {
  return {
    at: row.timestamp.toISOString(),
    messageId: row.messageId,
    kind: row.kind,
    code: row.code,
    reason: row.reason,
    ticker: row.ticker,
    action: row.action,
    order: row.orderPayload,
  };
}

/**
 * The read-time flatten: messages rows hold raw parts (text + embeds), and the
 * feed shows one text field. Same assembly flattenEnvelope performs on the
 * parse path; rows migrated from callouts history carry pre-flattened content
 * with empty embeds, so they pass through unchanged.
 */
function flattenRowContent(content: string, embeds: readonly Record<string, unknown>[]): string {
  return truncateSafe(
    assembleMessageText({
      body: content,
      stickerNames: [],
      attachmentUrls: [],
      embeds: embeds as readonly EmbedLike[],
    }),
    MAX_CONTENT_LENGTH
  );
}

function toStoredCallout(
  row: Pick<
    typeof messages.$inferSelect,
    | 'id'
    | 'channelId'
    | 'channelName'
    | 'authorId'
    | 'authorName'
    | 'content'
    | 'embeds'
    | 'sentAt'
    | 'disposition'
    | 'parse'
  >
): StoredCallout {
  return {
    messageId: row.id,
    channelId: row.channelId,
    channelName: row.channelName,
    authorId: row.authorId,
    authorName: row.authorName,
    content: flattenRowContent(row.content, row.embeds),
    timestamp: row.sentAt.toISOString(),
    embeds: row.embeds,
    parse: row.parse,
    // listCallouts filters recap rows out, so the cast never sees 'recap'.
    parseStatus: FEED_STATUS[row.disposition as Exclude<MessageDisposition, 'recap'>],
  };
}

function toPendingMessage(row: typeof messages.$inferSelect): PendingMessage {
  const raw = row.raw as { author?: { avatar_url?: string | null }; reference_id?: string | null };
  const author = raw.author;
  return {
    messageId: row.id,
    channelId: row.channelId,
    channelName: row.channelName,
    authorId: row.authorId,
    authorName: row.authorName,
    authorAvatarUrl: author?.avatar_url ?? null,
    content: row.content,
    embeds: row.embeds,
    sentAt: row.sentAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
    disposition: row.disposition,
    replyToMessageId: raw.reference_id ?? null,
  };
}

function toTrackedPosition(row: typeof trackedCallouts.$inferSelect): TrackedPosition {
  return {
    messageId: row.messageId,
    authorId: row.authorId,
    ticker: row.ticker,
    option: { optionType: row.optionType, strike: row.strike, expiration: row.expiration },
    entryPrice: row.entryPrice,
    nominalQty: row.nominalQty,
    openedAt: row.openedAt.toISOString(),
    closedAt: row.closedAt?.toISOString() ?? null,
    closedBy: row.closedBy,
    exitPrice: row.exitPrice,
    lastMark: row.lastMark,
    lastMarkAt: row.lastMarkAt?.toISOString() ?? null,
    highestPct: row.highestPct,
    highestPrice: row.highestPrice,
    ladder: row.ladder,
    fills: row.fills,
    result: row.result,
  };
}

function fromTrackedPosition(position: TrackedPosition): typeof trackedCallouts.$inferInsert {
  return {
    messageId: position.messageId,
    authorId: position.authorId,
    ticker: position.ticker,
    optionType: position.option.optionType,
    strike: position.option.strike,
    expiration: position.option.expiration,
    entryPrice: position.entryPrice,
    nominalQty: position.nominalQty,
    openedAt: new Date(position.openedAt),
    closedAt: position.closedAt === null ? null : new Date(position.closedAt),
    closedBy: position.closedBy,
    exitPrice: position.exitPrice,
    lastMark: position.lastMark,
    lastMarkAt: position.lastMarkAt === null ? null : new Date(position.lastMarkAt),
    highestPct: position.highestPct,
    highestPrice: position.highestPrice,
    ladder: [...position.ladder],
    fills: [...position.fills],
    result: position.result,
  };
}

function toStoredRecap(row: typeof recaps.$inferSelect): StoredRecap {
  return {
    messageId: row.messageId,
    channelId: row.channelId,
    postedAt: row.postedAt.toISOString(),
    recapDate: row.recapDate,
    content: row.content,
    contentHash: row.contentHash,
    parse: row.parse,
    parseStatus: row.parseStatus,
    parserVersion: row.parserVersion,
  };
}
