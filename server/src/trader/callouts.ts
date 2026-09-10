/**
 * Today's Discord callout history, read over the REST API.
 *
 * This used to backfill the dashboard feed; the feed now reads the `callouts`
 * table, and the only caller left is catch-up-on-wake (catchup.ts), which
 * needs to know what was posted while the process was asleep. It mirrors the
 * bot's filter/flatten semantics (messageFilter.ts / messageAssembly.ts) so a
 * catch-up message is shaped exactly like a live one.
 *
 * ponytail: the trader calling Discord REST directly is a deliberate boundary
 * shortcut — message history needs no gateway connection, and a bot→trader
 * hop for it isn't worth it. Upgrade path: move history into the bot service
 * if it ever needs gateway state.
 */

import { config, isAllowed } from '../shared/config.js';
import {
  assembleMessageText,
  flattenEmbedText,
  type EmbedLike,
} from '../shared/embedText.js';
import { createLogger } from '../shared/logger.js';
import type { DiscordEnvelope } from '../shared/types.js';
import type { TraderDb } from './db.js';
import { startOfDay } from './pipeline/riskFilter.js';

const log = createLogger('trader:callouts');

const DISCORD_API = 'https://discord.com/api/v10';
const PAGE_SIZE = 100;
/** Discord message types the bot treats as non-system: DEFAULT and REPLY. */
export const USER_MESSAGE_TYPES = new Set([0, 19]);

/** Subset of Discord's REST message object we consume. */
export interface RestMessage {
  readonly id: string;
  readonly channel_id: string;
  readonly type: number;
  readonly content: string;
  readonly timestamp: string;
  readonly author: {
    readonly id: string;
    readonly username: string;
    readonly global_name?: string | null;
    readonly avatar?: string | null;
  };
  readonly attachments?: readonly { readonly url: string }[];
  readonly embeds?: readonly (EmbedLike & Record<string, unknown>)[];
  readonly sticker_items?: readonly { readonly name: string }[];
}

/**
 * Public CDN avatar URL for a Discord user: custom avatar when a hash is
 * known, otherwise Discord's id-derived default avatar (every user has one).
 */
export function discordAvatarUrl(userId: string, avatarHash?: string | null): string {
  if (avatarHash) return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.png`;
  // The default-avatar index derives from the numeric snowflake; a
  // non-numeric id (malformed input) just gets index 0 instead of a throw.
  const index = /^\d+$/.test(userId) ? (BigInt(userId) >> 22n) % 6n : 0n;
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

/**
 * Flatten a REST message the same way the bot's buildMessageContent flattens a
 * gateway message: body + sticker names + attachment URLs + flattened embeds.
 * ponytail: skips the bot's reply-context prefix (needs an extra fetch per
 * reply); the raw embeds are returned alongside for rendering anyway.
 */
export function flattenRestMessage(msg: RestMessage): string {
  return assembleMessageText({
    body: msg.content ?? '',
    stickerNames: (msg.sticker_items ?? []).map((s) => s.name),
    attachmentUrls: (msg.attachments ?? []).map((a) => a.url),
    embeds: msg.embeds ?? [],
  });
}

/** Header the bot prepends in buildMirrorPayload (bot/messageAssembly.ts). */
const MIRROR_HEADER_RE =
  /^From: (.+) \((\d+)\)\nSource channel: (\d+)\nMessage ID: (\d+)\n?\n?/;

/**
 * Parse a funnel-channel mirror post (buildMirrorPayload in
 * bot/messageAssembly.ts) back into a DiscordEnvelope. Returns null for
 * anything without the mirror header (humans chatting in the funnel,
 * receipts, ...) — header-parse success is the gate: the bot only mirrors
 * already-allowlisted callouts, so no author filtering is needed.
 */
export function parseMirrorMessage(msg: RestMessage): DiscordEnvelope | null {
  const match = MIRROR_HEADER_RE.exec(msg.content ?? '');
  if (!match) return null;

  let content = msg.content.slice(match[0].length);
  if (msg.embeds?.length) {
    const embedText = msg.embeds.map(flattenEmbedText).filter(Boolean).join('\n---\n');
    if (embedText) content = (content ? content + '\n' : '') + embedText;
  }

  return {
    // The ORIGINAL message id from the header — the callouts table is keyed on
    // it, not on the mirror post's own id.
    messageId: match[4]!,
    channelId: match[3]!,
    channelName: null, // resolved by the caller via the cached channel-name lookup
    guildId: null,
    authorId: match[2]!,
    authorName: match[1]!,
    // The mirror header carries no avatar hash; the id-derived default is the
    // best available. The next live message's upsert restores a custom one.
    authorAvatarUrl: discordAvatarUrl(match[2]!),
    // The mirror post's own timestamp — the original's isn't in the header;
    // close enough for ordering and for the staleness window.
    timestamp: msg.timestamp,
    content,
    embeds: [...(msg.embeds ?? [])],
  };
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

/**
 * Today's callouts, oldest-first so catch-up replays them in the order they
 * were posted. Reads the funnel channel when `discordForwardChannelId` is set
 * — the bot mirrors every allowed callout there, so that is one history call
 * instead of N (avoids 429s, and 404s from private channels in the allowlist).
 */
export async function fetchTodaysCallouts(
  fetchImpl: typeof fetch = fetch,
  since: Date = startOfDay()
): Promise<DiscordEnvelope[]> {
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

  const messages: DiscordEnvelope[] = [];

  if (config.discordForwardChannelId) {
    const raw = await fetchChannelMessagesSince(config.discordForwardChannelId, since, fetchImpl);
    for (const msg of raw) {
      const parsed = parseMirrorMessage(msg);
      if (!parsed) continue;
      messages.push({ ...parsed, channelName: await channelName(parsed.channelId) });
    }
  } else {
    for (const channelId of config.discordAllowedChannelIds) {
      const name = await channelName(channelId);
      const raw = await fetchChannelMessagesSince(channelId, since, fetchImpl);
      for (const msg of raw) {
        if (!isDisplayableCallout(msg, config.discordAllowedAuthorIds)) continue;
        messages.push({
          messageId: msg.id,
          channelId: msg.channel_id,
          channelName: name,
          guildId: null,
          authorId: msg.author.id,
          authorName: msg.author.global_name ?? msg.author.username,
          authorAvatarUrl: discordAvatarUrl(msg.author.id, msg.author.avatar),
          timestamp: msg.timestamp,
          content: flattenRestMessage(msg),
          embeds: [...(msg.embeds ?? [])],
        });
      }
    }
  }

  return messages.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

/**
 * Boot-time callout author backfill (docs/specs/0001-caller-following.md).
 *
 * `callouts` rows written before author capture carry a null author_id;
 * re-read the same REST history that catch-up uses and fill them in by
 * message id. The Caller roster itself is written on ingest from envelope
 * data — no boot-time seed.
 */
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
