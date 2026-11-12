import { assertConfigValid, config } from '../shared/config.js';
import { createLogger, errorFields } from '../shared/logger.js';
import { createTraderDb } from './db.js';
import { TraderEvents } from './events.js';
import { JevCalloutDecider } from './pipeline/decide.js';
import { JevClient } from './pipeline/jev.js';
import { LlmCalloutParser } from './pipeline/parseCallout.js';
import { createMessageProcessor } from './pipeline/index.js';
import { startBookMonitor } from './book/monitor.js';
import { startFillMonitor } from './fills.js';
import { startLadderMonitor } from './ladderMonitor.js';
import { startMaxLossMonitor } from './maxLoss.js';
import { INSTANCE_ID, startPoller } from './poller.js';
import { reparseStaleRecaps } from './recaps/sweep.js';
import { createQuoteSource } from './broker/quotes.js';
import { createMcpRegistry, restoreSessions } from './broker/registry.js';
import { deployedAdapters } from './adapters.js';
import { createSnapTrade } from './snaptrade/client.js';
import { buildServer } from './server.js';

const log = createLogger('trader');

async function main(): Promise<void> {
  assertConfigValid();

  const db = createTraderDb();
  const events = new TraderEvents();
  // Other brokers, through SnapTrade: off unless all three SnapTrade variables
  // are set. With them the owner can connect one (the dashboard's "Other
  // broker") and its accounts trade through the SnapTrade adapter.
  const snapTrade = createSnapTrade({
    clientId: config.snaptradeClientId,
    consumerKey: config.snaptradeConsumerKey,
    ownerEmail: config.snaptradeOwnerEmail,
  });
  const brokers = createMcpRegistry(
    deployedAdapters(db, snapTrade?.brokerClient ?? null),
    config.tradeExecutionMode
  );
  const quotes = createQuoteSource({ db, brokers });

  // DECISION_ENGINE=parser rolls the trade path back to the LLM parser.
  const parser =
    config.decisionEngine === 'jev'
      ? new JevCalloutDecider(new JevClient({ apiKey: config.jevApiKey, model: config.jevModel }))
      : new LlmCalloutParser();
  log.info('decision engine', { engine: config.decisionEngine });
  // Logged at boot on purpose: the one line to read when wondering why a
  // deployment is (not) placing orders.
  log.info('execution policy', { tradeExecutionMode: config.tradeExecutionMode });

  const executionMode = config.tradeExecutionMode;
  const processor = createMessageProcessor({
    parser,
    db,
    events,
    brokers,
    quotes,
    executionMode,
  });

  log.info('snaptrade', { enabled: snapTrade !== null });

  const fastify = buildServer({ db, events, brokers, executionMode, snapTrade: snapTrade?.access ?? null });

  // Listen before anything else: on a deployed box the OAuth flow can only
  // complete via the dashboard hitting /api/broker/*, so the port must be open
  // while auth is pending. No fail-fast — a deployed server must stay up.
  await fastify.listen({ port: config.traderPort, host: config.traderHost });
  log.info('trader listening', {
    host: config.traderHost,
    port: config.traderPort,
    instanceId: INSTANCE_ID,
  });

  // Warm every connected account's session before the first callout arrives.
  // Contained: a bad first query must not take the already-listening process
  // down (see listen comment above).
  try {
    await restoreSessions(db, brokers);
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

  // Fill read-back: keeps placed orders' broker state current. Read-only, so
  // it runs under every TRADE_EXECUTION_MODE.
  startFillMonitor({ db, brokers, events, lookbackMs: config.fillLookbackMs, executionMode });
  startLadderMonitor({ db, brokers, events, executionMode });

  // The tracked-callout book: marks, simulated ladder fills and expiry
  // settlement for every Caller entry. Read-only like the fill monitor.
  startBookMonitor({ db, quotes, events });

  // Max Loss: process-lifetime flatten loop. Independent of the dashboard.
  startMaxLossMonitor({
    db,
    brokers,
    events,
    enqueue: (accountId, run) => processor.enqueue(accountId, run),
  });
}

main().catch((err) => {
  log.error('startup failed', errorFields(err));
  process.exit(1);
});
