/**
 * Drizzle table definitions mirroring supabase/migrations/, which owns the
 * schema — drizzle-kit never generates migrations here (`drizzle-kit pull`
 * exists only to verify this file against a live database).
 *
 * camelCase properties map to the snake_case columns, so query results are
 * already shaped like the row types in db.ts. Timestamps use mode 'date' and
 * are converted to ISO strings at the db.ts boundary: postgres-js's raw text
 * form ("2026-09-10 21:07:00+00") is not safely `new Date()`-parseable in
 * every JS engine, while a Date round-trip is.
 *
 * Check constraints and indexes are deliberately omitted — they live in the
 * migrations and nothing here queries by them at the type level.
 */
import {
  boolean,
  date,
  integer,
  jsonb,
  numeric,
  pgSchema,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import type { Callout, Decision, ExecutionMode } from '../../shared/types.js';
import type { CalloutParseStatus } from '../db.js';
import type { RecapParse, RecapParseStatus } from '../recaps/parser.js';

const isoTimestamp = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const numericAsNumber = (name: string) => numeric(name, { mode: 'number' });
// Qualify every table. Supabase poolers often omit `public` from search_path,
// and Drizzle then reports only "Failed query" for a missing relation.
const publicTables = pgSchema('public');

// ---- Per-user -----------------------------------------------------------------

/**
 * Identity + resolved trade settings, one row per account. id/email are synced
 * from auth.users by the sync_user_from_auth trigger; the app writes only the
 * settings columns. Defaults mirror TradeSettingsSchema (shared/types.ts).
 */
export const users = publicTables.table('users', {
  id: uuid('id').primaryKey(),
  email: text('email').notNull(),
  executionMode: text('execution_mode').$type<ExecutionMode>().notNull().default('approval'),
  equitySmallPct: numericAsNumber('equity_small_pct').notNull().default(1.25),
  equityMediumPct: numericAsNumber('equity_medium_pct').notNull().default(2.5),
  equityFullPct: numericAsNumber('equity_full_pct').notNull().default(5),
  optionsSmallPct: numericAsNumber('options_small_pct').notNull().default(0.5),
  optionsMediumPct: numericAsNumber('options_medium_pct').notNull().default(1),
  optionsFullPct: numericAsNumber('options_full_pct').notNull().default(2),
  maxSingleContractPct: numericAsNumber('max_single_contract_pct').notNull().default(5),
  maxTradesPerDay: integer('max_trades_per_day').notNull().default(10),
  cooldownSeconds: numericAsNumber('cooldown_seconds').notNull().default(300),
  allowedTickers: text('allowed_tickers').array().notNull().default([]),
  blockedTickers: text('blocked_tickers').array().notNull().default([]),
  minConfidence: numericAsNumber('min_confidence').notNull().default(0.7),
  regularHoursOnly: boolean('regular_hours_only').notNull().default(true),
  /** Null = legacy "follow everyone"; [] = follow no one (the default). */
  followedCallerIds: text('followed_caller_ids').array().default([]),
  maxLossPct: numericAsNumber('max_loss_pct'),
  maxLossUsd: numericAsNumber('max_loss_usd'),
  updatedAt: isoTimestamp('updated_at').notNull().defaultNow(),
});

/** Per-user decision audit log; one row per callout per user. */
export const trades = publicTables.table('trades', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  messageId: text('message_id').notNull(),
  kind: text('kind').$type<Decision['kind']>().notNull(),
  code: text('code').$type<Decision['code']>(),
  reason: text('reason').notNull(),
  ticker: text('ticker'),
  action: text('action').$type<Decision['action']>(),
  orderPayload: jsonb('order_payload').$type<Decision['order']>(),
  approvedAt: isoTimestamp('approved_at'),
  timestamp: isoTimestamp('timestamp').notNull().defaultNow(),
});

/**
 * One Robinhood connection per user — user_id as pk is what enforces that
 * product rule. Ciphertext only (AES-256-GCM under RH_TOKENS_VAULT_KEY).
 */
export const brokerConnections = publicTables.table('broker_connections', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  encryptedTokens: text('encrypted_tokens').notNull(),
  updatedAt: isoTimestamp('updated_at').notNull().defaultNow(),
});

// ---- Shared data ----------------------------------------------------------------

/** Discord snapshot + cached LLM parse; also the ingest idempotency ledger. */
export const callouts = publicTables.table('callouts', {
  messageId: text('message_id').primaryKey(),
  channelId: text('channel_id').notNull(),
  channelName: text('channel_name'),
  /** Null only on rows written before Caller Following existed. */
  authorId: text('author_id'),
  authorName: text('author_name').notNull(),
  content: text('content').notNull(),
  timestamp: isoTimestamp('timestamp').notNull(),
  embeds: jsonb('embeds').$type<Record<string, unknown>[]>().notNull().default([]),
  parse: jsonb('parse').$type<Callout>(),
  parseStatus: text('parse_status').$type<CalloutParseStatus>().notNull().default('skipped'),
});

/** The Caller roster: one row per Discord author, upserted on ingest. */
export const callers = publicTables.table('callers', {
  authorId: text('author_id').primaryKey(),
  displayName: text('display_name').notNull(),
  avatarUrl: text('avatar_url'),
  lastSeenAt: isoTimestamp('last_seen_at').notNull(),
});

/** Raw daily-recap posts + cached parse (raw-first: content re-parses freely). */
export const recaps = publicTables.table('recaps', {
  messageId: text('message_id').primaryKey(),
  channelId: text('channel_id').notNull(),
  postedAt: isoTimestamp('posted_at').notNull(),
  /** ISO trading day from the recap header; null for non-recap channel posts. */
  recapDate: date('recap_date'),
  content: text('content').notNull(),
  contentHash: text('content_hash').notNull(),
  parse: jsonb('parse').$type<RecapParse>(),
  parseStatus: text('parse_status').$type<RecapParseStatus>().notNull(),
  parserVersion: integer('parser_version').notNull().default(0),
});

/** Cached LLM narration per recap window. */
export const recapInsights = publicTables.table('recap_insights', {
  windowDays: integer('window_days').primaryKey(),
  generatedAt: isoTimestamp('generated_at').notNull(),
  content: text('content').notNull(),
});

/** Invite-only signup gate; independent of the sign-in mechanism. */
export const allowedEmails = publicTables.table('allowed_emails', {
  email: text('email').primaryKey(),
  addedAt: isoTimestamp('added_at').notNull().defaultNow(),
});
