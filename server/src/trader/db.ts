/**
 * The only place in the codebase that talks to Supabase.
 *
 * Every method that touches per-user data takes `userId` as its first
 * argument, so a caller cannot forget to scope a query. The shared-data and
 * auth methods are grouped separately below and are the only ones without it.
 *
 * The client is created with the service-role key, which bypasses RLS — RLS
 * still matters because the anon key ships in the browser bundle and PostgREST
 * is public, but it is not what scopes these queries. This module is.
 *
 * Expected schema (owned by supabase/migrations/, reconcile there):
 *   callouts            message_id text pk, channel_id text, channel_name text,
 *                       author_id text, author_name text, content text,
 *                       timestamp timestamptz, embeds jsonb, parse jsonb,
 *                       parse_status text
 *   callers             author_id text pk, display_name text, avatar_url text,
 *                       last_seen_at timestamptz
 *   trades              id uuid pk, user_id uuid -> auth.users, message_id text,
 *                       kind text, code text, reason text, ticker text, action text,
 *                       order_payload jsonb, timestamp timestamptz
 *   settings            user_id uuid pk -> auth.users, payload jsonb
 *   allowed_emails      email text pk
 *   broker_connections  user_id uuid pk -> auth.users, encrypted_tokens text
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { config } from '../shared/config.js';
import {
  TradeSettingsSchema,
  type Callout,
  type Decision,
  type ResolvedTradeSettings,
  type TradeSettings,
} from '../shared/types.js';
import { decryptTokens, encryptTokens } from './rh/tokenCrypto.js';
import type { PersistedState } from './rh/types.js';

/** How far the LLM got on a callout. Staleness is per-user, not recorded here. */
export type CalloutParseStatus = 'parsed' | 'not_callout' | 'failed' | 'skipped';

/** A row in the shared `callouts` table: Discord snapshot plus the cached parse. */
export interface StoredCallout {
  readonly messageId: string;
  readonly channelId: string;
  readonly channelName: string | null;
  /** Null only on rows written before Caller Following existed. */
  readonly authorId: string | null;
  readonly authorName: string;
  readonly content: string;
  readonly timestamp: string;
  readonly embeds: readonly Record<string, unknown>[];
  readonly parse: Callout | null;
  readonly parseStatus: CalloutParseStatus;
}

/** A row in the shared `callers` table: one Caller (Discord author) in the roster. */
export interface Caller {
  readonly authorId: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly lastSeenAt: string;
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

  getCallout(messageId: string): Promise<StoredCallout | null>;
  saveCallout(callout: StoredCallout): Promise<void>;
  listCallouts(limit: number): Promise<StoredCallout[]>;

  /** Insert a Caller or refresh their display name/avatar/last-seen. */
  upsertCaller(caller: Caller): Promise<void>;
  listCallers(): Promise<Caller[]>;

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
  const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return new SupabaseTraderDb(supabase);
}

// =============================================================================
// Implementation
// =============================================================================

const DECISION_COLUMNS = 'message_id, kind, code, reason, ticker, action, order_payload, timestamp';
const CALLOUT_COLUMNS =
  'message_id, channel_id, channel_name, author_id, author_name, content, timestamp, embeds, parse, parse_status';

class SupabaseTraderDb implements TraderDb {
  constructor(private readonly supabase: SupabaseClient) {}

  async getSettings(userId: string): Promise<ResolvedTradeSettings> {
    const { data, error } = await this.supabase
      .from('settings')
      .select('payload')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw queryError('load settings', error);
    // A user with no row (or a row written before a schema field existed) gets
    // the schema defaults rather than an error.
    const parsed = TradeSettingsSchema.safeParse(data?.payload ?? {});
    return parsed.success ? parsed.data : TradeSettingsSchema.parse({});
  }

  async saveSettings(userId: string, settings: TradeSettings): Promise<ResolvedTradeSettings> {
    const payload = TradeSettingsSchema.parse(settings);
    const { error } = await this.supabase
      .from('settings')
      .upsert({ user_id: userId, payload }, { onConflict: 'user_id' });
    if (error) throw queryError('save settings', error);
    return payload;
  }

