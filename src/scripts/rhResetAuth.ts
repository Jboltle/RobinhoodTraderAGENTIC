/**
 * Reset local Robinhood OAuth state.
 *
 * Use this when Robinhood shows the agent as connected but this local app never
 * received/stored tokens. It removes local client registration, PKCE verifier,
 * and token state so the next `bun run connect` or `bun run dev` starts a fresh
 * OAuth flow.
 */
import { rm } from 'node:fs/promises';

import { config } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('rh-reset-auth');

async function main(): Promise<void> {
  try {
    await rm(config.rhTokensPath, { force: true });
    log.info('removed local Robinhood OAuth state', { path: config.rhTokensPath });
  } catch (err) {
    log.error('failed to remove local Robinhood OAuth state', {
      path: config.rhTokensPath,
      error: (err as Error).message,
    });
    process.exitCode = 1;
  }
}

void main();
