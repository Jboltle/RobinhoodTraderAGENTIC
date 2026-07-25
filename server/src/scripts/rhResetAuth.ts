/**
 * Drop one user's stored Robinhood OAuth state.
 *
 *   bun run auth:reset <email or user id>
 *
 * Use this when Robinhood shows the agent as connected but the app can no
 * longer trade with the tokens it holds. Removing the row means the user's
 * next visit to the dashboard starts a fresh OAuth flow.
 */
import { createLogger } from '../shared/logger.js';
import { createTraderDb } from '../trader/db.js';

const log = createLogger('rh-reset-auth');

async function main(): Promise<void> {
  const identifier = process.argv[2]?.trim();
  if (!identifier) {
    log.error('usage: bun run auth:reset <email or user id>');
    process.exitCode = 1;
    return;
  }

  const db = createTraderDb();
  const userId = identifier.includes('@')
    ? (await db.findUserByEmail(identifier))?.id
    : identifier;
  if (!userId) {
    log.error('no such user', { identifier });
    process.exitCode = 1;
    return;
  }

  try {
    await db.deleteBrokerTokens(userId);
    log.info('removed stored Robinhood OAuth state', { userId });
  } catch (err) {
    log.error('failed to remove stored Robinhood OAuth state', {
      userId,
      error: (err as Error).message,
    });
    process.exitCode = 1;
  }
}

void main();
