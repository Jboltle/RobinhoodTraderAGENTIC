/**
 * Bot message assembly tests — verify Discord messages are enriched correctly
 * before forwarding to the trader webhook.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Message } from 'discord.js';
import { buildEnvelope, buildMessageContent, buildReplyPrefix } from '../messageAssembly.js';

// ---------------------------------------------------------------------------
// Minimal discord.js Message mock
// ---------------------------------------------------------------------------

interface MockMessageOpts {
  content?: string;
  id?: string;
  channelId?: string;
  guildId?: string | null;
  createdTimestamp?: number;
  author?: { id: string; username: string; bot?: boolean };
  member?: { displayName: string } | null;
  reference?: { messageId: string } | null;
  stickers?: Map<string, { name: string }>;
  attachments?: Map<string, { url: string }>;
  fetchReference?: () => Promise<Partial<Message>>;
}

function mockMessage(opts: MockMessageOpts = {}): Message {
  const stickers = opts.stickers ?? new Map();
  const attachments = opts.attachments ?? new Map();
  const member =
    opts.member === null
      ? null
      : (opts.member ?? { displayName: 'Demon Alerts' });

  return {
    id: opts.id ?? 'msg-001',
    channelId: opts.channelId ?? 'chan-001',
    guildId: opts.guildId ?? 'guild-001',
    createdTimestamp: opts.createdTimestamp ?? Date.parse('2026-06-09T14:27:00.000Z'),
    content: opts.content ?? '',
    author: opts.author ?? { id: 'author-001', username: 'Demon Alerts', bot: false },
    member,
    reference: opts.reference ?? null,
    stickers,
    attachments,
    fetchReference: opts.fetchReference ?? vi.fn(),
  } as unknown as Message;
}

// ---------------------------------------------------------------------------
// buildReplyPrefix
// ---------------------------------------------------------------------------

describe('buildReplyPrefix', () => {
  it('returns empty string when message is not a reply', async () => {
    const msg = mockMessage({ content: 'BANG! @Pro' });
    expect(await buildReplyPrefix(msg)).toBe('');
  });

  it('includes referenced author and snippet for reply threads', async () => {
    const msg = mockMessage({
      content: 'Still in $SBUX ! @Pro',
      reference: { messageId: 'ref-001' },
      fetchReference: vi.fn().mockResolvedValue({
        content: 'BTO $SBUX 103c 06/12 @0.55',
        member: { displayName: 'Namrood' },
        author: { username: 'Namrood' },
        attachments: new Map(),
        embeds: [],
      }),
    });

    const prefix = await buildReplyPrefix(msg);
    expect(prefix).toContain('replying to **Namrood**');
    expect(prefix).toContain('BTO $SBUX 103c 06/12 @0.55');
    expect(prefix.startsWith('> ↪️')).toBe(true);
  });

  it('shows [attachment] when referenced message has no text', async () => {
    const msg = mockMessage({
      reference: { messageId: 'ref-002' },
      fetchReference: vi.fn().mockResolvedValue({
        content: '',
        member: null,
        author: { username: 'Demon Alerts' },
        attachments: new Map([['1', { url: 'https://cdn.example/img.png' }]]),
        embeds: [],
      }),
    });

    const prefix = await buildReplyPrefix(msg);
    expect(prefix).toContain('[attachment]');
  });

  it('falls back gracefully when fetchReference fails', async () => {
    const msg = mockMessage({
      reference: { messageId: 'ref-missing' },
      fetchReference: vi.fn().mockRejectedValue(new Error('Unknown Message')),
    });

    expect(await buildReplyPrefix(msg)).toBe('> ↪️ replying to an earlier message\n');
  });
});

// ---------------------------------------------------------------------------
// buildMessageContent
// ---------------------------------------------------------------------------

describe('buildMessageContent', () => {
  it('passes through plain BTO text unchanged', async () => {
    const msg = mockMessage({ content: 'BTO $QQQ 710p 06/08 0.97\n\nRISKY SIZE APPROPRIATE @Pro' });
    expect(await buildMessageContent(msg)).toBe(
      'BTO $QQQ 710p 06/08 0.97\n\nRISKY SIZE APPROPRIATE @Pro'
    );
  });

  it('appends attachment URLs after body (image messages)', async () => {
    const msg = mockMessage({
      content: 'BANG! @Pro',
      attachments: new Map([['att-1', { url: 'https://cdn.discordapp.com/attachments/123/chart.png' }]]),
    });

    const content = await buildMessageContent(msg);
    expect(content).toContain('BANG! @Pro');
    expect(content).toContain('https://cdn.discordapp.com/attachments/123/chart.png');
  });

  it('appends sticker names', async () => {
    const msg = mockMessage({
      content: 'BTFDD STONKS ONLY GO UP 🚀🚀 @Pro',
      stickers: new Map([['s1', { name: 'rocket' }]]),
    });

    const content = await buildMessageContent(msg);
    expect(content).toContain('🏷️ sticker: :rocket:');
    expect(content).toContain('BTFDD STONKS ONLY GO UP');
  });

  it('combines reply prefix + body + attachments for trim messages', async () => {
    const msg = mockMessage({
      content: [
        '@Pro',
        'Close or Trim & Set SL to BE',
        'TRIM',
        '',
        'QQQ 707C 2026-06-11',
        '1.5900  →  1.75   P/L: +10.06% ($16.00)',
      ].join('\n'),
      reference: { messageId: 'ref-trim' },
      fetchReference: vi.fn().mockResolvedValue({
        content: 'BTO $QQQ 707C earlier',
        member: { displayName: 'Namrood' },
        author: { username: 'Namrood' },
        attachments: new Map(),
        embeds: [],
      }),
    });

    const content = await buildMessageContent(msg);
    expect(content).toContain('replying to **Namrood**');
    expect(content).toContain('TRIM');
    expect(content).toContain('QQQ 707C 2026-06-11');
  });
});

// ---------------------------------------------------------------------------
// buildEnvelope
// ---------------------------------------------------------------------------

describe('buildEnvelope', () => {
  it('produces a valid DiscordEnvelope from a message', () => {
    const msg = mockMessage({
      id: 'discord-msg-999',
      content: 'BTO $QQQ 710p 06/08 0.97',
      author: { id: 'user-42', username: 'Demon Alerts' },
      member: { displayName: 'Demon Alerts' },
      createdTimestamp: Date.parse('2026-06-09T14:27:00.000Z'),
    });

    const envelope = buildEnvelope(msg, 'BTO $QQQ 710p 06/08 0.97');

    expect(envelope).toEqual({
      messageId: 'discord-msg-999',
      channelId: 'chan-001',
      guildId: 'guild-001',
      authorId: 'user-42',
      authorName: 'Demon Alerts',
      content: 'BTO $QQQ 710p 06/08 0.97',
      timestamp: '2026-06-09T14:27:00.000Z',
    });
  });

  it('uses username when member displayName is unavailable', () => {
    const msg = mockMessage({
      author: { id: 'user-99', username: 'Namrood-Trades' },
      member: null,
    });

    const envelope = buildEnvelope(msg, 'TRIM TRIM');
    expect(envelope.authorName).toBe('Namrood-Trades');
  });
});
