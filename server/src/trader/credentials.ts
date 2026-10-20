/**
 * Session tokens for the trader's own sign-in.
 *
 * The browser holds a random 256-bit token; the database stores only its
 * SHA-256, so a copy of the sessions table cannot be replayed as a login.
 */
import { createHash, randomBytes } from 'node:crypto';

const SESSION_TOKEN_BYTES = 32;

export const newSessionToken = (): string => randomBytes(SESSION_TOKEN_BYTES).toString('base64url');

export const hashSessionToken = (token: string): string =>
  createHash('sha256').update(token).digest('base64url');
