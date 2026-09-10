import { describe, expect, it } from 'vitest';

import { backfillCalloutAuthors, type fetchTodaysCallouts } from '../callouts.js';
import type { StoredCallout } from '../db.js';
import type { DiscordEnvelope } from '../../shared/types.js';
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

const historyMessage = (messageId: string, authorId: string): DiscordEnvelope => ({
  messageId,
  channelId: 'c1',
  channelName: null,
  guildId: null,
  authorId,
  authorName: 'Trader Dan',
  authorAvatarUrl: 'https://cdn.discordapp.com/embed/avatars/0.png',
  timestamp: '2026-07-29T12:00:00.000Z',
  content: 'BUY SPY',
  embeds: [],
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
