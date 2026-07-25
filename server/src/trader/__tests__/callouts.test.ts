/**
 * Discord history reading for catch-up: the funnel-channel path, the
 * per-channel path, and the mirror-header round trip that ties this module to
 * the bot's payload format.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

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
import { fetchTodaysCallouts, parseMirrorMessage, type RestMessage } from '../callouts.js';

// The real config is `as const`; the mock above is a plain mutable object.
const mutableConfig = config as { discordForwardChannelId: string | null };

const SINCE = new Date('2026-07-16T00:00:00');

const MESSAGE: RestMessage = {
  id: 'msg-1',
  channel_id: 'chan-1',
  type: 0,
  content: 'BTO AAPL 220c',
  timestamp: new Date('2026-07-16T10:00:00').toISOString(),
  author: { id: 'author-1', username: 'caller', global_name: 'Caller' },
};

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

/** fetchImpl serving the channel-name lookup and one message page. */
const fetchServing = (messages: RestMessage[], channelName = 'alerts') =>
  vi.fn(async (url: Parameters<typeof fetch>[0]) => {
    const path = url instanceof URL ? url.pathname : String(url);
    return path.endsWith('/messages') ? json(messages) : json({ name: channelName });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

afterEach(() => {
  mutableConfig.discordForwardChannelId = null;
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
    const parsed = parseMirrorMessage(mirrorRestMessage(buildMirrorPayload(ENVELOPE).content));

    expect(parsed).not.toBeNull();
    expect(parsed!.messageId).toBe(ENVELOPE.messageId);
    expect(parsed!.channelId).toBe(ENVELOPE.channelId);
    expect(parsed!.authorId).toBe(ENVELOPE.authorId);
    expect(parsed!.authorName).toBe(ENVELOPE.authorName);
    expect(parsed!.content).toBe(ENVELOPE.content);
  });

  it('returns null for a non-mirror message in the funnel', () => {
    expect(parseMirrorMessage(mirrorRestMessage('gm everyone, nice fill'))).toBeNull();
  });
});

describe('fetchTodaysCallouts', () => {
  it('reads the allowlisted channels and resolves their names', async () => {
    const messages = await fetchTodaysCallouts(fetchServing([MESSAGE]), SINCE);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      messageId: 'msg-1',
      channelId: 'chan-1',
      channelName: 'alerts',
      authorId: 'author-1',
      authorName: 'Caller',
      content: 'BTO AAPL 220c',
    });
  });

  it('skips system messages and messages from non-allowlisted authors', async () => {
    const systemMessage: RestMessage = { ...MESSAGE, id: 'msg-system', type: 6 };
    const messages = await fetchTodaysCallouts(fetchServing([systemMessage]), SINCE);
    expect(messages).toEqual([]);
  });

  it('fetches only the funnel channel and resolves source channel names', async () => {
    mutableConfig.discordForwardChannelId = 'funnel-1';
    const mirror = mirrorRestMessage(buildMirrorPayload(ENVELOPE).content);
    const fetchMock = fetchServing([mirror], 'source-alerts');

    const messages = await fetchTodaysCallouts(fetchMock, SINCE);

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

  it('returns messages oldest-first so catch-up replays them in order', async () => {
    const older: RestMessage = {
      ...MESSAGE,
      id: 'older',
      timestamp: new Date('2026-07-16T09:00:00').toISOString(),
    };
    const newer: RestMessage = {
      ...MESSAGE,
      id: 'newer',
      timestamp: new Date('2026-07-16T11:00:00').toISOString(),
    };

    const messages = await fetchTodaysCallouts(fetchServing([newer, older]), SINCE);
    expect(messages.map((m) => m.messageId)).toEqual(['older', 'newer']);
  });

  it('propagates a Discord failure so startup can log it', async () => {
    const failing = vi.fn(async () => new Response('{}', { status: 500 })) as unknown as typeof fetch;
    await expect(fetchTodaysCallouts(failing, SINCE)).rejects.toThrow('failed: 500');
  });
});
