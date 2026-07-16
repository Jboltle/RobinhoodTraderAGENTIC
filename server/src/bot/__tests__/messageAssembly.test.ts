/**
 * Bot message assembly tests — verify Discord messages are enriched correctly
 * before forwarding to the trader webhook.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Embed, Message } from 'discord.js';
import { DiscordEnvelopeSchema } from '../../shared/types.js';
import {
  buildEnvelope,
  buildMessageContent,
  buildMirrorPayload,
  buildReplyPrefix,
} from '../messageAssembly.js';
import { hasForwardableContent } from '../messageFilter.js';

// ---------------------------------------------------------------------------
// Minimal discord.js Message + Embed mocks
// ---------------------------------------------------------------------------

interface MockEmbedData {
  type?: string;
  author?: { name: string };
  title?: string;
  description?: string;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string };
  image?: { url: string };
  thumbnail?: { url: string };
  url?: string;
}

function mockEmbed(data: MockEmbedData): Embed {
  return {
    author: data.author ?? null,
    title: data.title ?? null,
    description: data.description ?? null,
    fields: data.fields ?? [],
    footer: data.footer ?? null,
    image: data.image ?? null,
    thumbnail: data.thumbnail ?? null,
    url: data.url ?? null,
    toJSON: () => data,
  } as unknown as Embed;
}

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
  embeds?: Embed[];
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
    embeds: opts.embeds ?? [],
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
      embeds: [],
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

// ---------------------------------------------------------------------------
// Embeds — flattening, envelope passthrough, mirror payload
// ---------------------------------------------------------------------------

const CALLOUT_CARD = mockEmbed({
  author: { name: 'Demon Alerts' },
  title: 'BTO $QQQ 710p 06/08',
  description: 'Entry @ 0.97 — RISKY SIZE APPROPRIATE',
});

describe('buildMessageContent with embeds', () => {
  it('flattens an embed-only message into forwardable text', async () => {
    const msg = mockMessage({ content: '', embeds: [CALLOUT_CARD] });

    const content = await buildMessageContent(msg);
    expect(content).toContain('Demon Alerts');
    expect(content).toContain('BTO $QQQ 710p 06/08');
    expect(content).toContain('Entry @ 0.97');
    expect(hasForwardableContent(content)).toBe(true);
  });

  it('appends embed text after plain content (embed + text)', async () => {
    const msg = mockMessage({ content: 'BANG! @Pro', embeds: [CALLOUT_CARD] });

    const content = await buildMessageContent(msg);
    expect(content.startsWith('BANG! @Pro')).toBe(true);
    expect(content).toContain('BTO $QQQ 710p 06/08');
  });

  it('flattens every embed in a multi-embed message with a boundary separator', async () => {
    const msg = mockMessage({
      embeds: [
        mockEmbed({ title: 'First card', description: 'BTO $SPY 600c' }),
        mockEmbed({ title: 'Second card', description: 'TRIM $QQQ 707c' }),
      ],
    });

    const content = await buildMessageContent(msg);
    expect(content).toBe('First card\nBTO $SPY 600c\n---\nSecond card\nTRIM $QQQ 707c');
  });

  it('renders fields as "name: value" and includes footer text (image-bearing embed)', async () => {
    const msg = mockMessage({
      embeds: [
        mockEmbed({
          title: 'Trade Alert',
          fields: [
            { name: 'Ticker', value: 'QQQ' },
            { name: 'Strike', value: '710p', inline: true },
          ],
          footer: { text: 'Not financial advice' },
          image: { url: 'https://cdn.example/chart.png' },
        }),
      ],
    });

    const content = await buildMessageContent(msg);
    expect(content).toContain('Ticker: QQQ');
    expect(content).toContain('Strike: 710p');
    expect(content).toContain('Not financial advice');
  });

  it('truncates the assembled content to 6000 chars', async () => {
    const msg = mockMessage({
      embeds: [mockEmbed({ title: 'Huge', description: 'x'.repeat(7000) })],
    });

    const content = await buildMessageContent(msg);
    expect(content.length).toBe(6000);
    expect(content).toContain('Huge');
  });

  it('flattens an image-only embed into forwardable text', async () => {
    const msg = mockMessage({
      content: '',
      embeds: [mockEmbed({ image: { url: 'https://cdn.example/chart-only.png' } })],
    });

    const content = await buildMessageContent(msg);
    expect(content).toBe('image: https://cdn.example/chart-only.png');
    expect(hasForwardableContent(content)).toBe(true);
  });

  it('drops a lone high surrogate when truncation splits a surrogate pair', async () => {
    // Body = 'Huge\n' (5 chars) + description; index 5999 lands on the high
    // surrogate of the first 😀, so a naive slice would leave a lone surrogate.
    const msg = mockMessage({
      embeds: [mockEmbed({ title: 'Huge', description: 'x'.repeat(5994) + '😀'.repeat(10) })],
    });

    const content = await buildMessageContent(msg);
    expect(content.length).toBe(5999);
    expect(/[\uD800-\uDBFF]$/.test(content)).toBe(false);
    expect(JSON.parse(JSON.stringify(content))).toBe(content);
  });
});

describe('buildEnvelope with embeds', () => {
  it('carries raw embed JSON into the envelope and parses on the trader side', () => {
    const msg = mockMessage({ embeds: [CALLOUT_CARD] });
    const envelope = buildEnvelope(msg, 'flattened text');

    expect(envelope.embeds).toEqual([
      {
        author: { name: 'Demon Alerts' },
        title: 'BTO $QQQ 710p 06/08',
        description: 'Entry @ 0.97 — RISKY SIZE APPROPRIATE',
      },
    ]);

    const parsed = DiscordEnvelopeSchema.safeParse(JSON.parse(JSON.stringify(envelope)));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.embeds).toEqual(envelope.embeds);
  });

  it('caps envelope embeds at 10', () => {
    const embeds = Array.from({ length: 12 }, (_, i) => mockEmbed({ title: `card-${i}` }));
    const envelope = buildEnvelope(mockMessage({ embeds }), 'text');

    expect(envelope.embeds).toHaveLength(10);
  });
});

describe('buildMirrorPayload', () => {
  it('includes the envelope embeds so the forward channel shows the cards', () => {
    const envelope = buildEnvelope(mockMessage({ embeds: [CALLOUT_CARD] }), 'flattened text');
    const payload = buildMirrorPayload(envelope);

    expect(payload.embeds).toEqual(envelope.embeds);
    expect(payload.content).toContain('From: Demon Alerts (author-001)');
    expect(payload.content).toContain('flattened text');
    expect(payload.allowedMentions).toEqual({ parse: [] });
  });

  it('drops auto-generated link-preview embeds but keeps rich embeds', () => {
    const envelope = buildEnvelope(
      mockMessage({
        embeds: [
          mockEmbed({ type: 'rich', title: 'Author card' }),
          mockEmbed({ type: 'link', title: 'Link preview', url: 'https://example.com' }),
        ],
      }),
      'text'
    );
    const payload = buildMirrorPayload(envelope);

    expect(envelope.embeds).toHaveLength(2);
    expect(payload.embeds).toEqual([{ type: 'rich', title: 'Author card' }]);
  });

  it('truncates mirror text to Discord message limits', () => {
    const envelope = buildEnvelope(mockMessage({}), 'y'.repeat(3000));
    const payload = buildMirrorPayload(envelope);

    expect(payload.content.length).toBe(2000);
    expect(payload.content.endsWith('...')).toBe(true);
  });
});
