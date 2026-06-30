/**
 * Discord message forwarder — adapted from
 * https://github.com/garbanz0/discord-message-forwarder
 *
 * Listens on every channel in DISCORD_ALLOWED_CHANNEL_IDS, assembles a rich
 * DiscordEnvelope (text + reply context + sticker names + attachment URLs),
 * and POSTs it to the single trader endpoint.
 */

import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
} from 'discord.js';

import { config, isAllowed } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';
import type { DiscordEnvelope } from '../shared/types.js';
import { signWebhookBody } from '../shared/webhookAuth.js';
import { buildEnvelope, buildMessageContent } from './messageAssembly.js';

const log = createLogger('bot');

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

async function forwardToTrader(envelope: DiscordEnvelope): Promise<void> {
  const body = JSON.stringify(envelope);

  const response = await fetch(config.traderWebhookUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...signWebhookBody(body, config.botTraderSecret),
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`trader returned ${response.status}: ${text.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
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
      listeningChannels: config.discordAllowedChannelIds.length || 'all',
      allowedAuthors: config.discordAllowedAuthorIds.length || 'all',
      traderEndpoint: config.traderWebhookUrl,
    });
  });

  client.on(Events.MessageCreate, async (message) => {
    try {
      if (message.system) return;
      if (message.webhookId) return;
      if (message.author.bot) return;
      if (!isAllowed(message.channelId, config.discordAllowedChannelIds)) return;
      if (!isAllowed(message.author.id, config.discordAllowedAuthorIds)) return;

      const content = await buildMessageContent(message);
      if (!content.trim()) return;

      const envelope = buildEnvelope(message, content);

      log.info('forwarding message', {
        messageId: envelope.messageId,
        author: envelope.authorName,
        channel: envelope.channelId,
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
