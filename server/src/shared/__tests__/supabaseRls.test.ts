/**
 * Default-deny proof for the Supabase schema (supabase/migrations/).
 *
 * The anon key ships inside the client JS bundle and PostgREST is publicly
 * reachable, so the only thing standing between a stranger and every user's
 * trades is RLS plus the revoked grants. This asserts that, per table, for the
 * anon key AND for a real logged-in user's JWT — the two keys a browser can
 * actually hold — while service_role (how the server reads) still works.
 *
 * Each table is seeded with a row first: against an empty table a denial and a
 * successful read are indistinguishable, so an empty result would let a broken
 * policy pass. Every fixture is unique per run and torn down afterwards.
 *
 * Denial has two very different causes and only one of them is worth asserting
 * — see assertAnonKeyReachesTheGrantCheck below, which rules the other one out
 * before a single expectation runs.
 *
 * SKIPPED when the SUPABASE_* vars are unset (fresh clone / CI with no stack).
 * Start one with `npx supabase start` and copy the printed keys into .env.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const supabaseUrl = process.env.SUPABASE_URL?.trim();
const anonKey = process.env.SUPABASE_ANON_KEY?.trim();
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const CONFIGURED = Boolean(supabaseUrl && anonKey && serviceRoleKey);

const TABLES = [
  'callouts',
  'trades',
  'settings',
  'allowed_emails',
  'broker_connections',
  'callers',
] as const;

// Unique per run so reruns never collide with leftovers from a failed teardown.
const runId = Date.now();
const probeEmail = `rls-probe-${runId}@example.com`;
const probePassword = `rls-probe-${runId}-password`;
const probeMessageId = `rls-probe-${runId}`;

/** PostgREST's error body. `42501` is Postgres' insufficient_privilege. */
interface PostgrestError {
  readonly code: string;
  readonly message: string;
}

