/**
 * Runtime Robinhood auth bootstrap.
 *
 * `readTokenStatus` inspects the local token file and reports whether the
 * saved access token is still usable, refreshable, or gone — decoded from the
 * JWT `exp` claim (the file has no absolute timestamp, but the token itself
 * does).
 */
import { readFile } from 'node:fs/promises';

import type { StoredState, TokenStatus } from './types.js';

export type { TokenState, TokenStatus } from './types.js';

/** Treat tokens expiring within this window as needing refresh/re-auth. */
const EXPIRY_BUFFER_SEC = 120;

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
