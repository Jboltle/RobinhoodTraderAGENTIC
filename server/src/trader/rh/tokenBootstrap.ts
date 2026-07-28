/**
 * Robinhood auth state reporting.
 *
 * `readTokenStatus` decides whether a stored access token is still usable,
 * refreshable, or gone — read from the JWT `exp` claim, since the stored
 * record has no absolute timestamp but the token itself does.
 */
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

import type { TokenStatus } from './types.js';

export type { TokenState, TokenStatus } from './types.js';

/** Treat tokens expiring within this window as needing refresh/re-auth. */
const EXPIRY_BUFFER_SEC = 120;

const MISSING: TokenStatus = { state: 'missing', expiresInSec: null, hasRefreshToken: false };

/** Never throws — absent or malformed token material is reported as `missing`. */
export function readTokenStatus(tokens: OAuthTokens | undefined): TokenStatus {
  const accessToken = tokens?.access_token;
  const hasRefreshToken = Boolean(tokens?.refresh_token);
  if (!accessToken) {
    return { ...MISSING, hasRefreshToken };
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
