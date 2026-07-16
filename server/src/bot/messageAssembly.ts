import type { Message } from 'discord.js';

import { flattenEmbedText } from '../shared/embedText.js';
import { DiscordEnvelopeSchema, type DiscordEnvelope } from '../shared/types.js';

/** Message payload mirrored to the forward channel (text header + original embeds). */
export interface MirrorPayload {
  readonly content: string;
  readonly embeds: readonly Record<string, unknown>[];
  readonly allowedMentions: { readonly parse: [] };
}

/** Discord caps total embed text at 6000 chars; keep the forwarded string within that. */
const MAX_CONTENT_LENGTH = 6000;

/** Discord renders at most 10 embeds per message. */
const MAX_EMBEDS = 10;

/**
 * Build a reply-context prefix when the message is a thread reply.
 * Exported for unit testing without a live Discord connection.
 */
export async function buildReplyPrefix(message: Message): Promise<string> {
  if (!message.reference?.messageId) return '';
  try {
    const ref = await message.fetchReference();
    const who = ref.member?.displayName ?? ref.author?.username ?? 'someone';
    let snippet = (ref.content ?? '').replace(/\n/g, ' ').slice(0, 80);
    if (!snippet && ref.attachments.size) snippet = '[attachment]';
    if (!snippet && ref.embeds.length) snippet = '[embed]';
    return `> ↪️ replying to **${who}**: ${snippet}\n`;
  } catch {
    return '> ↪️ replying to an earlier message\n';
  }
}

/** Slice to `max` chars, dropping a trailing lone high surrogate so JSON encoding stays valid. */
function truncateSafe(text: string, max: number): string {
  if (text.length <= max) return text;
  const sliced = text.slice(0, max);
  const last = sliced.charCodeAt(sliced.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? sliced.slice(0, -1) : sliced;
}

/**
 * Assemble the full text payload forwarded to the trader:
 * reply context + body + sticker names + attachment URLs + flattened embeds.
 */
export async function buildMessageContent(message: Message): Promise<string> {
  const replyPrefix = await buildReplyPrefix(message);
  let body = (replyPrefix + (message.content ?? '')).trim();

  if (message.stickers?.size) {
    const names = [...message.stickers.values()].map((s) => `:${s.name}:`).join(' ');
    body = (body ? body + '\n' : '') + `🏷️ sticker: ${names}`;
  }

  if (message.attachments.size) {
    const urls = [...message.attachments.values()].map((a) => a.url).join('\n');
    body = (body ? body + '\n' : '') + urls;
  }

  if (message.embeds?.length) {
    // Separate flattened embeds so consecutive callout cards don't merge into one.
    const embedText = message.embeds.map(flattenEmbedText).filter(Boolean).join('\n---\n');
    if (embedText) body = (body ? body + '\n' : '') + embedText;
  }

  return truncateSafe(body, MAX_CONTENT_LENGTH);
}

/** Validate and normalise a Discord message into a DiscordEnvelope. */
export function buildEnvelope(message: Message, content: string): DiscordEnvelope {
  return DiscordEnvelopeSchema.parse({
    messageId: message.id,
    channelId: message.channelId,
    guildId: message.guildId ?? null,
    authorId: message.author.id,
    authorName: message.member?.displayName ?? message.author.username,
    content,
    timestamp: new Date(message.createdTimestamp).toISOString(),
    embeds: (message.embeds ?? []).slice(0, MAX_EMBEDS).map((e) => e.toJSON()),
  });
}

/**
 * Payload mirrored to the forward channel: text header + original embeds, so
 * embed-only callout "cards" render as actual cards there.
 */
export function buildMirrorPayload(envelope: DiscordEnvelope): MirrorPayload {
  const header = [
    `From: ${envelope.authorName} (${envelope.authorId})`,
    `Source channel: ${envelope.channelId}`,
    `Message ID: ${envelope.messageId}`,
  ].join('\n');
  const content = `${header}\n\n${envelope.content}`;
  return {
    content: content.length <= 2000 ? content : truncateSafe(content, 1997) + '...',
    // Drop auto-generated link previews ('link', 'image', ...): Discord re-creates
    // them from URLs in `content`, so mirroring them would duplicate the preview.
    embeds: (envelope.embeds ?? []).filter((e) => !e.type || e.type === 'rich'),
    allowedMentions: { parse: [] },
  };
}
