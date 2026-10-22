/**
 * One-shot: read broker state back onto every historical placed order that
 * still says `unconfirmed` (or any other non-terminal state). The running
 * trader's fill monitor only looks back 24 h; this widens the window.
 *
 *   bun run fills:backfill            # last 90 days
 *   bun run fills:backfill 180        # last N days
 *
 * Read-only against the broker, safe under every TRADE_EXECUTION_MODE. Users
 * whose Robinhood session needs consent are skipped and reported.
 */
import { assertConfigValid } from '../shared/config.js';
import { createLogger, errorFields } from '../shared/logger.js';
import { createTraderDb } from '../trader/db.js';
import { TraderEvents } from '../trader/events.js';
import { sweepFills } from '../trader/fills.js';
import { createMcpRegistry } from '../trader/rh/mcpRegistry.js';

const log = createLogger('scripts:backfill-fills');
const DEFAULT_DAYS = 90;

async function main(): Promise<void> {
  assertConfigValid();
  const days = Number(process.argv[2] ?? DEFAULT_DAYS);
  if (!Number.isFinite(days) || days <= 0) throw new Error(`days must be a positive number, got "${process.argv[2]}"`);

  const db = createTraderDb();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const before = await db.listOpenOrders(since);
  log.info('backfill start', { since: since.toISOString(), openOrders: before.length });

  const result = await sweepFills({ db, brokers: createMcpRegistry(db), events: new TraderEvents() }, since);
  const after = await db.listOpenOrders(since);
  log.info('backfill done', { ...result, stillOpen: after.length });
  for (const row of after) {
    log.info('still open', {
      userId: row.userId,
      messageId: row.decision.messageId,
      orderId: row.decision.order?.orderId,
      status: row.decision.order?.status,
      at: row.decision.at,
    });
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    log.error('backfill failed', errorFields(err));
    process.exit(1);
  });
