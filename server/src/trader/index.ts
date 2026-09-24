import { assertConfigValid, config } from '../shared/config.js';
import { createLogger, errorFields } from '../shared/logger.js';
import { createTraderDb } from './db.js';
import { TraderEvents } from './events.js';
import { LlmCalloutParser } from './pipeline/parseCallout.js';
import { createMessageProcessor } from './pipeline/index.js';
import { startMaxLossMonitor } from './maxLoss.js';
import { INSTANCE_ID, startPoller } from './poller.js';
import { reparseStaleRecaps } from './recaps/sweep.js';
import { createMcpRegistry } from './rh/mcpRegistry.js';
import { buildServer } from './server.js';

const log = createLogger('trader');

async function main(): Promise<void> {
  assertConfigValid();

  const db = createTraderDb();
  const events = new TraderEvents();
  const brokers = createMcpRegistry(db);

  const processor = createMessageProcessor({
    parser: new LlmCalloutParser(),
    db,
    events,
    brokers,
  });

  const fastify = buildServer({ db, events, brokers });

  // Listen before anything else: on a deployed box the OAuth flow can only
  // complete via the dashboard hitting /api/broker/*, so the port must be open
  // while auth is pending. No fail-fast — a deployed server must stay up.
  await fastify.listen({ port: config.traderPort, host: config.traderHost });
  log.info('trader listening', {
    host: config.traderHost,
    port: config.traderPort,
    instanceId: INSTANCE_ID,
  });

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

  // The consumer loop over the messages table — the entire ingestion path.
  // Its first drain doubles as catch-up: rows the Listener captured while
  // this process was down are judged now (stale ones land as 'missed').
  startPoller({ db, processor });

  // Recap format-drift recovery: rows parsed under an older PARSER_VERSION
  // re-parse from raw content. Errors are contained; trading never depends on it.
  void reparseStaleRecaps(db).catch((err: unknown) =>
    log.error('recap re-parse failed', errorFields(err))
  );

  // Max Loss: process-lifetime flatten loop. Independent of the dashboard.
  startMaxLossMonitor({
    db,
    brokers,
    events,
    enqueue: (userId, run) => processor.enqueue(userId, run),
  });
}

main().catch((err) => {
  log.error('startup failed', errorFields(err));
  process.exit(1);
});
