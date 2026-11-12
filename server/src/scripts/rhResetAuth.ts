/**
 * Drop one user's stored Robinhood OAuth state.
 *
 *   npm run auth:reset <email or user id>
 *
 * Use this when Robinhood shows the agent as connected but the app can no
 * longer trade with the tokens it holds. Clearing them means the user's next
 * visit to the dashboard starts a fresh OAuth flow; the account, its settings
 * and its trades stay.
 */
import { createLogger } from '../shared/logger.js';
import { createTraderDb } from '../trader/db.js';

const log = createLogger('rh-reset-auth');

async function main(): Promise<void> {
  const identifier = process.argv[2]?.trim();
  if (!identifier) {
    log.error('usage: npm run auth:reset <email or user id>');
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

  // Every user has exactly one direct Robinhood account, and until a second
  // adapter exists it is the one they have selected.
  const account = await db.getSelectedAccount(userId);
  if (account?.adapter !== 'robinhood') {
    log.error('user has no direct Robinhood account selected', { userId });
    process.exitCode = 1;
    return;
  }

  try {
    await db.deleteBrokerTokens(account.id);
    log.info('removed stored Robinhood OAuth state', { accountId: account.id });
  } catch (err) {
    log.error('failed to remove stored Robinhood OAuth state', {
      accountId: account.id,
      error: (err as Error).message,
    });
    process.exitCode = 1;
  }
}

void main();
