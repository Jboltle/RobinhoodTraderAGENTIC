/**
 * One-time Caller roster seed (docs/specs/0001-caller-following.md).
 *
 *   bun run seed:callers
 *
 * Fetches every DISCORD_ALLOWED_AUTHOR_IDS user from Discord REST and upserts
 * their `callers` row, so the Following picker is not empty before the first
 * ingested callout. Rerunnable, with a caveat: a rerun overwrites
 * `display_name` and `last_seen_at` captured from live messages with REST values.
 */
import { config } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';
import { discordAvatarUrl } from '../trader/callouts.js';
import { createTraderDb } from '../trader/db.js';

const log = createLogger('seed-callers');

/** Subset of Discord's REST user object we consume. */
interface DiscordUser {
  readonly id: string;
  readonly username: string;
  readonly global_name?: string | null;
  readonly avatar?: string | null;
}

async function main(): Promise<void> {
  if (config.discordAllowedAuthorIds.length === 0) {
    log.info('DISCORD_ALLOWED_AUTHOR_IDS is empty — nothing to seed');
    return;
  }

  const db = createTraderDb();
  for (const authorId of config.discordAllowedAuthorIds) {
    const res = await fetch(`https://discord.com/api/v10/users/${authorId}`, {
      headers: { authorization: `Bot ${config.discordBotToken}` },
    });
    if (!res.ok) {
      log.warn('could not fetch Discord user — skipped', { authorId, status: res.status });
      continue;
    }
    const user = (await res.json()) as DiscordUser;
    const displayName = user.global_name ?? user.username;
    await db.upsertCaller({
      authorId,
      displayName,
      avatarUrl: discordAvatarUrl(authorId, user.avatar),
      lastSeenAt: new Date().toISOString(),
    });
    log.info('seeded caller', { authorId, displayName });
  }
  log.info('done');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    log.error('seed failed', { error: (err as Error).message });
    process.exit(1);
  });
