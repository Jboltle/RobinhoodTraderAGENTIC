/**
 * Catch-up-on-wake.
 *
 * The bot holds a Discord Gateway socket, so while the process is asleep
 * callouts are simply never delivered. On startup we re-read today's history
 * and process anything the `callouts` table has never seen.
 *
 * Age is the thing that decides what happens next. A callout from twenty
 * seconds ago is still tradable; one from an hour ago is a different trade at
 * a different price, and filling it now is how you lose money. Anything past
 * the staleness window is therefore recorded as missed and never sent to a
 * broker.
 */
import { createLogger } from '../shared/logger.js';
import { fetchTodaysCallouts, type CalloutMessage } from './callouts.js';
import type { TraderDb } from './db.js';
import type { MessageProcessor } from './pipeline/index.js';
import type { DiscordEnvelope } from '../shared/types.js';

const log = createLogger('trader:catchup');

/** Past this age a missed callout is recorded, not executed. */
export const STALENESS_WINDOW_MS = 2 * 60 * 1000;

export interface CatchUpDeps {
  readonly db: TraderDb;
  readonly processor: MessageProcessor;
  readonly fetchHistory?: typeof fetchTodaysCallouts;
}

export interface CatchUpSummary {
  readonly processed: number;
  readonly missed: number;
  readonly alreadySeen: number;
}

export async function catchUpOnWake(
  deps: CatchUpDeps,
  now: Date = new Date()
): Promise<CatchUpSummary> {
  const fetchHistory = deps.fetchHistory ?? fetchTodaysCallouts;
  const messages = await fetchHistory();

  let processed = 0;
  let missed = 0;
  let alreadySeen = 0;

  // Oldest-first and sequential: the callouts table is the idempotency ledger,
  // and a later message may depend on an earlier one having been acted on
  // (an exit after its entry).
  for (const message of messages) {
    if (await deps.db.getCallout(message.messageId)) {
      alreadySeen += 1;
      continue;
    }

    const stale = now.getTime() - Date.parse(message.timestamp) > STALENESS_WINDOW_MS;
    await deps.processor.process(toEnvelope(message), {
      channelName: message.channelName,
      missed: stale,
    });
    if (stale) missed += 1;
    else processed += 1;
  }

  log.info('catch-up complete', { processed, missed, alreadySeen });
  return { processed, missed, alreadySeen };
}

const toEnvelope = (message: CalloutMessage): DiscordEnvelope => ({
  messageId: message.messageId,
  channelId: message.channelId,
  guildId: null,
  authorId: message.authorId,
  authorName: message.authorName,
  authorAvatarUrl: message.authorAvatarUrl,
  content: message.content,
  timestamp: message.timestamp,
  embeds: [...message.embeds],
});
