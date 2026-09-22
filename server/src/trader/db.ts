/**
 * The only place in the codebase that talks to the database.
 *
 * Table queries run through Drizzle over a direct Postgres connection
 * (SUPABASE_DB_URL — session pooler), skipping the PostgREST HTTP hop.
 * supabase-js remains for exactly three things, all Supabase Auth:
 * ensureUser, sendMagicLink, verifyAccessToken.
 *
 * Every method that touches per-user data takes `userId` as its first
 * argument, so a caller cannot forget to scope a query. The shared-data and
 * auth methods are grouped separately below and are the only ones without it.
 *
 * The direct connection authenticates as the database owner and is not subject
 * to RLS — RLS still matters because the anon key ships in the browser bundle
 * and PostgREST is public, but it is not what scopes these queries. This
 * module is.
 *
 * Schema is owned by supabase/migrations/ and mirrored for the type system in
 * ./db/schema.ts — reconcile all three when it changes. Notable shape:
 *   users               id/email synced from auth.users by trigger; trade
 *                       settings as typed columns (defaults mirror
 *                       TradeSettingsSchema)
 *   trades              per-user decision audit log, fk -> users
 *   broker_connections  user_id pk (exactly one Robinhood connection per user),
 *                       fk -> users, ciphertext only
 *   messages            raw Discord archive written by the Listener
 *                       (server/listener) + the trader's verdict columns
 *                       (disposition/parse/processed_at); the poller's work
 *                       queue AND the feed source
 *   callers / recaps / recap_insights   shared, no user scope
 *   allowed_emails      invite gate, independent of the sign-in mechanism
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lt, ne } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { config } from '../shared/config.js';
import {
  TradeSettingsSchema,
  defaultSettings,
  type Callout,
  type Decision,
  type ResolvedTradeSettings,
  type TradeSettings,
} from '../shared/types.js';
import {
  EmbedLike,
  MAX_CONTENT_LENGTH,
  assembleMessageText,
  truncateSafe,
} from '../shared/embedText.js';
import {
  allowedEmails,
  brokerConnections,
  callers,
  messages,
  recapInsights,
  recaps,
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

/** A user identified by a verified Supabase access token. */
export interface AuthUser {
  readonly id: string;
  readonly email: string | null;
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

  /** The poller's work queue: unjudged rows, oldest first. */
  listUnprocessedMessages(limit: number): Promise<PendingMessage[]>;
  /** Record the pipeline's verdict on a message. `parse` only for 'callout'. */
  setMessageDisposition(
    messageId: string,
    disposition: MessageDisposition,
    parse: Callout | null
  ): Promise<void>;
  /** Take the row off the work queue once fully handled (fan-out included). */
  markMessageProcessed(messageId: string): Promise<void>;

  /** The feed: judged messages (recaps excluded), newest first. */
  listCallouts(limit: number): Promise<StoredCallout[]>;

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

  // ---- Auth ------------------------------------------------------------------

  isEmailAllowed(email: string): Promise<boolean>;
  /** Create the passwordless auth user if it does not exist yet. */
  ensureUser(email: string): Promise<void>;
  /** Email a one-time sign-in link. The user must already exist. */
  sendMagicLink(email: string): Promise<void>;
  findUserByEmail(email: string): Promise<AuthUser | null>;
  /** Resolve a bearer token to its user; null when absent, expired or forged. */
  verifyAccessToken(token: string): Promise<AuthUser | null>;
}

export function createTraderDb(): TraderDb {
  // prepare: false keeps the connection compatible with Supabase's transaction
  // pooler too, should the env ever point at port 6543 instead of session mode.
  // Remote URLs often omit sslmode=require; Supabase still demands TLS. Local
  // CLI / host.docker.internal Postgres does not.
  const local = /localhost|127\.0\.0\.1|host\.docker\.internal/i.test(config.supabaseDbUrl);
  const client = postgres(config.supabaseDbUrl, {
    prepare: false,
    ssl: local ? false : 'require',
    // Pooler startups can omit public; unqualified "broker_connections" then
    // fails as relation-not-exist and Drizzle reports only the SQL.
    connection: { options: '-c search_path=public' },
  });
  const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return new DrizzleTraderDb(drizzle(client), supabase);
}

// =============================================================================
// Implementation
// =============================================================================

class DrizzleTraderDb implements TraderDb {
  constructor(
    private readonly db: PostgresJsDatabase,
    private readonly supabase: SupabaseClient
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
    });
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

  async markMessageProcessed(messageId: string): Promise<void> {
    await this.db
      .update(messages)
      .set({ processedAt: new Date() })
      .where(eq(messages.id, messageId));
  }

  async listCallouts(limit: number): Promise<StoredCallout[]> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(and(isNotNull(messages.disposition), ne(messages.disposition, 'recap')))
      .orderBy(desc(messages.sentAt))
      .limit(limit);
    return rows.map(toStoredCallout);
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

  async isEmailAllowed(email: string): Promise<boolean> {
    const [row] = await this.db
      .select({ email: allowedEmails.email })
      .from(allowedEmails)
      .where(eq(allowedEmails.email, email.trim().toLowerCase()))
      .limit(1);
    return row !== undefined;
  }

  async ensureUser(email: string): Promise<void> {
    // Passwordless: the only way in is the emailed link. The admin API works
    // even with self-serve signups disabled on the Supabase project. The
    // sync_user_from_auth trigger creates the public.users row — no follow-up
    // write needed here.
    const { error } = await this.supabase.auth.admin.createUser({
      email: email.trim().toLowerCase(),
      email_confirm: true,
    });
    if (error && error.code !== 'email_exists') {
      throw new Error(`could not create user: ${error.message}`);
    }
  }

  async sendMagicLink(email: string): Promise<void> {
    // shouldCreateUser false keeps this a pure sign-in: account creation only
    // ever happens through ensureUser, behind the allowlist check.
    const { error } = await this.supabase.auth.signInWithOtp({
      email: email.trim().toLowerCase(),
      options: { shouldCreateUser: false },
    });
    if (error) throw new Error(`could not send sign-in link: ${error.message}`);
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
    const { data, error } = await this.supabase.auth.getUser(token);
    if (error || !data.user) return null;
    return { id: data.user.id, email: data.user.email ?? null };
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
    maxSingleContractPct: row.maxSingleContractPct,
    maxTradesPerDay: row.maxTradesPerDay,
    cooldownSeconds: row.cooldownSeconds,
    allowedTickers: row.allowedTickers,
    blockedTickers: row.blockedTickers,
    minConfidence: row.minConfidence,
    regularHoursOnly: row.regularHoursOnly,
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

function toStoredCallout(row: typeof messages.$inferSelect): StoredCallout {
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
  const author = (row.raw as { author?: { avatar_url?: string | null } }).author;
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
