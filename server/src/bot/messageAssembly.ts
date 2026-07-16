import type { Message } from 'discord.js';

import { DiscordEnvelopeSchema, type DiscordEnvelope } from '../shared/types.js';

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

/**
 * Assemble the full text payload forwarded to the trader:
 * reply context + body + sticker names + attachment URLs.
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

  return body;
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
  });
}
