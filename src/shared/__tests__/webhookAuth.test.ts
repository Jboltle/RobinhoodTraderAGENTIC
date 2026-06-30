import { describe, expect, it } from 'vitest';

import { signWebhookBody, verifyWebhookBody } from '../webhookAuth.js';

describe('webhookAuth', () => {
  const secret = 'test-secret';
  const now = new Date('2026-06-15T14:35:00.000Z');
  const body = JSON.stringify({ messageId: 'm1', content: 'BTO $QQQ 710p 06/08 0.97' });

  it('verifies a body signed with the shared secret', () => {
    const headers = signWebhookBody(body, secret, now);

    expect(verifyWebhookBody(body, { ...headers }, secret, now)).toEqual({ ok: true });
  });

  it('rejects tampered bodies', () => {
    const headers = signWebhookBody(body, secret, now);

    const result = verifyWebhookBody(body.replace('QQQ', 'SPY'), { ...headers }, secret, now);

    expect(result).toMatchObject({ ok: false, reason: 'invalid webhook signature' });
  });

  it('rejects stale timestamps', () => {
    const headers = signWebhookBody(body, secret, now);
    const later = new Date('2026-06-15T14:45:01.000Z');

    const result = verifyWebhookBody(body, { ...headers }, secret, later);

    expect(result).toMatchObject({ ok: false, reason: 'webhook timestamp outside tolerance' });
  });

  it('rejects missing secrets', () => {
    const headers = signWebhookBody(body, secret, now);

    const result = verifyWebhookBody(body, { ...headers }, '', now);

    expect(result).toMatchObject({ ok: false, reason: 'BOT_TRADER_SECRET is not configured' });
  });
});