  async listDecisions(userId: string, limit: number): Promise<Decision[]> {
    const { data, error } = await this.supabase
      .from('trades')
      .select(DECISION_COLUMNS)
      .eq('user_id', userId)
      .order('timestamp', { ascending: false })
      .limit(limit);
    if (error) throw queryError('list decisions', error);
    return (data ?? []).map(toDecision);
  }

  async recordDecision(userId: string, decision: Decision): Promise<void> {
    const { error } = await this.supabase.from('trades').insert({
      user_id: userId,
      message_id: decision.messageId,
      kind: decision.kind,
      code: decision.code,
      reason: decision.reason,
      ticker: decision.ticker,
      action: decision.action,
      order_payload: decision.order,
      timestamp: decision.at,
    });
    if (error) throw queryError('record decision', error);
  }

  async decisionsByMessageId(
    userId: string,
    messageIds: readonly string[]
  ): Promise<Map<string, Decision>> {
    if (messageIds.length === 0) return new Map();
    const { data, error } = await this.supabase
      .from('trades')
      .select(DECISION_COLUMNS)
      .eq('user_id', userId)
      .in('message_id', [...messageIds])
      .order('timestamp', { ascending: true });
    if (error) throw queryError('load decisions for callouts', error);
    // Ascending order means the last write for a message id wins, which is the
    // newest outcome — a retried message shows its final state.
    return new Map((data ?? []).map((row) => [String(row.message_id), toDecision(row)]));
  }

  async countSubmittedSince(userId: string, since: Date): Promise<number> {
    const { count, error } = await this.supabase
      .from('trades')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('kind', 'submitted')
      .gte('timestamp', since.toISOString());
    if (error) throw queryError('count submitted trades', error);
    return count ?? 0;
  }

