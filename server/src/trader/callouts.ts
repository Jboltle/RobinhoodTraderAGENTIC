/**
 * Today's Discord callout history for the dashboard feed — "Discord acts as
 * the database". Fetches message history for every allowlisted channel via the
 * Discord REST API and mirrors the bot's filter/flatten semantics
 * (messageFilter.ts / messageAssembly.ts).
 *
 * SAFETY: display-only read path. Nothing here builds envelopes or calls
 * parse/risk/execute — history must never enter the trade pipeline.
 *
 * ponytail: the trader calling Discord REST directly is a deliberate boundary
 * shortcut — message history needs no gateway connection, and a bot→trader
 * backfill hop just for display isn't worth it. Upgrade path: move history
 * into the bot service if it ever needs gateway state.
 */

import { config, isAllowed } from '../shared/config.js';
import { flattenEmbedText, type EmbedLike } from '../shared/embedText.js';
import { createLogger } from '../shared/logger.js';
import type { Decision, DecisionKind } from '../shared/types.js';

const log = createLogger('trader:callouts');

const DISCORD_API = 'https://discord.com/api/v10';
const PAGE_SIZE = 100;
const CACHE_TTL_MS = 60_000;
const FAILURE_COOLDOWN_MS = 30_000;
/** Discord message types the bot treats as non-system: DEFAULT and REPLY. */
const USER_MESSAGE_TYPES = new Set([0, 19]);

/** Subset of Discord's REST message object we consume. */
export interface RestMessage {
  readonly id: string;
  readonly channel_id: string;
  readonly type: number;
  readonly content: string;
  readonly timestamp: string;
  readonly author: { readonly id: string; readonly username: string; readonly global_name?: string | null };
  readonly attachments?: readonly { readonly url: string }[];
  readonly embeds?: readonly (EmbedLike & Record<string, unknown>)[];
  readonly sticker_items?: readonly { readonly name: string }[];
}

/** One feed item; `decision` is null when the message was never processed. */
export interface CalloutItem {
  readonly messageId: string;
  readonly channelId: string;
  readonly channelName: string | null;
  readonly authorName: string;
  readonly timestamp: string;
  readonly content: string;
  readonly embeds: readonly Record<string, unknown>[];
  readonly decision: { readonly kind: DecisionKind; readonly reason: string; readonly at: string } | null;
}

export type CalloutMessage = Omit<CalloutItem, 'decision'>;

/** Local midnight (server timezone) — the feed's "today" boundary. */
export function localMidnight(now: Date = new Date()): Date {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return midnight;
}

/**
 * Flatten a REST message the same way the bot's buildMessageContent flattens a
 * gateway message: body + sticker names + attachment URLs + flattened embeds.
 * ponytail: skips the bot's reply-context prefix (needs an extra fetch per
 * reply); the raw embeds are returned alongside for rendering anyway.
 */
export function flattenRestMessage(msg: RestMessage): string {
  let body = (msg.content ?? '').trim();

  if (msg.sticker_items?.length) {
    const names = msg.sticker_items.map((s) => `:${s.name}:`).join(' ');
    body = (body ? body + '\n' : '') + `🏷️ sticker: ${names}`;
  }

  if (msg.attachments?.length) {
    const urls = msg.attachments.map((a) => a.url).join('\n');
    body = (body ? body + '\n' : '') + urls;
  }

  if (msg.embeds?.length) {
    const embedText = msg.embeds.map(flattenEmbedText).filter(Boolean).join('\n---\n');
    if (embedText) body = (body ? body + '\n' : '') + embedText;
  }

  return body;
}

/**
 * Mirror of the bot's classifyMessage for REST payloads: non-system message,
 * allowlisted author, non-empty flattened content. The channel gate is
 * satisfied by construction (we only fetch allowlisted channels).
 */
export function isDisplayableCallout(
  msg: RestMessage,
  authorAllowlist: readonly string[]
): boolean {
  if (!USER_MESSAGE_TYPES.has(msg.type)) return false;
  if (!isAllowed(msg.author.id, authorAllowlist)) return false;
  return flattenRestMessage(msg).trim().length > 0;
}

/** Attach each message's pipeline outcome from the decision log, joined on Discord message id. */
export function joinDecisions(
  messages: readonly CalloutMessage[],
  decisions: readonly Decision[]
): CalloutItem[] {
  const byMessageId = new Map<string, Decision>();
  for (const decision of decisions) byMessageId.set(decision.envelope.messageId, decision);
  return messages.map((message) => {
    const decision = byMessageId.get(message.messageId);
    return {
      ...message,
      decision: decision
        ? { kind: decision.kind, reason: decision.reason, at: decision.at }
        : null,
    };
  });
}

