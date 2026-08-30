/**
 * Recap channel ingestion.
 *
 * Three paths converge on the same idempotent upsert:
 *   live    — the bot forwards kind:'recap' envelopes (webhook in server.ts)
 *   sweep   — hourly weekday REST sweep: fetches anything newer than the
 *             latest stored post, re-scans the last few days so edited recaps
 *             (services fix their numbers) are caught via content-hash drift,
 *             and re-parses rows whose cached parse predates PARSER_VERSION
 *   backfill— first run with an empty table reaches back a full year
 *
 * Raw content is the source of truth; the parse is recomputed from it any
 * time the hash or parser version moves. Nothing here can reach the trade
 * pipeline — recaps only ever land in the `recaps` table.
 */
import { createHash } from 'node:crypto';

import { config } from '../../shared/config.js';
import { createLogger } from '../../shared/logger.js';
import type { DiscordEnvelope } from '../../shared/types.js';
import { fetchChannelMessagesSince, flattenRestMessage, USER_MESSAGE_TYPES } from '../callouts.js';
import type { StoredRecap, TraderDb } from '../db.js';
import { DEFAULT_RECAP_WINDOW_DAYS } from './analytics.js';
import { refreshRecapInsights } from './insights.js';
import { PARSER_VERSION, isDailyRecap, parseRecap } from './parser.js';

const log = createLogger('trader:recaps');

/** Users can reference up to a year of history; the windows filter at query time. */
export const RECAP_BACKFILL_DAYS = 365;
/** Recent slice re-fetched every sweep so post-hoc edits get re-parsed. */
const EDIT_RESCAN_DAYS = 7;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RecapSweepSummary {
  readonly fetched: number;
  readonly inserted: number;
  readonly updated: number;
  readonly reparsed: number;
  readonly changed: boolean;
}

/** Hash + parse a raw recap-channel message into its storable row. */
export function buildStoredRecap(input: {
  readonly messageId: string;
  readonly channelId: string;
  readonly postedAt: string;
  readonly content: string;
}): StoredRecap {
  const { status, parse } = parseRecap(input.content);
  return {
    ...input,
    recapDate: resolveRecapDate(parse?.recapDate ?? null, input.content, input.postedAt),
    contentHash: sha256(input.content),
    parse,
    parseStatus: status,
    parserVersion: PARSER_VERSION,
  };
}

/**
 * Live-ingest a kind:'recap' envelope. Returns true when the stored row
 * changed (new post, edited content, or newer parser) so the caller knows to
 * refresh the cached insights.
 */
export async function ingestRecapEnvelope(
  db: TraderDb,
  envelope: DiscordEnvelope
): Promise<boolean> {
  const recap = buildStoredRecap({
    messageId: envelope.messageId,
    channelId: envelope.channelId,
    postedAt: envelope.timestamp,
    content: envelope.content,
  });

  const existing = (await db.listRecapMetas([envelope.messageId])).get(envelope.messageId);
  if (
    existing &&
    existing.contentHash === recap.contentHash &&
    existing.parserVersion === PARSER_VERSION
  ) {
    return false;
  }

  await db.saveRecap(recap);
  log.info('recap stored', {
    messageId: recap.messageId,
    recapDate: recap.recapDate,
    parseStatus: recap.parseStatus,
    trades: recap.parse?.trades.length ?? 0,
  });
  return true;
}

export async function runRecapSweep(
  db: TraderDb,
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date()
): Promise<RecapSweepSummary> {
  let fetched = 0;
  let inserted = 0;
  let updated = 0;
  let reparsed = 0;

  // Empty table: reach back the full backfill horizon. Otherwise fetch from
  // the older of (latest stored post, edit-rescan start) so both gaps from
  // downtime and recent edits are covered by one window.
  // ponytail: latest-post watermark is global, not per channel — a channel
  // added later to DISCORD_RECAP_CHANNEL_IDS won't deep-backfill. Upgrade
  // path: per-channel watermarks.
  const latest = await db.latestRecapPostedAt();
  const since =
    latest === null
      ? new Date(now.getTime() - RECAP_BACKFILL_DAYS * DAY_MS)
      : new Date(Math.min(Date.parse(latest), now.getTime() - EDIT_RESCAN_DAYS * DAY_MS));

  for (const channelId of config.discordRecapChannelIds) {
    const messages = (await fetchChannelMessagesSince(channelId, since, fetchImpl)).filter((msg) =>
      USER_MESSAGE_TYPES.has(msg.type)
    );
    fetched += messages.length;

    const metas = await db.listRecapMetas(messages.map((msg) => msg.id));
    for (const msg of messages) {
      const content = flattenRestMessage(msg);
      if (!content.trim()) continue;

      const existing = metas.get(msg.id);
      // Cheap skip before parsing: unchanged content under the current parser
      // needs no write. Stale-parser rows are handled in the re-parse pass.
      if (existing && existing.contentHash === sha256(content)) continue;

      await db.saveRecap(
        buildStoredRecap({
          messageId: msg.id,
          channelId: msg.channel_id,
          postedAt: msg.timestamp,
          content,
        })
      );
      if (existing) updated += 1;
      else inserted += 1;
    }
  }

  // Format drift recovery: parser updated -> version bumped -> every stored
  // row below it re-parses from raw content. No Discord traffic involved.
  for (const row of await db.listRecapsWithStaleParse(PARSER_VERSION)) {
    await db.saveRecap(
      buildStoredRecap({
        messageId: row.messageId,
        channelId: row.channelId,
        postedAt: row.postedAt,
        content: row.content,
      })
    );
    reparsed += 1;
  }

  return { fetched, inserted, updated, reparsed, changed: inserted + updated + reparsed > 0 };
}

/**
 * Boot sweep (backfill / catch-up) plus an hourly weekday interval. Recaps
 * post Mon–Fri evenings; weekend runs would be pure no-op REST calls. Insight
 * refresh piggybacks on sweeps that changed rows.
 */
export function startRecapScheduler(db: TraderDb): void {
  if (config.discordRecapChannelIds.length === 0) {
    log.info('no recap channels configured; recap sweep disabled');
    return;
  }

  const run = async (trigger: string): Promise<void> => {
    const summary = await runRecapSweep(db);
    log.info('recap sweep complete', { trigger, ...summary });
    // Also regenerate when rows exist but narration doesn't (first deploy).
    const needsInsight =
      summary.changed || (await db.getRecapInsight(DEFAULT_RECAP_WINDOW_DAYS)) === null;
    if (needsInsight) await refreshRecapInsights(db);
  };

  const safeRun = (trigger: string): void => {
    void run(trigger).catch((err: unknown) =>
      log.error('recap sweep failed', { trigger, error: (err as Error).message })
    );
  };

  safeRun('boot');
  const timer = setInterval(() => {
    const day = new Date().getDay();
    if (day === 0 || day === 6) return;
    safeRun('interval');
  }, SWEEP_INTERVAL_MS);
  timer.unref();
}

/**
 * The header date is authoritative. When a real recap arrives with a mangled
 * header, fall back to the post time shifted into US Eastern: recaps go out
 * in the evening, and the raw UTC date would name the next trading day.
 * ponytail: fixed -5h offset ignores DST — off by an hour during EDT, never
 * by a day for evening posts.
 */
function resolveRecapDate(
  headerDate: string | null,
  content: string,
  postedAt: string
): string | null {
  if (headerDate) return headerDate;
  if (!isDailyRecap(content)) return null;
  return new Date(Date.parse(postedAt) - 5 * 3600_000).toISOString().slice(0, 10);
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
