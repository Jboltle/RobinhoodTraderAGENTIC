/**
 * Runtime Robinhood auth bootstrap.
 *
 * Two responsibilities, both usable from the trader at startup and from the
 * standalone `import-tokens` script:
 *
 *  - `readTokenStatus`  inspects the local token file and reports whether the
 *                       saved access token is still usable, refreshable, or
 *                       gone — decoded from the JWT `exp` claim (the file has
 *                       no absolute timestamp, but the token itself does).
 *  - `importCodexTokens` copies Robinhood OAuth tokens that Codex already
 *                       obtained into the local token file so the trader can
 *                       start without its own browser OAuth flow.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { homedir } from 'node:os';

import { createLogger } from '../../shared/logger.js';
import type {
  CodexCredential,
  ImportCodexOptions,
  ImportCodexResult,
  StoredState,
  TokenStatus,
} from './types.js';

export type { ImportCodexOptions, ImportCodexResult, TokenState, TokenStatus } from './types.js';

const log = createLogger('trader:rh:token-bootstrap');

/** Treat tokens expiring within this window as needing refresh/re-auth. */
const EXPIRY_BUFFER_SEC = 120;

const CODEX_CREDS_PATH = `${homedir()}/.codex/.credentials.json`;

/** True when the token is usable now (valid, not within the expiry buffer). */
export function isUsable(status: TokenStatus): boolean {
  return status.state === 'valid';
}

/**
 * Inspect the local token file. Never throws — a missing or malformed file is
 * reported as `missing` so callers can decide how to recover.
 */
export async function readTokenStatus(path: string): Promise<TokenStatus> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return { state: 'missing', expiresInSec: null, hasRefreshToken: false };
  }

  let parsed: StoredState;
  try {
    parsed = JSON.parse(raw) as StoredState;
  } catch {
    return { state: 'missing', expiresInSec: null, hasRefreshToken: false };
  }

  const accessToken = parsed.tokens?.access_token;
  const hasRefreshToken = Boolean(parsed.tokens?.refresh_token);
  if (!accessToken) {
    return { state: 'missing', expiresInSec: null, hasRefreshToken };
  }

  const expiresInSec = jwtSecondsUntilExpiry(accessToken);
  if (expiresInSec === null) {
    // Opaque (non-JWT) token — assume usable and let the server be the judge.
    return { state: 'valid', expiresInSec: null, hasRefreshToken };
  }

  if (expiresInSec > EXPIRY_BUFFER_SEC) {
    return { state: 'valid', expiresInSec, hasRefreshToken };
  }
  return {
    state: hasRefreshToken ? 'refreshable' : 'expired',
    expiresInSec,
    hasRefreshToken,
  };
}

/**
 * Import Robinhood tokens from Codex credentials into the local token file.
 * Returns a structured result instead of throwing so it can be used as a
 * best-effort startup step.
 */
export async function importCodexTokens(opts: ImportCodexOptions): Promise<ImportCodexResult> {
  let raw: string;
  try {
    raw = await readFile(CODEX_CREDS_PATH, 'utf8');
  } catch {
    return { imported: false, reason: `Codex credentials not found at ${CODEX_CREDS_PATH}` };
  }

  let creds: Record<string, CodexCredential>;
  try {
    creds = JSON.parse(raw) as Record<string, CodexCredential>;
  } catch (err) {
    return { imported: false, reason: `Codex credentials file is not valid JSON: ${errMsg(err)}` };
  }

  const entry = Object.values(creds).find(
    (c) => c?.server_url?.includes('agent.robinhood.com') || c?.server_name?.includes('robinhood')
  );
  if (!entry) {
    return {
      imported: false,
      reason: `no Robinhood MCP entry in Codex credentials (found: ${Object.keys(creds).join(', ') || 'none'})`,
    };
  }

  const expiresInSec = Math.max(0, Math.floor((entry.expires_at - Date.now()) / 1000));
  if (expiresInSec < EXPIRY_BUFFER_SEC) {
    return { imported: false, reason: `Codex access token expires in ${expiresInSec}s — too soon to import` };
  }

  const includeRefreshToken = opts.includeRefreshToken ?? false;
  const tokenState = {
    client: {
      client_id: entry.client_id,
      redirect_uris: [opts.redirectUri],
      token_endpoint_auth_method: 'none',
      client_name: opts.clientName,
    },
    tokens: {
      access_token: entry.access_token,
      token_type: 'Bearer',
      ...(includeRefreshToken ? { refresh_token: entry.refresh_token } : {}),
      scope: entry.scopes.join(' '),
      expires_in: expiresInSec,
    },
  };

  await mkdir(dirname(opts.path), { recursive: true });
  await writeFile(opts.path, JSON.stringify(tokenState, null, 2), 'utf8');
  return { imported: true, expiresInSec };
}

/**
 * Best-effort startup helper: if the local tokens are unusable and cannot be
 * refreshed, try to import fresh tokens from Codex. Logs the outcome and
 * returns whether an import happened.
 */
export async function importCodexTokensIfNeeded(opts: ImportCodexOptions): Promise<boolean> {
  const status = await readTokenStatus(opts.path);
  if (status.state === 'valid' || status.state === 'refreshable') return false;

  const result = await importCodexTokens(opts);
  if (result.imported) {
    log.info('imported Robinhood tokens from Codex credentials', {
      expiresInHours: (result.expiresInSec / 3600).toFixed(1),
    });
    return true;
  }

  log.info('no Codex tokens imported; will fall back to browser OAuth if needed', {
    reason: result.reason,
  });
  return false;
}

/** Seconds until a JWT's `exp` claim; null when the token isn't a decodable JWT. */
function jwtSecondsUntilExpiry(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as {
      exp?: number;
    };
    if (typeof payload.exp !== 'number') return null;
    return payload.exp - Math.floor(Date.now() / 1000);
  } catch {
    return null;
  }
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));
