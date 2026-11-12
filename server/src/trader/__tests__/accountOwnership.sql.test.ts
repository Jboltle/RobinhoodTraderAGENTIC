/**
 * Opt-in: the account ownership SQL in ../db.ts, run against a real Postgres.
 *
 * Every other suite runs on the in-memory fake (fakeDb.ts), which implements
 * ownership itself, so nothing there notices if a `where` or a join condition
 * is dropped from the real statements. This one runs those statements, with
 * two users, and is SKIPPED unless it is given a database of its own:
 *
 *   ACCOUNT_OWNERSHIP_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:54877/ownership_test \
 *     npx vitest run src/trader/__tests__/accountOwnership.sql.test.ts
 *
 * It only ever uses that variable, never SUPABASE_DB_URL, and refuses a host
 * that is not this machine. The database needs the schema and nothing else; a
 * throwaway one from the PostgreSQL binaries already installed (from the repo
 * root):
 *
 *   initdb -D /tmp/pg-ownership/data -U postgres --auth=trust
 *   pg_ctl -D /tmp/pg-ownership/data -l /tmp/pg-ownership/log -w start \
 *     -o "-p 54877 -c listen_addresses=127.0.0.1 -c unix_socket_directories=/tmp/pg-ownership"
 *   URL=postgresql://postgres@127.0.0.1:54877/ownership_test
 *   psql postgresql://postgres@127.0.0.1:54877/postgres -X -c "create database ownership_test"
 *   psql "$URL" -X -1 -v ON_ERROR_STOP=1 -f server/src/trader/__tests__/fixtures/supabasePrelude.sql
 *   for f in supabase/migrations/*.sql; do psql "$URL" -X -1 -v ON_ERROR_STOP=1 -f "$f" || break; done
 *
 * and afterwards: pg_ctl -D /tmp/pg-ownership/data stop && rm -rf /tmp/pg-ownership
 *
 * The test adds two users of its own and removes them when it is done.
 */

import { randomUUID } from 'node:crypto';

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createTraderDb, type TraderDb } from '../db.js';

const DATABASE_URL = process.env.ACCOUNT_OWNERSHIP_TEST_DATABASE_URL?.trim() ?? '';
const RUN = DATABASE_URL !== '';

const THIS_MACHINE = new Set(['localhost', '127.0.0.1']);
if (RUN && !THIS_MACHINE.has(new URL(DATABASE_URL).hostname)) {
  throw new Error('ACCOUNT_OWNERSHIP_TEST_DATABASE_URL must point at a throwaway database on this machine');
}

// createTraderDb() connects to config.supabaseDbUrl. Point it at this test's
// own database, so the one in .env is never the one these statements run on.
vi.mock('../../shared/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/config.js')>();
  return {
    ...actual,
    config: {
      ...actual.config,
      supabaseDbUrl: process.env.ACCOUNT_OWNERSHIP_TEST_DATABASE_URL?.trim() ?? '',
    },
  };
});

const SESSION_LIFETIME_MS = 60_000;

/** One user of this test: a live session token and the account they signed up with. */
interface TestUser {
  id: string;
  email: string;
  token: string;
  robinhoodAccountId: string;
}

