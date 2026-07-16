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
  },
  isAllowed: (v: string, allowlist: readonly string[]) =>
    allowlist.length === 0 || allowlist.includes(v),
}));

import { createCalloutHistory, type RestMessage } from '../callouts.js';

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
