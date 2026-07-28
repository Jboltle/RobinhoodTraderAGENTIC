import { REST, Routes } from 'discord.js';

import { assertConfigValid, config } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';
import { PostReceipt } from '../shared/types.js';
import { catchUpOnWake } from './catchup.js';
import { createTraderDb } from './db.js';
import { TraderEvents } from './events.js';
import { LlmCalloutParser } from './pipeline/parseCallout.js';
import { createMessageProcessor } from './pipeline/index.js';
import { createMcpRegistry } from './rh/mcpRegistry.js';
import { buildServer } from './server.js';

const log = createLogger('trader');

const RECEIPT_MAX_LENGTH = 1900;

function buildPostReceipt(rest: REST): PostReceipt {
  return async (channelId: string, content: string) => {
    try {
      const trimmed =
        content.length > RECEIPT_MAX_LENGTH
          ? content.slice(0, RECEIPT_MAX_LENGTH - 3) + '...'
          : content;
      await rest.post(Routes.channelMessages(channelId), {
        body: { content: trimmed },
      });
    } catch (err) {
      log.warn('failed to post receipt to discord', {
        channelId,
        error: (err as Error).message,
      });
    }
  };
}

async function main(): Promise<void> {
  assertConfigValid('trader');

  const db = createTraderDb();
  const events = new TraderEvents();
  const brokers = createMcpRegistry(db);
  const discordRest = new REST({ version: '10' }).setToken(config.discordBotToken);

  const processor = createMessageProcessor({
    parser: new LlmCalloutParser(),
    db,
    events,
    brokers,
    postReceipt: buildPostReceipt(discordRest),
  });

  if (config.tradeExecutionMode === 'approval') {
    log.warn('booted in approval mode; no orders will be submitted for any user');
  }

  const fastify = buildServer({ db, events, brokers, processor });

  // Listen before anything else: on a deployed box the OAuth flow can only
  // complete via the dashboard hitting /api/broker/*, so the port must be open
  // while auth is pending. No fail-fast — a deployed server must stay up.
  await fastify.listen({ port: config.traderPort, host: config.traderHost });
  log.info('trader listening', { host: config.traderHost, port: config.traderPort });

  // Reconnect everyone who was connected before the restart, so their stored
  // tokens are refreshed and their MCP session is warm before the first
  // callout arrives rather than during it.
  const userIds = await db.listBrokerUserIds();
  log.info('restoring broker sessions', { users: userIds.length });
  for (const userId of userIds) {
    void brokers
      .for(userId)
      .mcp.ensureConnected()
      .catch((err: unknown) =>
        log.warn('could not restore Robinhood session', { userId, error: (err as Error).message })
      );
  }

  void catchUpOnWake({ db, processor }).catch((err: unknown) =>
    log.error('catch-up failed', { error: (err as Error).message })
  );
}

main().catch((err) => {
  log.error('startup failed', { error: (err as Error).message, stack: (err as Error).stack });
  process.exit(1);
});