describe.skipIf(!RUN)('account ownership, in the real SQL', () => {
  let db: TraderDb;
  let sql: postgres.Sql;
  /** Has a Robinhood account and a paper one. */
  let owner: TestUser;
  let ownerPaperAccountId: string;
  /** Has a Robinhood account; signed up after `owner`. */
  let other: TestUser;

  const selectedAccountId = async (user: TestUser): Promise<string | null> => {
    const [row] = await sql<{ selected_account_id: string | null }[]>`
      select selected_account_id from public.users where id = ${user.id}`;
    return row?.selected_account_id ?? null;
  };

  /** Signs a new user up the way the server does, and opens a session for them. */
  const signUp = async (name: string): Promise<TestUser> => {
    const email = `${name}-${randomUUID()}@ownership.test`;
    await sql`insert into public.allowed_emails (email) values (${email})`;
    const user = await db.userForSignIn(email);
    if (!user) throw new Error(`could not create ${email}`);
    const token = randomUUID();
    await db.createSession(user.id, token, new Date(Date.now() + SESSION_LIFETIME_MS));
    const account = await db.getSelectedAccount(user.id);
    if (!account) throw new Error(`${email} has no account`);
    return { id: user.id, email, token, robinhoodAccountId: account.id };
  };

  beforeAll(async () => {
    sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
    db = createTraderDb();
    owner = await signUp('owner');
    other = await signUp('other');
    const [paper] = await sql<{ id: string }[]>`
      insert into public.accounts
        (user_id, adapter, institution, external_account_id, label, is_paper, adapter_data)
      values
        (${owner.id}, 'snaptrade', 'alpaca-paper', 'external-1', 'Alpaca Paper', true,
         ${sql.json({ connectionId: 'connection-1', institutionSlug: 'alpaca-paper', maskedAccountNumber: null })})
      returning id`;
    if (!paper) throw new Error('the paper account was not created');
    ownerPaperAccountId = paper.id;
  });

  afterAll(async () => {
    for (const user of [owner, other].filter(Boolean)) {
      await sql`delete from public.users where id = ${user.id}`;
      await sql`delete from public.allowed_emails where email = ${user.email}`;
    }
    await sql.end();
  });

  it("selecting another user's account is refused and moves no one's selection", async () => {
    expect(await db.selectAccount(owner.id, other.robinhoodAccountId)).toBe(false);
    expect(await db.selectAccount(other.id, ownerPaperAccountId)).toBe(false);
    // Neither a well-formed id that names nothing nor one that is no uuid.
    expect(await db.selectAccount(owner.id, randomUUID())).toBe(false);
    expect(await db.selectAccount(owner.id, 'not-a-uuid')).toBe(false);

    expect(await selectedAccountId(owner)).toBe(owner.robinhoodAccountId);
    expect(await selectedAccountId(other)).toBe(other.robinhoodAccountId);
  });

  it("selecting one's own account moves that user's selection only", async () => {
    expect(await db.selectAccount(owner.id, ownerPaperAccountId)).toBe(true);
    expect(await selectedAccountId(owner)).toBe(ownerPaperAccountId);
    expect(await selectedAccountId(other)).toBe(other.robinhoodAccountId);
    expect((await db.getSelectedAccount(owner.id))?.id).toBe(ownerPaperAccountId);
    expect((await db.verifyAccessToken(owner.token))?.account?.id).toBe(ownerPaperAccountId);

    expect(await db.selectAccount(owner.id, owner.robinhoodAccountId)).toBe(true);
    expect(await selectedAccountId(owner)).toBe(owner.robinhoodAccountId);
  });

  it('each user is listed, and resolved, their own accounts only', async () => {
    const expected = [
      { user: owner, accountIds: [owner.robinhoodAccountId, ownerPaperAccountId] },
      { user: other, accountIds: [other.robinhoodAccountId] },
    ];
    for (const { user, accountIds } of expected) {
      const listed = await db.listAccounts(user.id);
      expect(listed.accounts.map(({ account }) => account.id)).toEqual(accountIds);
      expect(listed.unusable).toEqual([]);

      // The user who signed up second is the one a missing `where` shows up on.
      const selected = await db.getSelectedAccount(user.id);
      expect(selected).toMatchObject({ id: user.robinhoodAccountId, userId: user.id });

      const session = await db.verifyAccessToken(user.token);
      expect(session?.user).toEqual({ id: user.id, email: user.email });
      expect(session?.account).toMatchObject({ id: user.robinhoodAccountId, userId: user.id });
    }
  });

  // Nothing in the schema stops users.selected_account_id from naming another
  // user's account (a plain foreign key). The statements must not follow it.
  it("a selection that names another user's account is never followed", async () => {
    const ownersOwn = { id: owner.robinhoodAccountId, userId: owner.id };
    await sql`update public.users set selected_account_id = ${other.robinhoodAccountId} where id = ${owner.id}`;
    try {
      const session = await db.verifyAccessToken(owner.token);
      expect(session?.user.id).toBe(owner.id);
      expect(session?.account).toMatchObject(ownersOwn);
      expect(await db.getSelectedAccount(owner.id)).toMatchObject(ownersOwn);
      // And the other user is still resolved their own.
      expect((await db.verifyAccessToken(other.token))?.account?.id).toBe(other.robinhoodAccountId);
      expect((await db.getSelectedAccount(other.id))?.id).toBe(other.robinhoodAccountId);
    } finally {
      await sql`update public.users set selected_account_id = ${owner.robinhoodAccountId} where id = ${owner.id}`;
    }
  });
});
