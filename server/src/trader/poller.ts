/**
 * The consumer loop: drains unprocessed `messages` rows into the pipeline.
 *
 * The Listener (server/listener) writes raw rows; this poller is the only
 * thing that reads them forward. One query is the whole transport AND the
 * catch-up mechanism — on boot it naturally drains whatever accumulated while
 * the trader slept, so there is no separate replay path any more.
 *
 * Rows are handled oldest-first and sequentially: a later message may depend
 * on an earlier one having been acted on (an exit after its entry).
 *
 * Two-phase marking, deliberately:
 *   1. resolveCallout (inside processor.process) writes disposition + parse.
 *   2. This loop writes processed_at only after process() fully returns,
 *      fan-out included.
 * A crash between the two leaves disposition set with processed_at null; the
 * guard below then finishes the mark WITHOUT re-running the fan-out, because
 * re-running it is the one path to a double trade. The cost is the same as
 * today's crash mode: some users may lack a decision row for that message.
 *
 * Multiple instances: every row is claimed (claimMessage, an atomic
 * conditional UPDATE) before anything else happens to it, so when two trader
 * processes poll the same database — a local run next to the deployed one, or
 * containers overlapping during a redeploy — exactly one fans each message
 * out. Without it both did, and every user got two outcomes (and potentially
 * two orders) per callout. A claim held past CLAIM_STALE_MS by an instance
 * that never finished is treated as abandoned; by then the message is past
 * the staleness window, so the re-claimer records it as missed, never trades.
 * LISTEN/NOTIFY is the upgrade path if sub-second reaction ever matters.
 */
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

import { config } from '../shared/config.js';
import { createLogger, errorFields } from '../shared/logger.js';
import type { DiscordEnvelope } from '../shared/types.js';
import type { PendingMessage, TraderDb } from './db.js';
import type { MessageProcessor } from './pipeline/index.js';
import { refreshRecapInsights } from './recaps/insights.js';
import { ingestRecapEnvelope } from './recaps/sweep.js';

const log = createLogger('trader:poller');

export const POLL_INTERVAL_MS = 1000;
/** Per-tick cap; a deep backlog drains across consecutive ticks. */
export const POLL_BATCH_SIZE = 50;
/** Past this age a missed callout is recorded, not executed. */
export const STALENESS_WINDOW_MS = 2 * 60 * 1000;
/** A claim older than this with the row still unprocessed is abandoned. */
export const CLAIM_STALE_MS = 10 * 60 * 1000;
/** Rate limit for the "another instance is consuming messages" warning. */
const RIVAL_WARN_INTERVAL_MS = 10 * 60 * 1000;

/** This process's identity on claimed rows: host:pid:random. */
export const INSTANCE_ID = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

export interface PollerDeps {
  readonly db: TraderDb;
  readonly processor: MessageProcessor;
  /** Defaults to config; injected in tests. */
  readonly recapChannelIds?: readonly string[];
  readonly now?: () => Date;
  /** Defaults to INSTANCE_ID; injected in tests. */
  readonly instanceId?: string;
}

let lastRivalWarnAt = 0;

/** The envelope the pipeline expects, synthesized from a stored row. */
export function buildEnvelope(row: PendingMessage): DiscordEnvelope {
  return {
    messageId: row.messageId,
    channelId: row.channelId,
    channelName: row.channelName,
    guildId: null,
    authorId: row.authorId,
    authorName: row.authorName,
    authorAvatarUrl: row.authorAvatarUrl,
    content: row.content,
    timestamp: row.sentAt,
    embeds: [...row.embeds],
  };
}

/**
 * One sweep: fetch and handle up to POLL_BATCH_SIZE rows. Returns how many
 * were handled. A row failure aborts the rest of the tick — the row stays
 * unprocessed and the next tick retries, which is the right behavior for
 * transient DB trouble and cannot loop hot (one attempt per interval).
 */