  async lastSubmittedAt(userId: string, ticker: string): Promise<Date | null> {
    const { data, error } = await this.supabase
      .from('trades')
      .select('timestamp')
      .eq('user_id', userId)
      .eq('kind', 'submitted')
      .eq('ticker', ticker.toUpperCase())
      .order('timestamp', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw queryError('load last trade time', error);
    return data?.timestamp ? new Date(String(data.timestamp)) : null;
  }

  async getBrokerTokens(userId: string): Promise<PersistedState | null> {
    const { data, error } = await this.supabase
      .from('broker_connections')
      .select('encrypted_tokens')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw queryError('load broker connection', error);
    if (!data?.encrypted_tokens) return null;
    const blob = Buffer.from(String(data.encrypted_tokens), 'base64');
    return JSON.parse(decryptTokens(blob, config.rhTokensVaultKey)) as PersistedState;
  }

  async saveBrokerTokens(userId: string, state: PersistedState): Promise<void> {
    const blob = encryptTokens(JSON.stringify(state), config.rhTokensVaultKey);
    const { error } = await this.supabase.from('broker_connections').upsert(
      { user_id: userId, encrypted_tokens: blob.toString('base64') },
      { onConflict: 'user_id' }
    );
    if (error) throw queryError('save broker connection', error);
  }

  async deleteBrokerTokens(userId: string): Promise<void> {
    const { error } = await this.supabase
      .from('broker_connections')
      .delete()
      .eq('user_id', userId);
    if (error) throw queryError('delete broker connection', error);
  }

  async listBrokerUserIds(): Promise<string[]> {
    const { data, error } = await this.supabase.from('broker_connections').select('user_id');
    if (error) throw queryError('list connected users', error);
    return (data ?? []).map((row) => String(row.user_id));
  }

  async getCallout(messageId: string): Promise<StoredCallout | null> {
    const { data, error } = await this.supabase
      .from('callouts')
      .select(CALLOUT_COLUMNS)
      .eq('message_id', messageId)
      .maybeSingle();
    if (error) throw queryError('load callout', error);
    return data ? toStoredCallout(data) : null;
  }

  async saveCallout(callout: StoredCallout): Promise<void> {
    const { error } = await this.supabase.from('callouts').upsert(
      {
        message_id: callout.messageId,
        channel_id: callout.channelId,
        channel_name: callout.channelName,
        author_id: callout.authorId,
        author_name: callout.authorName,
        content: callout.content,
        timestamp: callout.timestamp,
        embeds: callout.embeds,
        parse: callout.parse,
        parse_status: callout.parseStatus,
      },
      { onConflict: 'message_id' }
    );
    if (error) throw queryError('save callout', error);
  }

  async listCallouts(limit: number): Promise<StoredCallout[]> {
    const { data, error } = await this.supabase
      .from('callouts')
      .select(CALLOUT_COLUMNS)
      .order('timestamp', { ascending: false })
      .limit(limit);
    if (error) throw queryError('list callouts', error);
    return (data ?? []).map(toStoredCallout);
  }

  async upsertCaller(caller: Caller): Promise<void> {
    const { error } = await this.supabase.from('callers').upsert(
      {
        author_id: caller.authorId,
        display_name: caller.displayName,
        // Null avatar (old-bot envelopes) must not clobber a stored one:
        // omitting the column leaves the existing value untouched on conflict.
        ...(caller.avatarUrl !== null && { avatar_url: caller.avatarUrl }),
        last_seen_at: caller.lastSeenAt,
      },
      { onConflict: 'author_id' }
    );
    if (error) throw queryError('upsert caller', error);
  }

  async listCallers(): Promise<Caller[]> {
    const { data, error } = await this.supabase
      .from('callers')
      .select('author_id, display_name, avatar_url, last_seen_at')
      .order('display_name', { ascending: true });
    if (error) throw queryError('list callers', error);
    return (data ?? []).map((row) => ({
      authorId: String(row.author_id),
      displayName: String(row.display_name),
      avatarUrl: (row.avatar_url as string | null) ?? null,
      lastSeenAt: String(row.last_seen_at),
    }));
  }

  async isEmailAllowed(email: string): Promise<boolean> {
    const { data, error } = await this.supabase
      .from('allowed_emails')
      .select('email')
      .eq('email', email.trim().toLowerCase())
      .maybeSingle();
    if (error) throw queryError('check signup allowlist', error);
    return data !== null;
  }

  async ensureUser(email: string): Promise<void> {
    // Passwordless: the only way in is the emailed link. The admin API works
    // even with self-serve signups disabled on the Supabase project.
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
    const wanted = email.trim().toLowerCase();
    // ponytail: scans the first page of users, so it stops finding people past
    // ~50 accounts. Only the operator CLIs use it. Upgrade path: a users view
    // or an RPC that filters server-side.
    const { data, error } = await this.supabase.auth.admin.listUsers();
    if (error) throw new Error(`supabase: could not list users: ${error.message}`);
    const user = data.users.find((u) => u.email?.toLowerCase() === wanted);
    return user ? { id: user.id, email: user.email ?? null } : null;
  }

  async verifyAccessToken(token: string): Promise<AuthUser | null> {
    const { data, error } = await this.supabase.auth.getUser(token);
    if (error || !data.user) return null;
    return { id: data.user.id, email: data.user.email ?? null };
  }
}

// =============================================================================
// Row mapping
// =============================================================================

const queryError = (action: string, error: { message: string }): Error =>
  new Error(`supabase: could not ${action}: ${error.message}`);

function toDecision(row: Record<string, unknown>): Decision {
  return {
    at: String(row.timestamp),
    messageId: String(row.message_id),
    kind: row.kind as Decision['kind'],
    code: (row.code as Decision['code']) ?? null,
    reason: String(row.reason ?? ''),
    ticker: (row.ticker as string | null) ?? null,
    action: (row.action as Decision['action']) ?? null,
    order: (row.order_payload as Decision['order']) ?? null,
  };
}

function toStoredCallout(row: Record<string, unknown>): StoredCallout {
  return {
    messageId: String(row.message_id),
    channelId: String(row.channel_id ?? ''),
    channelName: (row.channel_name as string | null) ?? null,
    authorId: (row.author_id as string | null) ?? null,
    authorName: String(row.author_name ?? ''),
    content: String(row.content ?? ''),
    timestamp: String(row.timestamp),
    embeds: (row.embeds as Record<string, unknown>[] | null) ?? [],
    parse: (row.parse as Callout | null) ?? null,
    parseStatus: (row.parse_status as CalloutParseStatus) ?? 'skipped',
  };
}
