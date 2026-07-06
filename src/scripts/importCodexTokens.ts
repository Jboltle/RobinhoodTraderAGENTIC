/**
 * Manual one-shot import of Robinhood OAuth tokens that Codex already obtained
 * into state/rh-tokens.json, so the standalone trader can start without its own
 * browser OAuth flow.
 *
 *   npm run import-tokens
 *
 * The trader also does this automatically at startup (see tokenBootstrap); this
 * script is retained for explicit manual imports and to force a refresh-token
 * import via IMPORT_CODEX_REFRESH_TOKEN=true.
 */
import { config } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';
import { importCodexTokens } from '../trader/rh/tokenBootstrap.js';

const log = createLogger('import-codex-tokens');

async function main(): Promise<void> {
  const includeRefreshToken =
    (process.env.IMPORT_CODEX_REFRESH_TOKEN ?? 'false').toLowerCase() === 'true';

  const result = await importCodexTokens({
    path: config.rhTokensPath,
    redirectUri: config.robinhoodOAuthRedirectUri,
    clientName: config.robinhoodOAuthClientName,
    includeRefreshToken,
  });

  if (!result.imported) {
    throw new Error(result.reason);
  }

  log.info('tokens written', {
    path: config.rhTokensPath,
    expiresInHours: (result.expiresInSec / 3600).toFixed(1),
    refreshTokenImported: includeRefreshToken,
  });
  log.info('you can now run: npm run dev');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    log.error('failed', { error: (err as Error).message });
    process.exit(1);
  });
