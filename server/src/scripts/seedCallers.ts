/**
 * Manual Caller roster seed (docs/specs/0001-caller-following.md).
 *
 *   bun run seed:callers
 *
 * The trader also runs this itself at boot (trader/callerBootstrap.ts), so
 * production needs no manual step; the script remains for seeding a database
 * ahead of a first deploy. Insert-only — existing rows are never overwritten,
 * so it is safe to rerun.
 */
import { createLogger } from '../shared/logger.js';
import { seedMissingCallers } from '../trader/callerBootstrap.js';
import { createTraderDb } from '../trader/db.js';

const log = createLogger('seed-callers');

seedMissingCallers(createTraderDb())
  .then((seeded) => {
    log.info('done', { seeded });
    process.exit(0);
  })
  .catch((err) => {
    log.error('seed failed', { error: (err as Error).message });
    process.exit(1);
  });
