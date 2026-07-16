/**
 * Pure, side-effect-free message gating used by the Discord forwarder.
 *
 * Extracted from the MessageCreate handler so the listen/forward decision can
 * be unit-tested without a live Discord connection.
 */

import type { Message } from 'discord.js';

import { isAllowed } from '../shared/config.js';

export interface MessageFilterConfig {
  readonly discordAllowedChannelIds: readonly string[];
  readonly discordAllowedAuthorIds: readonly string[];
}

export interface MessageClassification {
  readonly forward: boolean;
  /** 'allowed' when forwardable, otherwise the ignore reason code. */
  readonly reason: string;
}

/**
 * Parent channel id of a message's channel (the containing channel when the
 * message is inside a thread), or null when it has none. Centralizes the
 * discord.js channel-shape cast used across the forwarder.
 */
export function getChannelParentId(message: Message): string | null {
  const channel = message.channel as typeof message.channel & {
    parentId?: string | null;
  };
  return channel.parentId ?? null;
}

/**
 * Channel allow-list gate. Empty allow-list fails closed (ignore everything).
 * Messages inside a thread also match when the thread's parent channel is allowed.
 */
export function isAllowedDiscordChannel(
  message: Message,
  allowedChannelIds: readonly string[]
): boolean {
  if (allowedChannelIds.length === 0) return false;
  if (isAllowed(message.channelId, allowedChannelIds)) return true;

  const parentId = getChannelParentId(message);
  return Boolean(parentId && isAllowed(parentId, allowedChannelIds));
}

/** Whether an allowed message should be mirrored to the forward channel. */
export function shouldMirrorMessage(message: Message, forwardChannelId: string | null): boolean {
  if (!forwardChannelId) return false;
  if (message.channelId === forwardChannelId) return false;

  return getChannelParentId(message) !== forwardChannelId;
}

/** A message is only forwardable once its assembled content is non-empty. */
export function hasForwardableContent(content: string): boolean {
  return content.trim().length > 0;
}

/**
 * Ordered filter chain: system -> self -> channel allow-list -> author
 * allow-list. Bot/webhook-authored messages are always allowed because most
 * alert channels are bot-driven; the bot's own posts are still dropped (via
 * `selfAuthorId`) so mirrored messages never loop back in. Content emptiness
 * is checked separately by the caller via {@link hasForwardableContent}.
 */
export function classifyMessage(
  message: Message,
  cfg: MessageFilterConfig,
  selfAuthorId?: string | null
): MessageClassification {
  if (message.system) return { forward: false, reason: 'system_message' };
  if (selfAuthorId && message.author.id === selfAuthorId) {
    return { forward: false, reason: 'self_author' };
  }
  if (!isAllowedDiscordChannel(message, cfg.discordAllowedChannelIds)) {
    return { forward: false, reason: 'channel_not_allowed' };
  }
  if (!isAllowed(message.author.id, cfg.discordAllowedAuthorIds)) {
    return { forward: false, reason: 'author_not_allowed' };
  }
  return { forward: true, reason: 'allowed' };
}
