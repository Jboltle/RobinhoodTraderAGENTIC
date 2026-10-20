/**
 * The auth gate.
 *
 * Every /api route in this list answered an anonymous request before the
 * multi-tenant refactor. Each one must now 401 without a live session token,
 * while /health and the sign-in route stay open.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { makeHarness, type Harness } from './harness.js';

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

});

const signIn = (body: Record<string, unknown>) =>
  harness.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });

describe('POST /api/auth/login', () => {
  it('is open, and trades an existing account email for a working token', async () => {
    const response = await signIn({ email: 'User@Example.com' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ email: USER.email });

    const settings = await harness.as(response.json().token, { method: 'GET', url: '/api/settings' });
    expect(settings.statusCode).toBe(200);
  });

  it('creates the account at an invited email first sign-in, and reuses it after', async () => {
    harness.db.allowEmail('invited@example.com');
    expect(await harness.db.findUserByEmail('invited@example.com')).toBeNull();

    const first = await signIn({ email: 'invited@example.com' });
    expect(first.statusCode).toBe(200);
    const account = await harness.db.findUserByEmail('invited@example.com');
    expect(account).not.toBeNull();

    const again = await signIn({ email: 'invited@example.com' });
    expect(again.statusCode).toBe(200);
    expect(await harness.db.findUserByEmail('invited@example.com')).toEqual(account);
  });

  it('refuses an email that is neither an account nor invited, and creates nothing', async () => {
    const response = await signIn({ email: 'stranger@example.com' });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'this email is not invited' });
    expect(await harness.db.findUserByEmail('stranger@example.com')).toBeNull();
  });

  it('rejects a body without a valid email', async () => {
    expect((await signIn({})).statusCode).toBe(400);
    expect((await signIn({ email: 'not-an-email' })).statusCode).toBe(400);
  });
});

describe('POST /api/auth/logout', () => {
  it('makes that token stop working', async () => {
    const token = (await signIn({ email: USER.email })).json().token;
    const loggedOut = await harness.as(token, { method: 'POST', url: '/api/auth/logout' });
    expect(loggedOut.statusCode).toBe(200);

    const after = await harness.as(token, { method: 'GET', url: '/api/settings' });
    expect(after.statusCode).toBe(401);
  });
});
