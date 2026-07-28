/**
 * The auth gate.
 *
 * Every /api route in this list answered an anonymous request before the
 * multi-tenant refactor. Each one must now 401 without a valid Supabase JWT,
 * while /health and the HMAC-authed webhook stay open.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { signWebhookBody } from '../../shared/webhookAuth.js';
import { makeHarness, type Harness } from './harness.js';

const SECRET = 'test-dummy-secret';
const USER = { id: 'user-1', email: 'user@example.com' };
const TOKEN = 'a-valid-token';

/** Routes that answered an unauthenticated request before this refactor. */
const PREVIOUSLY_OPEN_ROUTES = [
  { method: 'GET' as const, url: '/api/decisions' },
  { method: 'GET' as const, url: '/api/callouts' },
  { method: 'GET' as const, url: '/api/settings' },
  { method: 'GET' as const, url: '/api/portfolio' },
  { method: 'GET' as const, url: '/api/trades/performance' },
  { method: 'GET' as const, url: '/api/stream' },
  { method: 'GET' as const, url: '/api/broker/status' },
];

let harness: Harness;

beforeEach(() => {
  harness = makeHarness();
  harness.db.addUser(USER, TOKEN);
});

describe('unauthenticated /api requests are rejected', () => {
  for (const route of PREVIOUSLY_OPEN_ROUTES) {
    it(`${route.method} ${route.url} 401s with no token`, async () => {
      const response = await harness.app.inject(route);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: 'missing bearer token' });
    });

    it(`${route.method} ${route.url} 401s with a forged token`, async () => {
      const response = await harness.as('not-a-real-token', route);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: 'invalid or expired token' });
    });
  }

  it('PUT /api/settings 401s and does not write', async () => {
    const response = await harness.app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ maxTradesPerDay: 99 }),
    });
    expect(response.statusCode).toBe(401);
    expect((await harness.db.getSettings(USER.id)).maxTradesPerDay).toBe(10);
  });

  it('a valid token gets through to the same route', async () => {
    const response = await harness.as(TOKEN, { method: 'GET', url: '/api/settings' });
    expect(response.statusCode).toBe(200);
  });

  it('an Authorization header that is not a bearer token is rejected', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { authorization: TOKEN },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('routes that must stay open', () => {
  it('GET /health needs no token', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true });
  });

  it('POST /webhook/discord is authenticated by HMAC, not by JWT', async () => {
    const payload = JSON.stringify({
      envelope: {
        messageId: 'msg-1',
        channelId: 'chan-1',
        guildId: null,
        authorId: 'author-1',
        authorName: 'Demon Alerts',
        content: 'BUY $AAPL',
        timestamp: '2026-07-20T14:30:00.000Z',
      },
    });

    const signed = await harness.app.inject({
      method: 'POST',
      url: '/webhook/discord',
      headers: { 'content-type': 'application/json', ...signWebhookBody(payload, SECRET) },
      payload,
    });
    expect(signed.statusCode).toBe(202);

    const unsigned = await harness.app.inject({
      method: 'POST',
      url: '/webhook/discord',
      headers: { 'content-type': 'application/json' },
      payload,
    });
    expect(unsigned.statusCode).toBe(401);
  });
});

describe('POST /api/auth/signup', () => {
  it('is open, but only to an allowlisted email', async () => {
    const signup = (email: string) =>
      harness.app.inject({
        method: 'POST',
        url: '/api/auth/signup',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ email, password: 'a-long-enough-password' }),
      });

    const uninvited = await signup('stranger@example.com');
    expect(uninvited.statusCode).toBe(403);
    expect(await harness.db.findUserByEmail('stranger@example.com')).toBeNull();

    harness.db.allowEmail('invited@example.com');
    const invited = await signup('invited@example.com');
    expect(invited.statusCode).toBe(201);
    expect(await harness.db.findUserByEmail('invited@example.com')).not.toBeNull();
  });

  it('rejects a password below the minimum length', async () => {
    harness.db.allowEmail('invited@example.com');
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'invited@example.com', password: 'short' }),
    });
    expect(response.statusCode).toBe(400);
  });
});
