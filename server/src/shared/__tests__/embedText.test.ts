/**
 * flattenEnvelope — the trader-side half of the envelope contract: producers
 * send raw parts (content text + raw embed JSON) and the trader flattens the
 * embeds into parse text exactly once, at its ingestion boundary.
 */

import { describe, expect, it } from 'vitest';

import { flattenEnvelope, MAX_CONTENT_LENGTH } from '../embedText.js';
import type { DiscordEnvelope } from '../types.js';

function envelope(overrides: Partial<DiscordEnvelope>): DiscordEnvelope {
  return {
    messageId: 'msg-1',
    channelId: 'chan-1',
    guildId: null,
    authorId: 'author-1',
    authorName: 'Caller',
    authorAvatarUrl: null,
    content: '',
    timestamp: '2026-06-09T14:27:00.000Z',
    ...overrides,
  };
}

const CALLOUT_CARD = {
  author: { name: 'Demon Alerts' },
  title: 'BTO $QQQ 710p 06/08',
  description: 'Entry @ 0.97 — RISKY SIZE APPROPRIATE',
};

describe('flattenEnvelope', () => {
  it('leaves a content-only envelope unchanged (message without embeds)', () => {
    const env = envelope({ content: 'BTO $QQQ 710p 06/08 0.97\n\nRISKY SIZE @Pro' });
    expect(flattenEnvelope(env)).toEqual(env);
  });

  it('flattens an embed-only envelope into parse text', () => {
    const flattened = flattenEnvelope(envelope({ content: '', embeds: [CALLOUT_CARD] }));
    expect(flattened.content).toBe(
      'Demon Alerts\nBTO $QQQ 710p 06/08\nEntry @ 0.97 — RISKY SIZE APPROPRIATE'
    );
  });

  it('appends embed text after the raw content (message + embed combination)', () => {
    const flattened = flattenEnvelope(envelope({ content: 'BANG! @Pro', embeds: [CALLOUT_CARD] }));
    expect(flattened.content).toBe(
      'BANG! @Pro\nDemon Alerts\nBTO $QQQ 710p 06/08\nEntry @ 0.97 — RISKY SIZE APPROPRIATE'
    );
  });

  it('keeps the raw embeds on the returned envelope for storage/display', () => {
    const flattened = flattenEnvelope(envelope({ embeds: [CALLOUT_CARD] }));
    expect(flattened.embeds).toEqual([CALLOUT_CARD]);
  });

  it('separates consecutive embeds so two callout cards do not merge', () => {
    const flattened = flattenEnvelope(
      envelope({
        embeds: [
          { title: 'First card', description: 'BTO $SPY 600c' },
          { title: 'Second card', description: 'TRIM $QQQ 707c' },
        ],
      })
    );
    expect(flattened.content).toBe('First card\nBTO $SPY 600c\n---\nSecond card\nTRIM $QQQ 707c');
  });

  it('renders embed fields as "name: value" and keeps footer text + media URLs', () => {
    const flattened = flattenEnvelope(
      envelope({
        embeds: [
          {
            title: 'Trade Alert',
            fields: [
              { name: 'Ticker', value: 'QQQ' },
              { name: 'Strike', value: '710p' },
            ],
            footer: { text: 'Not financial advice' },
            image: { url: 'https://cdn.example/chart.png' },
          },
        ],
      })
    );
    expect(flattened.content).toContain('Ticker: QQQ');
    expect(flattened.content).toContain('Strike: 710p');
    expect(flattened.content).toContain('Not financial advice');
    expect(flattened.content).toContain('image: https://cdn.example/chart.png');
  });

  it('tolerates unknown-shaped embed JSON instead of throwing', () => {
    const flattened = flattenEnvelope(
      envelope({ content: 'text', embeds: [{ weird: { nested: true }, author: 'not-an-object' }] })
    );
    expect(flattened.content).toBe('text');
  });

  it('caps the flattened text at MAX_CONTENT_LENGTH regardless of producer', () => {
    const flattened = flattenEnvelope(
      envelope({ content: 'Huge', embeds: [{ description: 'x'.repeat(7000) }] })
    );
    expect(flattened.content.length).toBe(MAX_CONTENT_LENGTH);
    expect(flattened.content.startsWith('Huge')).toBe(true);
  });

  it('drops a lone high surrogate when the cap splits a surrogate pair', () => {
    // 'Huge\n' (5 chars) + 5994 x's puts the first 😀 at index 5999, so the
    // 6000-char slice would end on its high surrogate.
    const flattened = flattenEnvelope(
      envelope({ content: 'Huge', embeds: [{ description: 'x'.repeat(5994) + '😀'.repeat(10) }] })
    );
    expect(flattened.content.length).toBe(MAX_CONTENT_LENGTH - 1);
    expect(/[\uD800-\uDBFF]$/.test(flattened.content)).toBe(false);
    expect(JSON.parse(JSON.stringify(flattened.content))).toBe(flattened.content);
  });
});
