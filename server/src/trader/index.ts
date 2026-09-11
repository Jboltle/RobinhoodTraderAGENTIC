import { REST, Routes } from 'discord.js';

import { assertConfigValid, config } from '../shared/config.js';
import { createLogger, errorFields } from '../shared/logger.js';
import { PostReceipt } from '../shared/types.js';
import { backfillCalloutAuthors } from './callouts.js';
import { catchUpOnWake } from './catchup.js';
import { createTraderDb } from './db.js';
import { TraderEvents } from './events.js';
import { LlmCalloutParser } from './pipeline/parseCallout.js';
import { createMessageProcessor } from './pipeline/index.js';
import { startMaxLossMonitor } from './maxLoss.js';
import { startRecapScheduler } from './recaps/sweep.js';
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

  const fastify = buildServer({ db, events, brokers, processor });

  // Listen before anything else: on a deployed box the OAuth flow can only
  // complete via the dashboard hitting /api/broker/*, so the port must be open
  // while auth is pending. No fail-fast — a deployed server must stay up.
  await fastify.listen({ port: config.traderPort, host: config.traderHost });
  log.info('trader listening', { host: config.traderHost, port: config.traderPort });

  // Reconnect everyone who was connected before the restart, so their stored
  // tokens are refreshed and their MCP session is warm before the first
  // callout arrives rather than during it. Contained: a bad first query must
  // not take the already-listening process down (see listen comment above).
  try {
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
  } catch (err: unknown) {
    log.error('could not restore broker sessions', errorFields(err));
  }

  void catchUpOnWake({ db, processor }).catch((err: unknown) =>
    log.error('catch-up failed', { error: (err as Error).message })
  );

  // Recap ingestion: boot backfill/catch-up + hourly weekday sweep. Errors
  // are contained inside the scheduler; the trading path never depends on it.
  startRecapScheduler(db);

  // Max Loss: process-lifetime flatten loop. Independent of the dashboard.
  startMaxLossMonitor({
    db,
    brokers,
    events,
    enqueue: (userId, run) => processor.enqueue(userId, run),
  });

  // Legacy callouts written before author capture have a null author_id.
  // Idempotent; must not block or crash the trading path.
  void backfillCalloutAuthors(db).catch((err: unknown) =>
    log.warn('callout author backfill failed', { error: (err as Error).message })
  );
}

main().catch((err) => {
  log.error('startup failed', errorFields(err));
  process.exit(1);
});
