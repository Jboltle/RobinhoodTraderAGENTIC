/**
 * createCalloutHistory resilience: stale-cache fallback and failure cooldown.
 *   - failure after a prior success serves stale data, no refetch during cooldown
 *   - cold failure (no prior success) still throws
 *   - after cooldown expiry a new Discord fetch is attempted
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/config.js', () => ({
  config: {
    discordBotToken: 'test-token',
    discordAllowedChannelIds: ['chan-1'],
    discordAllowedAuthorIds: [],
    discordForwardChannelId: null,
  },
  isAllowed: (v: string, allowlist: readonly string[]) =>
    allowlist.length === 0 || allowlist.includes(v),
}));

import { buildMirrorPayload } from '../../bot/messageAssembly.js';
import { config } from '../../shared/config.js';
import type { DiscordEnvelope } from '../../shared/types.js';
import { createCalloutHistory, parseMirrorMessage, type RestMessage } from '../callouts.js';

// The real config is `as const`; the mock above is a plain mutable object.
const mutableConfig = config as { discordForwardChannelId: string | null };

const NOW = new Date('2026-07-16T12:00:00');

const MESSAGE: RestMessage = {
  id: 'msg-1',
  channel_id: 'chan-1',
  type: 0,
  content: 'BTO AAPL 220c',
  timestamp: new Date('2026-07-16T10:00:00').toISOString(),
  author: { id: 'author-1', username: 'caller', global_name: 'Caller' },
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 });
// 500, not 429: discordGet retries 429 with a real setTimeout sleep.
const serverError = () => new Response('{}', { status: 500 });

/** fetchImpl serving the channel-name lookup and one message page. */
const okFetch = () =>
  vi.fn(async (url: Parameters<typeof fetch>[0]) => {
    const path = url instanceof URL ? url.pathname : String(url);
    return path.endsWith('/messages') ? json([MESSAGE]) : json({ name: 'alerts' });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

const failFetch = () =>
  vi.fn(async () => serverError()) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  mutableConfig.discordForwardChannelId = null;
});

describe('createCalloutHistory failure handling', () => {
  it('serves stale data on failure and skips fetch during cooldown', async () => {
    const fetchMock = okFetch();
    const history = createCalloutHistory(fetchMock);

    const fresh = await history.getToday();
    expect(fresh).toHaveLength(1);
    const callsAfterSuccess = fetchMock.mock.calls.length;

    // Past the 60s TTL, Discord now fails.
    vi.setSystemTime(NOW.getTime() + 61_000);
    fetchMock.mockImplementation(async () => serverError());

    const stale = await history.getToday();
    expect(stale).toEqual(fresh);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterSuccess);

    // Within the 30s cooldown: stale again, no new Discord call.
    const callsAfterFailure = fetchMock.mock.calls.length;
    vi.setSystemTime(NOW.getTime() + 61_000 + 10_000);
    expect(await history.getToday()).toEqual(fresh);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFailure);
  });

  it('throws on cold failure (no prior success), rethrowing during cooldown without refetching', async () => {
    const fetchMock = failFetch();
    const history = createCalloutHistory(fetchMock);

    await expect(history.getToday()).rejects.toThrow('failed: 500');
    const callsAfterFailure = fetchMock.mock.calls.length;

    vi.setSystemTime(NOW.getTime() + 10_000);
    await expect(history.getToday()).rejects.toThrow('failed: 500');
    expect(fetchMock.mock.calls.length).toBe(callsAfterFailure);
  });

  it('attempts a new fetch after the cooldown expires', async () => {
    const fetchMock = failFetch();
    const history = createCalloutHistory(fetchMock);

    await expect(history.getToday()).rejects.toThrow('failed: 500');
    const callsAfterFailure = fetchMock.mock.calls.length;

    vi.setSystemTime(NOW.getTime() + 31_000);
    fetchMock.mockImplementation(async (url: Parameters<typeof fetch>[0]) => {
      const path = url instanceof URL ? url.pathname : String(url);
      return path.endsWith('/messages') ? json([MESSAGE]) : json({ name: 'alerts' });
    });

    const messages = await history.getToday();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFailure);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.messageId).toBe('msg-1');
  });
});

const ENVELOPE: DiscordEnvelope = {
  messageId: '111222333',
  channelId: '444555666',
  guildId: null,
  authorId: '777888999',
  authorName: 'Caller',
  content: 'BTO AAPL 220c\nsmall size',
  timestamp: new Date('2026-07-16T10:00:00').toISOString(),
  embeds: [],
};

/** Wrap mirror-payload content as the bot-authored REST message the funnel serves. */
const mirrorRestMessage = (content: string): RestMessage => ({
  id: 'mirror-1',
  channel_id: 'funnel-1',
  type: 0,
  content,
  timestamp: new Date('2026-07-16T10:00:05').toISOString(),
  author: { id: 'bot-1', username: 'trader-bot' },
});

describe('parseMirrorMessage', () => {
  // Pins parseMirrorMessage to the bot's real header format: a change to
  // buildMirrorPayload must fail this round-trip loudly.
  it('round-trips buildMirrorPayload output back to the original callout', () => {
    const payload = buildMirrorPayload(ENVELOPE);
    const parsed = parseMirrorMessage(mirrorRestMessage(payload.content));

    expect(parsed).not.toBeNull();
    expect(parsed!.messageId).toBe(ENVELOPE.messageId);
    expect(parsed!.channelId).toBe(ENVELOPE.channelId);
    expect(parsed!.authorName).toBe(ENVELOPE.authorName);
    expect(parsed!.content).toBe(ENVELOPE.content);
  });

  it('returns null for a non-mirror message in the funnel', () => {
    expect(parseMirrorMessage(mirrorRestMessage('gm everyone, nice fill'))).toBeNull();
  });
});

describe('getToday funnel path', () => {
  it('fetches only the funnel channel and resolves source channel names', async () => {
    mutableConfig.discordForwardChannelId = 'funnel-1';
    const mirror = mirrorRestMessage(buildMirrorPayload(ENVELOPE).content);

    const fetchMock = vi.fn(async (url: Parameters<typeof fetch>[0]) => {
      const path = url instanceof URL ? url.pathname : String(url);
      return path.endsWith('/messages') ? json([mirror]) : json({ name: 'source-alerts' });
    }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

    const messages = await createCalloutHistory(fetchMock).getToday();

    const messageFetchUrls = fetchMock.mock.calls
      .map((call: unknown[]) => String(call[0]))
      .filter((u: string) => u.endsWith('/messages') || u.includes('/messages?'));
    expect(messageFetchUrls.length).toBeGreaterThan(0);
    for (const url of messageFetchUrls) expect(url).toContain('/channels/funnel-1/messages');

    expect(messages).toHaveLength(1);
    expect(messages[0]!.messageId).toBe(ENVELOPE.messageId);
    expect(messages[0]!.channelId).toBe(ENVELOPE.channelId);
    expect(messages[0]!.channelName).toBe('source-alerts');
  });
});
