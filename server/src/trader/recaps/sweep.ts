/**
 * Recap ingestion.
 *
 * Two paths converge on the same idempotent upsert:
 *   live     — the poller routes recap-channel `messages` rows here. Edited
 *              recaps (services fix their numbers) re-enter because the
 *              Listener resets the row's processing marks on edit, and the
 *              content-hash check below makes the replay a no-op when nothing
 *              actually changed.
 *   reparse  — boot-time pass: parser updated -> PARSER_VERSION bumped ->
 *              every stored row below it re-parses from raw content. No
 *              Discord traffic involved.
 *
 * Raw content is the source of truth; the parse is recomputed from it any
 * time the hash or parser version moves. Nothing here can reach the trade
 * pipeline — recaps only ever land in the `recaps` table.
 */
import { createHash } from 'node:crypto';

import { flattenEnvelope } from '../../shared/embedText.js';
import { createLogger } from '../../shared/logger.js';
import type { DiscordEnvelope } from '../../shared/types.js';
import type { StoredRecap, TraderDb } from '../db.js';
import { DEFAULT_RECAP_WINDOW_DAYS } from './analytics.js';
import { refreshRecapInsights } from './insights.js';
import { PARSER_VERSION, isDailyRecap, parseRecap } from './parser.js';

const log = createLogger('trader:recaps');

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
 * Ingest a recap-channel envelope. Returns true when the stored row changed
 * (new post, edited content, or newer parser) so the caller knows to refresh
 * the cached insights.
 */
export async function ingestRecapEnvelope(
  db: TraderDb,
  rawEnvelope: DiscordEnvelope
): Promise<boolean> {
  // The one flatten site on the recap path: recap posts are often embed-only
  // cards, and `messages` rows carry raw parts.
  const envelope = flattenEnvelope(rawEnvelope);
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

/**
 * Format drift recovery, run once at trader boot: re-parse every stored row
 * whose cached parse predates PARSER_VERSION, then refresh the cached
 * narration when anything moved (or when it has never been generated).
 */
export async function reparseStaleRecaps(db: TraderDb): Promise<number> {
  let reparsed = 0;
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

  const needsInsight =
    reparsed > 0 || (await db.getRecapInsight(DEFAULT_RECAP_WINDOW_DAYS)) === null;
  if (needsInsight) await refreshRecapInsights(db);

  if (reparsed > 0) log.info('re-parsed stale recaps', { reparsed });
  return reparsed;
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