const request = (
  path: string,
  { apiKey, token = apiKey, ...init }: RequestInit & { apiKey: string; token?: string }
): Promise<Response> =>
  fetch(`${supabaseUrl}${path}`, {
    ...init,
    headers: {
      apikey: apiKey,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });

const insertAsServiceRole = async (table: string, row: unknown): Promise<void> => {
  const res = await request(`/rest/v1/${table}`, {
    apiKey: serviceRoleKey!,
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`seeding ${table} failed: HTTP ${res.status} ${await res.text()}`);
};

let probeUserId = '';
let probeUserJwt = '';

/**
 * A 42501 only proves the grants if the key got as far as the grant check.
 * PostgREST answers PGRST301 for a JWT it cannot decode — stale, expired,
 * malformed — which denies the read for a reason that says nothing at all
 * about RLS, and would leave this suite red for an unrelated cause. GoTrue is
 * no help here: it accepts any apikey, so seeding succeeds either way.
 *
 * `GET /rest/v1/` is the request that separates the two layers, because it
 * needs a decodable key but no table privilege. A 200 means the key resolved
 * to a role, so every 42501 below is a real grant denial. Passes for either
 * key format — legacy `eyJ...` JWT or newer `sb_publishable_...`.
 */
async function assertAnonKeyReachesTheGrantCheck(): Promise<void> {
  const res = await request('/rest/v1/', { apiKey: anonKey! });
  if (res.ok) return;
  throw new Error(
    `SUPABASE_ANON_KEY was rejected by PostgREST before any table was consulted, so this ` +
      `suite cannot prove anything about RLS: HTTP ${res.status} ${await res.text()} — ` +
      `re-copy ANON_KEY from \`npx supabase status\` into .env.`
  );
}

async function seedOneRowPerTable(): Promise<void> {
  const created = await request('/auth/v1/admin/users', {
    apiKey: serviceRoleKey!,
    method: 'POST',
    body: JSON.stringify({ email: probeEmail, password: probePassword, email_confirm: true }),
  });
  if (!created.ok) throw new Error(`probe user creation failed: HTTP ${created.status}`);
  probeUserId = ((await created.json()) as { id: string }).id;

  const signedIn = await request('/auth/v1/token?grant_type=password', {
    apiKey: anonKey!,
    method: 'POST',
    body: JSON.stringify({ email: probeEmail, password: probePassword }),
  });
  if (!signedIn.ok) throw new Error(`probe user sign-in failed: HTTP ${signedIn.status}`);
  probeUserJwt = ((await signedIn.json()) as { access_token: string }).access_token;

  await insertAsServiceRole('callouts', {
    message_id: probeMessageId,
    channel_id: 'rls-probe-channel',
    author_name: 'rls-probe',
    content: 'BTO $QQQ 710p 06/08 0.97',
    timestamp: new Date(runId).toISOString(),
  });
  await insertAsServiceRole('trades', {
    user_id: probeUserId,
    message_id: probeMessageId,
    kind: 'submitted',
    reason: 'rls probe row',
    ticker: 'QQQ',
    action: 'buy',
  });
  await insertAsServiceRole('settings', { user_id: probeUserId, payload: { maxTradesPerDay: 10 } });
  await insertAsServiceRole('allowed_emails', { email: probeEmail });
  await insertAsServiceRole('broker_connections', {
    user_id: probeUserId,
    encrypted_tokens: 'cHJvYmUtY2lwaGVydGV4dA==',
  });
  await insertAsServiceRole('callers', {
    author_id: probeMessageId,
    display_name: 'rls-probe',
    last_seen_at: new Date(runId).toISOString(),
  });
}

async function deleteProbeFixtures(): Promise<void> {
  // Deleting the user cascades trades, settings and broker_connections.
  if (probeUserId) {
    await request(`/auth/v1/admin/users/${probeUserId}`, { apiKey: serviceRoleKey!, method: 'DELETE' });
  }
  await request(`/rest/v1/callouts?message_id=eq.${probeMessageId}`, {
    apiKey: serviceRoleKey!,
    method: 'DELETE',
  });
  await request(`/rest/v1/allowed_emails?email=eq.${probeEmail}`, {
    apiKey: serviceRoleKey!,
    method: 'DELETE',
  });
  await request(`/rest/v1/callers?author_id=eq.${probeMessageId}`, {
    apiKey: serviceRoleKey!,
    method: 'DELETE',
  });
}

describe.skipIf(!CONFIGURED)('supabase default-deny', () => {
  beforeAll(assertAnonKeyReachesTheGrantCheck);
  beforeAll(seedOneRowPerTable);
  afterAll(deleteProbeFixtures);

  it.each(TABLES)('service_role reads a real row from %s', async (table) => {
    const res = await request(`/rest/v1/${table}?select=*`, { apiKey: serviceRoleKey! });

    expect(res.status).toBe(200);
    expect((await res.json()) as unknown[]).not.toHaveLength(0);
  });

  it.each(TABLES)('the anon key cannot read %s', async (table) => {
    const res = await request(`/rest/v1/${table}?select=*`, { apiKey: anonKey! });

    expect(res.ok).toBe(false);
    expect((await res.json()) as PostgrestError).toMatchObject({ code: '42501' });
  });

  it.each(TABLES)('a logged-in user cannot read %s', async (table) => {
    const res = await request(`/rest/v1/${table}?select=*`, { apiKey: anonKey!, token: probeUserJwt });

    expect(res.ok).toBe(false);
    expect((await res.json()) as PostgrestError).toMatchObject({ code: '42501' });
  });

  it('the anon key cannot write either', async () => {
    const res = await request('/rest/v1/allowed_emails', {
      apiKey: anonKey!,
      method: 'POST',
      body: JSON.stringify({ email: `attacker-${runId}@example.com` }),
    });

    expect(res.ok).toBe(false);
    expect((await res.json()) as PostgrestError).toMatchObject({ code: '42501' });
  });
});
