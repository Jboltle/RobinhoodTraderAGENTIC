/**
 * One-shot migration: copy Robinhood OAuth tokens that Codex already obtained
 * into state/rh-tokens.json so the standalone trader can start without its
 * own browser OAuth flow.
 *
 *   npm run import-tokens
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { config } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('import-codex-tokens');

const CODEX_CREDS_PATH = `${process.env.HOME}/.codex/.credentials.json`;

interface CodexCredential {
  server_name: string;
  server_url: string;
  client_id: string;
  access_token: string;
  expires_at: number; // ms since epoch
  refresh_token: string;
  scopes: string[];
}

async function main(): Promise<void> {
  // ---- Read Codex credentials ------------------------------------------
  let raw: string;
  try {
    raw = await readFile(CODEX_CREDS_PATH, 'utf8');
  } catch {
    throw new Error(`Codex credentials not found at ${CODEX_CREDS_PATH}. Run Codex with the Robinhood MCP first.`);
  }

  const creds = JSON.parse(raw) as Record<string, CodexCredential>;

  // Find any key that references the Robinhood trading server.
  const entry = Object.values(creds).find(
    (c) => c.server_url?.includes('agent.robinhood.com') || c.server_name?.includes('robinhood')
  );

  if (!entry) {
    throw new Error('No Robinhood MCP entry found in Codex credentials. Available: ' + Object.keys(creds).join(', '));
  }

  const nowMs = Date.now();
  const expiresInSeconds = Math.max(0, Math.floor((entry.expires_at - nowMs) / 1000));

  log.info('found Robinhood tokens in Codex credentials', {
    client_id: entry.client_id,
    server_url: entry.server_url,
    expires_in_seconds: expiresInSeconds,
    expires_in_hours: (expiresInSeconds / 3600).toFixed(1),
  });

  if (expiresInSeconds < 60) {
    throw new Error(`Access token expires in ${expiresInSeconds}s — too soon. Re-authenticate Codex first.`);
  }

  // ---- Build the PersistedState expected by FileOAuthProvider ----------
  const tokenState = {
    client: {
      client_id: entry.client_id,
      redirect_uris: [config.robinhoodOAuthRedirectUri],
      token_endpoint_auth_method: 'none',
      client_name: config.robinhoodOAuthClientName,
    },
    tokens: {
      access_token: entry.access_token,
      token_type: 'Bearer',
      refresh_token: entry.refresh_token,
      scope: entry.scopes.join(' '),
      expires_in: expiresInSeconds,
    },
  };

  // ---- Write to state/rh-tokens.json -----------------------------------
  await mkdir(dirname(config.rhTokensPath), { recursive: true });
  await writeFile(config.rhTokensPath, JSON.stringify(tokenState, null, 2), 'utf8');

  log.info('tokens written', {
    path: config.rhTokensPath,
    expires_in_hours: (expiresInSeconds / 3600).toFixed(1),
  });
  log.info('you can now run: npm run trader');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    log.error('failed', { error: (err as Error).message });
    process.exit(1);
  });
