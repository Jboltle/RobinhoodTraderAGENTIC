/**
 * The consumer loop: unprocessed `messages` rows drain into the pipeline in
 * order, staleness lands as missed, recap channels route to the recaps table,
 * and a crash replay never re-runs the fan-out.
 */
import { describe, expect, it, vi } from 'vitest';

import type { DiscordEnvelope } from '../../shared/types.js';
import type { MessageProcessor, ProcessOptions } from '../pipeline/index.js';
import { STALENESS_WINDOW_MS, buildEnvelope, drainOnce } from '../poller.js';
import { buildStoredRecap } from '../recaps/sweep.js';
import { createFakeDb, type FakeDb } from './fakeDb.js';

const NOW = new Date('2026-09-21T18:00:00.000Z');
const FRESH_AT = new Date(NOW.getTime() - 10_000).toISOString();
const STALE_AT = new Date(NOW.getTime() - STALENESS_WINDOW_MS - 60_000).toISOString();
const RECAP_CHANNEL = 'recap-chan';

interface Recorded {
  readonly envelope: DiscordEnvelope;
  readonly options: ProcessOptions | undefined;
}

function makeSetup(): {
  db: FakeDb;
  processor: MessageProcessor;
  processed: Recorded[];
  drain: () => Promise<number>;
} {
  const db = createFakeDb();
  const processed: Recorded[] = [];
  const processor: MessageProcessor = {
    async process(envelope, options) {
      processed.push({ envelope, options });
      // Mirror the real pipeline: the verdict is written during process().
      await db.setMessageDisposition(envelope.messageId, 'not_callout', null);
    },
    enqueue: (_userId, run) => run(),
  };
  const drain = () =>
    drainOnce({ db, processor, recapChannelIds: [RECAP_CHANNEL], now: () => NOW });
  return { db, processor, processed, drain };
}

