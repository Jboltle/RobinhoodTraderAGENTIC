/**
 * Discord message forwarder — adapted from
 * https://github.com/garbanz0/discord-message-forwarder
 *
 * Listens on every channel in DISCORD_ALLOWED_CHANNEL_IDS, assembles a rich
 * DiscordEnvelope (text + reply context + sticker names + attachment URLs),
 * mirrors allowed messages to DISCORD_FORWARD_CHANNEL_ID when configured,
 * and POSTs it to the single trader endpoint.
 */

import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
} from 'discord.js';

import { assertConfigValid, config } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';
import type { DiscordEnvelope } from '../shared/types.js';
import { forwardToTrader } from './forwarder.js';
import {
  buildEnvelope,
  buildMessageContent,
  buildMirrorPayload,
  type MirrorPayload,
} from './messageAssembly.js';
import {
  classifyMessage,
  getChannelParentId,
  hasForwardableContent,
  shouldMirrorMessage,
} from './messageFilter.js';

/** Minimal structural shape of a discord.js channel we can post messages to. */
type TextSendableChannel = {
  readonly id: string;
  readonly name?: string;
  readonly guildId?: string;
  isTextBased?: () => boolean;
  send: (payload: MirrorPayload) => Promise<unknown>;
};

const log = createLogger('bot');

function logIgnoredMessage(message: Message, reason: string): void {
  if (!config.discordLogIgnoredMessages) return;
  log.info('ignored discord message', {
    reason,
    messageId: message.id,
    channelId: message.channelId,
    channelParentId: getChannelParentId(message),
    guildId: message.guildId ?? null,
    authorId: message.author?.id ?? null,
    authorName: message.member?.displayName ?? message.author?.username ?? null,
    contentLength: message.content?.length ?? 0,
    attachmentCount: message.attachments?.size ?? 0,
    stickerCount: message.stickers?.size ?? 0,
  });
}

async function validateConfiguredChannels(client: Client<true>): Promise<void> {
  if (config.discordAllowedChannelIds.length === 0) {
    log.warn('no Discord channel allowlist configured; bot will ignore all Discord messages');
    return;
  }

  await Promise.all(
    config.discordAllowedChannelIds.map(async (channelId) => {
      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel) {
          log.warn('configured Discord channel not found', { channelId });
          return;
        }

        const maybeText = channel as typeof channel & {
          readonly guildId?: string;
          readonly name?: string;
          isTextBased?: () => boolean;
        };
        const textBased = maybeText.isTextBased?.() ?? false;
        const meta = {
          channelId,
          guildId: maybeText.guildId ?? null,
          name: maybeText.name ?? null,
          type: channel.type,
          textBased,
        };

        if (!textBased) {
          log.warn('configured Discord channel is accessible but is not text-based', meta);
          return;
        }

        log.info('configured Discord channel accessible', meta);
      } catch (err) {
        log.warn('configured Discord channel is not accessible to this bot', {
          channelId,
          error: (err as Error).message,
        });
      }
    })
  );
}

async function validateForwardChannel(client: Client<true>): Promise<void> {
  if (!config.discordForwardChannelId) {
    log.info('no Discord forward channel configured; message mirroring disabled');
    return;
  }

  try {
    const channel = await client.channels.fetch(config.discordForwardChannelId);
    const maybeText = channel as TextSendableChannel | null;
    if (!maybeText) {
      log.warn('Discord forward channel not found', { channelId: config.discordForwardChannelId });
      return;
    }

    const textBased = maybeText.isTextBased?.() ?? false;
    if (!textBased || typeof maybeText.send !== 'function') {
      log.warn('Discord forward channel is accessible but is not sendable text', {
        channelId: config.discordForwardChannelId,
        guildId: maybeText.guildId ?? null,
        name: maybeText.name ?? null,
        textBased,
      });
      return;
    }

    log.info('Discord forward channel accessible', {
      channelId: maybeText.id,
      guildId: maybeText.guildId ?? null,
      name: maybeText.name ?? null,
    });
  } catch (err) {
    log.warn('Discord forward channel is not accessible to this bot', {
      channelId: config.discordForwardChannelId,
      error: (err as Error).message,
    });
  }
}

async function mirrorToDiscordChannel(client: Client, message: Message, envelope: DiscordEnvelope): Promise<void> {
  if (!shouldMirrorMessage(message, config.discordForwardChannelId)) return;

  const channel = await client.channels.fetch(config.discordForwardChannelId!);
  const sendable = channel as TextSendableChannel | null;
  if (!sendable || sendable.isTextBased?.() === false || typeof sendable.send !== 'function') {
    throw new Error(`Discord forward channel ${config.discordForwardChannelId} is not sendable`);
  }

  await sendable.send(buildMirrorPayload(envelope));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  assertConfigValid('bot');

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent, // privileged intent — must be ON in Developer Portal
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  client.once(Events.ClientReady, (ready) => {
    log.info('discord forwarder ready', {
      tag: ready.user.tag,
      listeningChannels: config.discordAllowedChannelIds.length ? config.discordAllowedChannelIds : 'none',
      allowedAuthors: config.discordAllowedAuthorIds.length || 'all',
      logIgnoredMessages: config.discordLogIgnoredMessages,
      forwardChannel: config.discordForwardChannelId ?? 'disabled',
      traderEndpoint: config.traderWebhookUrl,
    });
    void validateConfiguredChannels(ready);
    void validateForwardChannel(ready);
  });

  client.on(Events.MessageCreate, async (message) => {
    try {
      const classification = classifyMessage(message, config, client.user?.id ?? null);
      if (!classification.forward) {
        logIgnoredMessage(message, classification.reason);
        return;
      }

      const content = await buildMessageContent(message);
      if (!hasForwardableContent(content)) {
        log.warn('allowed Discord message had no readable content', {
          messageId: message.id,
          channelId: message.channelId,
          authorId: message.author.id,
          attachmentCount: message.attachments.size,
          stickerCount: message.stickers.size,
          hint: 'If this was a text message, enable the Message Content privileged intent in the Discord developer portal.',
        });
        return;
      }

      const envelope = buildEnvelope(message, content);

      log.info('forwarding message', {
        messageId: envelope.messageId,
        author: envelope.authorName,
        channel: envelope.channelId,
      });

      await mirrorToDiscordChannel(client, message, envelope).catch((err) => {
        log.warn('failed to mirror Discord message', {
          messageId: envelope.messageId,
          forwardChannel: config.discordForwardChannelId,
          error: (err as Error).message,
        });
      });
      await forwardToTrader(envelope);
    } catch (err) {
      log.error('failed to forward message', {
        messageId: message.id,
        error: (err as Error).message,
      });
    }
  });

  client.on(Events.Error, (err) => log.error('discord error', { error: err.message }));

  await client.login(config.discordBotToken);
}

main().catch((err) => {
  log.error('startup failed', { error: (err as Error).message, stack: (err as Error).stack });
  process.exit(1);
});
