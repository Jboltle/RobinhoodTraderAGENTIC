/**
 * Sign-in, and the session check in front of every /api route.
 *
 * Sign-in is the email alone: an account's email, or an invited one
 * (allowed_emails), starts a session; nothing is emailed and there is no
 * password. The browser keeps the returned bearer token and sends it on every
 * request; the token is resolved to a user, and that user's selected account is
 * the only scope the route may read or write (see db.ts).
 *
 * ponytail: the email is the whole credential, by choice, so anyone who knows
 * a user's email can act as that user, trades included. The invite list is
 * the only gate. Upgrade path: a second check (password or emailed code) in
 * the login route before the session is created.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { createLogger } from '../shared/logger.js';
import { newSessionToken } from './credentials.js';
import type { AccountRow } from './broker/types.js';
import type { AuthUser, TraderDb } from './db.js';

const log = createLogger('trader:auth');

/** How long a sign-in lasts before the browser has to sign in again. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const SignInBodySchema = z.object({ email: z.email() });

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth hook on every route it guards. */
    authUser?: AuthUser;
    /** The user's selected account, set with authUser; null for a user with none. */
    authAccount?: AccountRow | null;
  }
}

/**
 * Routes that must stay reachable without a user session:
 *   /health          uptime pings (an external cron keeps the box awake)
 *   /api/auth/login  exchanging an email for the token
 */
const PUBLIC_ROUTES = new Set(['/health', '/api/auth/login']);

/**
 * The dashboard names the account its screens are showing on every request.
 * The account a route acts on still comes from the session alone; this header
 * can only get a request refused. It is refused when the selection has moved
 * since that page last loaded it (a switch made in another tab), so an Approve
 * or a settings save never lands on an account the user is not looking at.
 * A read without the header (curl, the scripts) is not checked; a request
 * that changes something must carry it (ACCOUNT_NOT_NAMED_CODE below).
 */
export const VIEWED_ACCOUNT_HEADER = 'x-viewed-account';
/** `code` on the 409 above, so the dashboard can tell it from every other 409. */
export const ACCOUNT_CHANGED_CODE = 'account_changed';
const ACCOUNT_CHANGED_ERROR =
  'The selected account changed since this page loaded it. Nothing was done.';

/**
 * `code` on the 409 a request that changes something gets when it names no
 * account. A page that never learned which account it shows (its account list
 * failed to load, or its bundle predates the header) would otherwise act on
 * whichever account is selected now: an Approve clicked on one account's card
 * placing the other account's order.
 */
export const ACCOUNT_NOT_NAMED_CODE = 'account_not_named';
const ACCOUNT_NOT_NAMED_ERROR = 'This page is out of date. Reload it and try again. Nothing was done.';

/** How a stale tab finds out what is selected now, and signs out: never refused as stale. */
const SELECTION_ROUTES = new Set(['/api/accounts', '/api/accounts/select', '/api/auth/logout']);

/**
 * The Robinhood login acts on the user's Robinhood account whichever account
 * is selected, so it need not name one.
 */
const ROBINHOOD_LOGIN_ROUTES = new Set(['/api/broker/connect', '/api/broker/callback']);

const READ_METHODS = new Set(['GET', 'HEAD']);

/**
 * Whether a request must name the account it believes it acts on. Every route
 * that is not a read does, unless it is listed above: a route added later is
 * covered without anyone remembering to list it.
 */
const mustNameAccount = (method: string, route: string): boolean =>
  !READ_METHODS.has(method) && !SELECTION_ROUTES.has(route) && !ROBINHOOD_LOGIN_ROUTES.has(route);

/** The acting user. Throws rather than returning null so a route cannot forget the check. */
export function requireUser(request: FastifyRequest): AuthUser {
  if (!request.authUser) {
    throw new Error('route reached without an authenticated user — check the auth hook');
  }
  return request.authUser;
}

/**
 * The acting user's selected account: what every per-account route reads and
 * writes. Resolved from the session by the auth hook, never from anything the
 * client sends, so a route cannot be pointed at another user's account.
 */
export function requireAccount(request: FastifyRequest): AccountRow {
  const user = requireUser(request);
  if (!request.authAccount) throw new Error(`user ${user.id} has no account`);
  return request.authAccount;
}

export function registerAuth(fastify: FastifyInstance, db: TraderDb): void {
  fastify.addHook('preHandler', async (request, reply) => {
    const route = request.routeOptions.url ?? request.url;
    if (PUBLIC_ROUTES.has(route)) return;
    // CORS preflight carries no Authorization header by design.
    if (request.method === 'OPTIONS') return;

    const token = bearerToken(request);
    if (!token) {
      return reply.status(401).send({ error: 'missing bearer token' });
    }

    const session = await db.verifyAccessToken(token).catch((err: unknown) => {
      log.warn('token verification failed', { error: (err as Error).message });
      return null;
    });
    if (!session) {
      return reply.status(401).send({ error: 'invalid or expired token' });
    }

    const viewed = request.headers[VIEWED_ACCOUNT_HEADER];
    if (viewed === undefined) {
      if (mustNameAccount(request.method, route)) {
        return reply.status(409).send({ error: ACCOUNT_NOT_NAMED_ERROR, code: ACCOUNT_NOT_NAMED_CODE });
      }
    } else if (viewed !== session.account?.id && !SELECTION_ROUTES.has(route)) {
      return reply.status(409).send({ error: ACCOUNT_CHANGED_ERROR, code: ACCOUNT_CHANGED_CODE });
    }

    request.authUser = session.user;
    request.authAccount = session.account;
  });

  fastify.post('/api/auth/login', async (request, reply) => {
    const parsed = SignInBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'body must be { email: string }' });
    }
    const email = parsed.data.email.trim().toLowerCase();
    const user = await db.userForSignIn(email);
    if (!user) {
      log.warn('sign-in rejected: not an account or invite', { email });
      return reply.status(403).send({ error: 'this email is not invited' });
    }

    const token = newSessionToken();
    await db.createSession(user.id, token, new Date(Date.now() + SESSION_TTL_MS));
    log.info('signed in', { email });
    return reply.send({ token, email: user.email ?? email });
  });

  fastify.post('/api/auth/logout', async (request, reply) => {
    const token = bearerToken(request);
    if (token) await db.deleteSession(token);
    return reply.send({ ok: true });
  });
}

/**
 * Header only, including for /api/stream. EventSource cannot set headers, so
 * the dashboard reads that stream with fetch instead (client/src/lib/stream.ts)
 * rather than putting an access token in a URL where it lands in access logs.
 */
function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim() || null;
}