describe('drainOnce', () => {
  it('hands a fresh row to the pipeline as a synthesized envelope, then marks it processed', async () => {
    const { db, processed, drain } = makeSetup();
    db.seedMessage({
      messageId: 'm1',
      sentAt: FRESH_AT,
      channelId: 'chan-001',
      channelName: 'alerts',
      authorId: 'author-001',
      authorName: 'Demon Alerts',
      authorAvatarUrl: 'https://cdn.example/a.png',
      content: 'BTO $QQQ 710p 0.97',
      embeds: [{ title: 'card' }],
    });

    expect(await drain()).toBe(1);

    expect(processed).toHaveLength(1);
    expect(processed[0]!.envelope).toMatchObject({
      messageId: 'm1',
      channelId: 'chan-001',
      channelName: 'alerts',
      authorId: 'author-001',
      authorName: 'Demon Alerts',
      authorAvatarUrl: 'https://cdn.example/a.png',
      content: 'BTO $QQQ 710p 0.97',
      timestamp: FRESH_AT,
      embeds: [{ title: 'card' }],
    });
    expect(processed[0]!.options).toMatchObject({ missed: false });
    expect(db.getMessage('m1')?.processedAt).not.toBeNull();
  });

  it('flags rows older than the staleness window as missed', async () => {
    const { db, processed, drain } = makeSetup();
    db.seedMessage({ messageId: 'old', sentAt: STALE_AT });

    await drain();

    expect(processed[0]!.options).toMatchObject({ missed: true });
    expect(db.getMessage('old')?.processedAt).not.toBeNull();
  });

  it('drains oldest-first and sequentially', async () => {
    const { db, processed, drain } = makeSetup();
    db.seedMessage({ messageId: 'newer', sentAt: FRESH_AT });
    db.seedMessage({
      messageId: 'older',
      sentAt: new Date(NOW.getTime() - 20_000).toISOString(),
    });

    expect(await drain()).toBe(2);
    expect(processed.map((p) => p.envelope.messageId)).toEqual(['older', 'newer']);
  });

  it('archives a message deleted before processing as missed, without fan-out', async () => {
    const { db, processed, drain } = makeSetup();
    db.seedMessage({ messageId: 'gone', sentAt: FRESH_AT, deletedAt: FRESH_AT });

    await drain();

    expect(processed).toEqual([]);
    const row = db.getMessage('gone');
    expect(row?.disposition).toBe('missed');
    expect(row?.processedAt).not.toBeNull();
  });

  it('finishes a crash-replayed row without re-running the fan-out', async () => {
    const { db, processed, drain } = makeSetup();
    // disposition written, processed_at never set: the previous run died
    // mid fan-out. Re-running it is the one path to a double trade.
    db.seedMessage({ messageId: 'replay', sentAt: FRESH_AT, disposition: 'callout' });

    await drain();

    expect(processed).toEqual([]);
    expect(db.getMessage('replay')?.processedAt).not.toBeNull();
  });

  it('routes recap-channel rows to the recaps table, never to the pipeline', async () => {
    const { db, processed, drain } = makeSetup();
    const content = 'Daily recap: +3.2% on QQQ';
    // Pre-store the identical recap so the content-hash dedupe makes this
    // ingest a no-op — the test then never touches the insights LLM path.
    await db.saveRecap(
      buildStoredRecap({
        messageId: 'r1',
        channelId: RECAP_CHANNEL,
        postedAt: FRESH_AT,
        content,
      })
    );
    db.seedMessage({ messageId: 'r1', sentAt: FRESH_AT, channelId: RECAP_CHANNEL, content });

    await drain();

    expect(processed).toEqual([]);
    const row = db.getMessage('r1');
    expect(row?.disposition).toBe('recap');
    expect(row?.processedAt).not.toBeNull();
  });

  it('recap rows re-enter after a Listener edit reset (no replay guard for recaps)', async () => {
    const { db, processed, drain } = makeSetup();
    const content = 'Daily recap: corrected to +2.9% on QQQ';
    await db.saveRecap(
      buildStoredRecap({
        messageId: 'r2',
        channelId: RECAP_CHANNEL,
        postedAt: FRESH_AT,
        content,
      })
    );
    // The Listener's edit reset clears processed_at but a previous run had
    // already stamped 'recap'; the row must still route through the ingest.
    db.seedMessage({
      messageId: 'r2',
      sentAt: FRESH_AT,
      channelId: RECAP_CHANNEL,
      content,
      disposition: 'recap',
    });

    await drain();

    expect(processed).toEqual([]);
    expect(db.getMessage('r2')?.processedAt).not.toBeNull();
  });

  it('leaves a row unprocessed when the pipeline throws, so the next tick retries', async () => {
    const db = createFakeDb();
    const processor: MessageProcessor = {
      process: vi.fn().mockRejectedValue(new Error('transient db outage')),
      enqueue: (_userId, run) => run(),
    };
    db.seedMessage({ messageId: 'again', sentAt: FRESH_AT });

    await expect(
      drainOnce({ db, processor, recapChannelIds: [], now: () => NOW })
    ).rejects.toThrow('transient db outage');
    expect(db.getMessage('again')?.processedAt).toBeNull();
  });
});

describe('buildEnvelope', () => {
  it('never invents fields: nullables stay null', () => {
    const envelope = buildEnvelope({
      messageId: 'm',
      channelId: 'c',
      channelName: null,
      authorId: 'a',
      authorName: 'A',
      authorAvatarUrl: null,
      content: '',
      embeds: [],
      sentAt: FRESH_AT,
      deletedAt: null,
      disposition: null,
    });
    expect(envelope).toEqual({
      messageId: 'm',
      channelId: 'c',
      channelName: null,
      guildId: null,
      authorId: 'a',
      authorName: 'A',
      authorAvatarUrl: null,
      content: '',
      timestamp: FRESH_AT,
      embeds: [],
    });
  });
});