export async function drainOnce(deps: PollerDeps): Promise<number> {
  const rows = await deps.db.listUnprocessedMessages(POLL_BATCH_SIZE);
  let handled = 0;
  for (const row of rows) {
    await handleRow(deps, row);
    handled += 1;
  }
  return handled;
}

async function handleRow(deps: PollerDeps, row: PendingMessage): Promise<void> {
  const recapChannels = deps.recapChannelIds ?? config.discordRecapChannelIds;
  const now = deps.now?.() ?? new Date();
  const instanceId = deps.instanceId ?? INSTANCE_ID;

  // Ownership first: a row another live instance claimed is theirs to fan
  // out and mark. Skipping it — not marking it — is what keeps one message to
  // one outcome per user when two traders share a database.
  const staleBefore = new Date(now.getTime() - CLAIM_STALE_MS);
  if (!(await deps.db.claimMessage(row.messageId, instanceId, staleBefore))) {
    await warnRivalInstance(deps, row.messageId, now);
    return;
  }

  // Crash-replay guard: a verdict without a processed mark means the previous
  // run died mid fan-out. Finish the mark; never re-fan-out (double trades).
  // Exception: recap rows re-enter deliberately (the Listener resets them on
  // edit) and the content-hash dedupe inside the recap ingest makes that safe.
  if (row.disposition !== null && row.disposition !== 'recap') {
    log.warn('finishing interrupted row without re-running fan-out', {
      messageId: row.messageId,
      disposition: row.disposition,
    });
    await deps.db.markMessageProcessed(row.messageId);
    return;
  }

  if (recapChannels.includes(row.channelId)) {
    const changed = await ingestRecapEnvelope(deps.db, buildEnvelope(row));
    if (changed) await refreshRecapInsights(deps.db);
    await deps.db.setMessageDisposition(row.messageId, 'recap', null);
    await deps.db.markMessageProcessed(row.messageId);
    return;
  }

  // Retracted before we got to it: archive-only. The deleted alert stays a
  // signal in the feed, but nothing deleted is ever traded or parsed, and a
  // per-user "missed" fan-out for a message that no longer exists is noise.
  if (row.deletedAt !== null) {
    await deps.db.setMessageDisposition(row.messageId, 'missed', null);
    await deps.db.markMessageProcessed(row.messageId);
    return;
  }

  const stale = now.getTime() - Date.parse(row.sentAt) > STALENESS_WINDOW_MS;
  await deps.processor.process(buildEnvelope(row), { missed: stale });
  await deps.db.markMessageProcessed(row.messageId);
}

/**
 * A lost claim means a second trader is consuming this database. That is the
 * root of duplicate outcomes and of one instance stuck "not connected" (the
 * two fight over Robinhood's rotating refresh token), so say so — at most
 * once per interval.
 */
async function warnRivalInstance(deps: PollerDeps, messageId: string, now: Date): Promise<void> {
  if (now.getTime() - lastRivalWarnAt < RIVAL_WARN_INTERVAL_MS) return;
  lastRivalWarnAt = now.getTime();
  const claimant = await deps.db.getMessageClaimant(messageId).catch(() => null);
  log.warn('another trader instance is consuming messages — run only one per database', {
    messageId,
    claimedBy: claimant,
    instanceId: deps.instanceId ?? INSTANCE_ID,
  });
}

/** Start the loop (immediate first drain = boot catch-up). Returns a stopper. */
export function startPoller(deps: PollerDeps): () => void {
  let draining = false;

  const tick = (): void => {
    if (draining) return; // a slow batch must not overlap the next interval
    draining = true;
    void drainOnce(deps)
      .then((handled) => {
        if (handled > 0) log.info('drained messages', { handled });
      })
      .catch((err: unknown) => log.error('drain failed', errorFields(err)))
      .finally(() => {
        draining = false;
      });
  };

  tick();
  const timer = setInterval(tick, POLL_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
