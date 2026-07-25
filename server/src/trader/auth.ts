/**
 * Supabase JWT verification in front of every /api route.
 *
 * The browser only ever uses the anon key to sign in; it never queries
 * application data. Everything else arrives here as a bearer token, is
 * resolved to a user, and that user is the only scope the route may read or
 * write (see db.ts).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { createLogger } from '../shared/logger.js';
import type { AuthUser, TraderDb } from './db.js';

const log = createLogger('trader:auth');

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth hook on every route it guards. */
    authUser?: AuthUser;
  }
}

/**
 * Routes that must stay reachable without a user session:
 *   /health              uptime pings (an external cron keeps the box awake)
 *   /webhook/discord     the bot, authenticated by HMAC over the raw body
 *   /api/auth/signup     creating the account that would supply the token
 */
const PUBLIC_ROUTES = new Set(['/health', '/webhook/discord', '/api/auth/signup']);

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
