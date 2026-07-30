import { describe, expect, it } from 'vitest';

import { backfillCalloutAuthors, seedMissingCallers } from '../callerBootstrap.js';
import type { CalloutMessage, fetchTodaysCallouts } from '../callouts.js';
import type { StoredCallout } from '../db.js';
import { createFakeDb } from './fakeDb.js';

const callout = (overrides: Partial<StoredCallout>): StoredCallout => ({
  messageId: 'm1',
  channelId: 'c1',
  channelName: null,
  authorId: null,
  authorName: 'Trader Dan',
  content: 'BUY SPY',
  timestamp: '2026-07-29T12:00:00.000Z',
  embeds: [],
  parse: null,
  parseStatus: 'parsed',
  ...overrides,
});

const historyMessage = (messageId: string, authorId: string): CalloutMessage => ({
  messageId,
  channelId: 'c1',
  channelName: null,
  authorId,
  authorName: 'Trader Dan',
  authorAvatarUrl: 'https://cdn.discordapp.com/embed/avatars/0.png',
  timestamp: '2026-07-29T12:00:00.000Z',
  content: 'BUY SPY',
  embeds: [],
});

describe('seedMissingCallers', () => {
  it('seeds only authors without a callers row, leaving existing rows untouched', async () => {
    const db = createFakeDb();
    await db.upsertCaller({
      authorId: '111',
      displayName: 'Live-Captured Name',
      avatarUrl: 'https://cdn.discordapp.com/avatars/111/abc.png',
      lastSeenAt: '2026-07-29T10:00:00.000Z',
    });

    const fetched: string[] = [];
    const fakeFetch = (async (url: string | URL) => {
      fetched.push(String(url));
      return {
        ok: true,
        json: async () => ({ username: 'newbie', global_name: 'New Caller', avatar: 'def' }),
      };
    }) as unknown as typeof fetch;

    const seeded = await seedMissingCallers(db, ['111', '222'], fakeFetch);

    expect(seeded).toBe(1);
    expect(fetched).toEqual(['https://discord.com/api/v10/users/222']);
    const callers = await db.listCallers();
    expect(callers).toHaveLength(2);
    expect(callers.find((c) => c.authorId === '111')?.displayName).toBe('Live-Captured Name');
    expect(callers.find((c) => c.authorId === '222')).toMatchObject({
      displayName: 'New Caller',
      avatarUrl: 'https://cdn.discordapp.com/avatars/222/def.png',
    });
  });

  it('skips an author Discord will not return, without throwing', async () => {
    const db = createFakeDb();
    const fakeFetch = (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;

    const seeded = await seedMissingCallers(db, ['333'], fakeFetch);

    expect(seeded).toBe(0);
    expect(await db.listCallers()).toHaveLength(0);
  });
});

describe('backfillCalloutAuthors', () => {
  it('fills author_id on null rows matched in history, from the oldest null row onward', async () => {
    const db = createFakeDb();
    db.seedCallout(callout({ messageId: 'old-null', timestamp: '2026-07-28T09:00:00.000Z' }));
    db.seedCallout(callout({ messageId: 'new-null', timestamp: '2026-07-29T12:00:00.000Z' }));
    db.seedCallout(callout({ messageId: 'has-author', authorId: '999' }));

    let sinceArg: Date | undefined;
    const fakeHistory = (async (_fetch?: typeof fetch, since?: Date) => {
      sinceArg = since;
      return [historyMessage('old-null', '111')];
    }) as typeof fetchTodaysCallouts;

    const updated = await backfillCalloutAuthors(db, fakeHistory);

    expect(updated).toBe(1);
    expect(sinceArg?.toISOString()).toBe('2026-07-28T09:00:00.000Z');
    expect((await db.getCallout('old-null'))?.authorId).toBe('111');
    // Not covered by history: stays null rather than being guessed.
    expect((await db.getCallout('new-null'))?.authorId).toBeNull();
    expect((await db.getCallout('has-author'))?.authorId).toBe('999');
  });

  it('does not read history at all when no rows are missing an author', async () => {
    const db = createFakeDb();
    db.seedCallout(callout({ messageId: 'has-author', authorId: '999' }));

    let historyCalls = 0;
    const fakeHistory = (async () => {
      historyCalls += 1;
      return [];
    }) as typeof fetchTodaysCallouts;

    expect(await backfillCalloutAuthors(db, fakeHistory)).toBe(0);
    expect(historyCalls).toBe(0);
  });
});
