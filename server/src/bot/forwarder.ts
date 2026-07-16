/**
 * Delivery of assembled envelopes to the trader webhook.
 *
 * Kept separate from index.ts (which auto-runs main() on import) so the
 * signing + POST behavior can be unit-tested with an injected fetch.
 */

import { config } from '../shared/config.js';
import type { DiscordEnvelope } from '../shared/types.js';
import { signWebhookBody } from '../shared/webhookAuth.js';
import type { ForwardRequest } from './types.js';

export type { ForwardRequest } from './types.js';

/** Build the signed HTTP request (url + HMAC headers + body) for a given envelope. */
export function buildForwardRequest(envelope: DiscordEnvelope): ForwardRequest {
  const body = JSON.stringify(envelope);
  return {
    url: config.traderWebhookUrl,
    headers: {
      'content-type': 'application/json',
      ...signWebhookBody(body, config.botTraderSecret),
    },
    body,
  };
}

export async function forwardToTrader(
  envelope: DiscordEnvelope,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const { url, headers, body } = buildForwardRequest(envelope);

  const response = await fetchImpl(url, {
    method: 'POST',
    headers,
    body,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`trader returned ${response.status}: ${text.slice(0, 200)}`);
  }
}
