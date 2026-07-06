/**
 * Forwarding tests — prove that an assembled envelope is delivered to the
 * trader webhook as a signed POST, and that the trader can authenticate and
 * parse exactly what the bot sends (listen -> forward round-trip).
 */

import { describe, expect, it, vi } from 'vitest';

import { config } from '../../shared/config.js';
import { DiscordEnvelopeSchema, type DiscordEnvelope } from '../../shared/types.js';
import { verifyWebhookBody, webhookAuthHeaders } from '../../shared/webhookAuth.js';
import { buildForwardRequest, forwardToTrader } from '../forwarder.js';

const ENVELOPE: DiscordEnvelope = {
  messageId: 'discord-msg-999',
  channelId: '1490028729521410189',
  guildId: 'guild-001',
  authorId: 'user-42',
  authorName: 'Demon Alerts',
  content: 'BTO $QQQ 710p 06/08 0.97',
  timestamp: '2026-06-09T14:27:00.000Z',
};

function okResponse(): Response {
  return { ok: true, status: 202, text: async () => '' } as unknown as Response;
}

describe('buildForwardRequest', () => {
  it('targets the configured trader webhook with a JSON body and HMAC headers', () => {
    const req = buildForwardRequest(ENVELOPE);

    expect(req.url).toBe(config.traderWebhookUrl);
    expect(req.headers['content-type']).toBe('application/json');
    expect(req.headers[webhookAuthHeaders.signature]).toBeTruthy();
    expect(req.headers[webhookAuthHeaders.timestamp]).toBeTruthy();
    expect(req.body).toBe(JSON.stringify(ENVELOPE));
  });
});

describe('forwardToTrader', () => {
  it('POSTs the signed envelope to the trader endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());

    await forwardToTrader(ENVELOPE, fetchImpl as unknown as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(config.traderWebhookUrl);
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify(ENVELOPE));
    expect(init.headers[webhookAuthHeaders.signature]).toBeTruthy();
    expect(init.headers[webhookAuthHeaders.timestamp]).toBeTruthy();
  });

  it('throws when the trader responds with a non-2xx status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'unauthorized',
    } as unknown as Response);

    await expect(forwardToTrader(ENVELOPE, fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      /trader returned 401/
    );
  });

  it('round-trips: the trader verifies the signature and parses the envelope', async () => {
    let captured: { headers: Record<string, string>; body: string } | null = null;
    const fetchImpl = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      captured = {
        headers: init.headers as Record<string, string>,
        body: init.body as string,
      };
      return Promise.resolve(okResponse());
    });

    await forwardToTrader(ENVELOPE, fetchImpl as unknown as typeof fetch);

    expect(captured).not.toBeNull();
    const { headers, body } = captured!;

    const auth = verifyWebhookBody(body, headers, config.botTraderSecret);
    expect(auth.ok).toBe(true);

    const parsed = DiscordEnvelopeSchema.safeParse(JSON.parse(body));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual(ENVELOPE);
  });

  it('rejects a tampered body under the original signature', async () => {
    const { url, headers, body } = buildForwardRequest(ENVELOPE);
    expect(url).toBe(config.traderWebhookUrl);

    const tampered = body.replace('710p', '999p');
    const auth = verifyWebhookBody(tampered, headers, config.botTraderSecret);
    expect(auth.ok).toBe(false);
  });
});