/**
 * Paginate a channel's message history (newest-first, 100/page) back to
 * `since`. Returns only messages with timestamp >= since.
 */
export async function fetchChannelMessagesSince(
  channelId: string,
  since: Date,
  fetchImpl: typeof fetch = fetch
): Promise<RestMessage[]> {
  const sinceMs = since.getTime();
  const messages: RestMessage[] = [];
  let before: string | undefined;

  for (;;) {
    const url = new URL(`${DISCORD_API}/channels/${channelId}/messages`);
    url.searchParams.set('limit', String(PAGE_SIZE));
    if (before) url.searchParams.set('before', before);

    const page = (await discordGet(url, fetchImpl)) as RestMessage[];
    if (page.length === 0) break;

    for (const msg of page) {
      if (Date.parse(msg.timestamp) >= sinceMs) messages.push(msg);
    }

    const oldest = page[page.length - 1]!;
    if (Date.parse(oldest.timestamp) < sinceMs || page.length < PAGE_SIZE) break;
    before = oldest.id;
  }

  return messages;
}

async function discordGet(url: URL, fetchImpl: typeof fetch): Promise<unknown> {
  // ponytail: single retry on 429 — sequential per-channel fetches rarely hit
  // rate limits; upgrade path is a proper bucket-aware limiter.
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(url, {
      headers: { authorization: `Bot ${config.discordBotToken}` },
    });
    if (res.status === 429 && attempt === 0) {
      const body = (await res.json().catch(() => ({}))) as { retry_after?: number };
      await new Promise((r) => setTimeout(r, (body.retry_after ?? 1) * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`discord GET ${url.pathname} failed: ${res.status}`);
    return res.json();
  }
}

export interface CalloutHistory {
  /**
   * Today's displayable callouts across all allowlisted channels, newest-first.
   * Cached ~60s; on Discord failure serves the last successful result (stale)
   * and backs off for 30s. Throws only when no fetch has ever succeeded.
   */
  getToday(): Promise<CalloutMessage[]>;
}

export function createCalloutHistory(fetchImpl: typeof fetch = fetch): CalloutHistory {
  let cache: { at: number; messages: CalloutMessage[] } | null = null;
  let lastFailure: { at: number; error: Error } | null = null;
  // Channel names change rarely; cache them for the process lifetime.
  const channelNames = new Map<string, string | null>();

  const channelName = async (channelId: string): Promise<string | null> => {
    if (!channelNames.has(channelId)) {
      try {
        const channel = (await discordGet(
          new URL(`${DISCORD_API}/channels/${channelId}`),
          fetchImpl
        )) as { name?: string };
        channelNames.set(channelId, channel.name ?? null);
      } catch (err) {
        log.warn('failed to fetch channel name', { channelId, error: (err as Error).message });
        channelNames.set(channelId, null);
      }
    }
    return channelNames.get(channelId) ?? null;
  };

  return {
    async getToday(): Promise<CalloutMessage[]> {
      if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.messages;

      // ponytail: naive fixed cooldown after a failed fetch, not a bucket-aware
      // limiter; upgrade path is honoring Discord rate-limit headers here.
      if (lastFailure && Date.now() - lastFailure.at < FAILURE_COOLDOWN_MS) {
        if (cache) return cache.messages;
        throw lastFailure.error;
      }

      try {
        const since = localMidnight();
        const messages: CalloutMessage[] = [];
        for (const channelId of config.discordAllowedChannelIds) {
          const name = await channelName(channelId);
          const raw = await fetchChannelMessagesSince(channelId, since, fetchImpl);
          for (const msg of raw) {
            if (!isDisplayableCallout(msg, config.discordAllowedAuthorIds)) continue;
            messages.push({
              messageId: msg.id,
              channelId: msg.channel_id,
              channelName: name,
              authorName: msg.author.global_name ?? msg.author.username,
              timestamp: msg.timestamp,
              content: flattenRestMessage(msg),
              embeds: msg.embeds ?? [],
            });
          }
        }
        messages.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));

        cache = { at: Date.now(), messages };
        lastFailure = null;
        return messages;
      } catch (err) {
        lastFailure = { at: Date.now(), error: err as Error };
        if (cache) {
          log.warn('serving stale callouts; discord unavailable', {
            error: (err as Error).message,
          });
          return cache.messages;
        }
        throw err;
      }
    },
  };
}
