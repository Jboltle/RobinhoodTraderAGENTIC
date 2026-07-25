/**
 * Catch-up-on-wake: the callouts table is the idempotency ledger, and the
 * two-minute staleness window decides whether a missed callout is traded or
 * merely recorded.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CalloutMessage } from '../callouts.js';
import { catchUpOnWake, STALENESS_WINDOW_MS } from '../catchup.js';
import { createFakeDb, type FakeDb } from './fakeDb.js';
import type { MessageProcessor, ProcessOptions } from '../pipeline/index.js';

const NOW = new Date('2026-07-20T15:00:00.000Z');

const messageAt = (messageId: string, msAgo: number): CalloutMessage => ({
  messageId,
  channelId: 'chan-1',
  channelName: 'alerts',
  authorId: 'author-1',
  authorName: 'Demon Alerts',
  timestamp: new Date(NOW.getTime() - msAgo).toISOString(),
  content: `callout ${messageId}`,
  embeds: [],
});

let db: FakeDb;
let process: ReturnType<typeof vi.fn>;
let processor: MessageProcessor;

const optionsFor = (messageId: string): ProcessOptions =>
  process.mock.calls.find((call) => call[0].messageId === messageId)![1] as ProcessOptions;

beforeEach(() => {
  db = createFakeDb();
  process = vi.fn().mockResolvedValue(undefined);
  processor = { process: process as MessageProcessor['process'] };
});

const run = (messages: CalloutMessage[]) =>
  catchUpOnWake({ db, processor, fetchHistory: async () => messages }, NOW);

describe('catchUpOnWake', () => {
  it('processes a fresh callout normally', async () => {
    const summary = await run([messageAt('fresh', 30_000)]);

    expect(summary).toMatchObject({ processed: 1, missed: 0, alreadySeen: 0 });
    expect(optionsFor('fresh').missed).toBe(false);
  });

  it('records anything past the staleness window as missed', async () => {
    const summary = await run([messageAt('stale', STALENESS_WINDOW_MS + 1000)]);

    expect(summary).toMatchObject({ processed: 0, missed: 1 });
    expect(optionsFor('stale').missed).toBe(true);
  });

  it('treats the window boundary as still tradable', async () => {
    await run([messageAt('boundary', STALENESS_WINDOW_MS)]);
    expect(optionsFor('boundary').missed).toBe(false);
  });

  it('skips callouts the pipeline has already recorded', async () => {
    db.seedCallout({
      messageId: 'seen',
      channelId: 'chan-1',
      channelName: 'alerts',
      authorName: 'Demon Alerts',
      content: 'callout seen',
      timestamp: new Date(NOW.getTime() - 30_000).toISOString(),
      embeds: [],
      parse: null,
      parseStatus: 'parsed',
    });

    const summary = await run([messageAt('seen', 30_000), messageAt('new', 30_000)]);

    expect(summary).toMatchObject({ processed: 1, alreadySeen: 1 });
    expect(process.mock.calls.map((call) => call[0].messageId)).toEqual(['new']);
  });

  it('passes the resolved channel name through to the callout row', async () => {
    await run([messageAt('fresh', 30_000)]);
    expect(optionsFor('fresh').channelName).toBe('alerts');
  });

  it('replays in the order the messages were posted', async () => {
    await run([messageAt('first', 90_000), messageAt('second', 30_000)]);
    expect(process.mock.calls.map((call) => call[0].messageId)).toEqual(['first', 'second']);
  });
});
