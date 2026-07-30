/**
 * Boot-time Caller data self-healing (docs/specs/0001-caller-following.md).
 *
 * Production runs on a Render free-tier container with no shell, so one-time
 * scripts can never run where the database credentials live. Instead the
 * trader heals its own Caller data on every boot, idempotently:
 *
 *   - seedMissingCallers: every DISCORD_ALLOWED_AUTHOR_IDS user without a
 *     `callers` row is fetched from Discord REST and inserted, so the
 *     Following picker is never empty. Insert-only — rows that exist (with
 *     names/avatars captured from live messages) are never overwritten.
 *   - backfillCalloutAuthors: `callouts` rows written before author capture
 *     existed carry a null author_id; re-read the same REST history that
 *     catch-up uses and fill them in by message id.
 */
import { config } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';
import { discordAvatarUrl, fetchTodaysCallouts } from './callouts.js';
import type { TraderDb } from './db.js';

const log = createLogger('trader:caller-bootstrap');

/** Subset of Discord's REST user object we consume. */
interface DiscordUser {
  readonly username: string;
  readonly global_name?: string | null;
  readonly avatar?: string | null;
}

/** Insert a `callers` row for every allowlisted author that has none. */
export async function seedMissingCallers(
  db: TraderDb,
  authorIds: readonly string[] = config.discordAllowedAuthorIds,
  fetchImpl: typeof fetch = fetch
): Promise<number> {
  const existing = new Set((await db.listCallers()).map((c) => c.authorId));
  const missing = authorIds.filter((id) => !existing.has(id));

  let seeded = 0;
  for (const authorId of missing) {
    const res = await fetchImpl(`https://discord.com/api/v10/users/${authorId}`, {
      headers: { authorization: `Bot ${config.discordBotToken}` },
    });
    if (!res.ok) {
      log.warn('could not fetch Discord user — skipped', { authorId, status: res.status });
      continue;
    }
    const user = (await res.json()) as DiscordUser;
    await db.upsertCaller({
      authorId,
      displayName: user.global_name ?? user.username,
      avatarUrl: discordAvatarUrl(authorId, user.avatar),
      lastSeenAt: new Date().toISOString(),
    });
    seeded += 1;
  }
  if (missing.length > 0) {
    log.info('seeded missing callers', { seeded, missing: missing.length });
  }
  return seeded;
}

/** Fill in author_id on legacy callout rows by re-reading Discord history. */
export async function backfillCalloutAuthors(
  db: TraderDb,
  fetchHistory: typeof fetchTodaysCallouts = fetchTodaysCallouts
): Promise<number> {
  const rows = await db.listCalloutsMissingAuthor();
  if (rows.length === 0) return 0;

  // Page history back to the oldest null-author row. The window is bounded by
  // the table's own contents, and rows history no longer covers simply stay
  // null (the feed tolerates that; they age out of the feed window anyway).
  const oldest = rows.reduce((a, b) => (a.timestamp < b.timestamp ? a : b));
  const history = await fetchHistory(fetch, new Date(Date.parse(oldest.timestamp)));
  const authorByMessage = new Map(history.map((m) => [m.messageId, m.authorId]));

  let updated = 0;
  for (const row of rows) {
    const authorId = authorByMessage.get(row.messageId);
    if (!authorId) continue;
    await db.setCalloutAuthor(row.messageId, authorId);
    updated += 1;
  }
  log.info('backfilled callout authors', { updated, stillNull: rows.length - updated });
  return updated;
}
