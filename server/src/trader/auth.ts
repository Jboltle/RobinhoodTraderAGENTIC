/**
 * Sign-in, and the session check in front of every /api route.
 *
 * Sign-in is the email alone: an account's email, or an invited one
 * (allowed_emails), starts a session; nothing is emailed and there is no
 * password. The browser keeps the returned bearer token and sends it on every
 * request; the token is resolved to a user, and that user is the only scope
 * the route may read or write (see db.ts).
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
import type { AuthUser, TraderDb } from './db.js';

const log = createLogger('trader:auth');

/** How long a sign-in lasts before the browser has to sign in again. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const SignInBodySchema = z.object({ email: z.email() });

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth hook on every route it guards. */
    authUser?: AuthUser;
  }
}

/**
 * Routes that must stay reachable without a user session:
 *   /health          uptime pings (an external cron keeps the box awake)
 *   /api/auth/login  exchanging an email for the token
 */
const PUBLIC_ROUTES = new Set(['/health', '/api/auth/login']);

/** The acting user. Throws rather than returning null so a route cannot forget the check. */
export function requireUser(request: FastifyRequest): AuthUser {
  if (!request.authUser) {
    throw new Error('route reached without an authenticated user — check the auth hook');
  }
  return request.authUser;
}

export function registerAuth(fastify: FastifyInstance, db: TraderDb): void {
  fastify.addHook('preHandler', async (request, reply) => {
    if (PUBLIC_ROUTES.has(request.routeOptions.url ?? request.url)) return;
    // CORS preflight carries no Authorization header by design.
    if (request.method === 'OPTIONS') return;

    const token = bearerToken(request);
    if (!token) {
      return reply.status(401).send({ error: 'missing bearer token' });
    }

    const user = await db.verifyAccessToken(token).catch((err: unknown) => {
      log.warn('token verification failed', { error: (err as Error).message });
      return null;
    });
    if (!user) {
      return reply.status(401).send({ error: 'invalid or expired token' });
    }

    request.authUser = user;
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
