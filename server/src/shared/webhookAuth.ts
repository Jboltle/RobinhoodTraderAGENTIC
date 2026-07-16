import { createHmac, timingSafeEqual } from 'node:crypto';

const SIGNATURE_HEADER = 'x-rh-discord-signature';
const TIMESTAMP_HEADER = 'x-rh-discord-timestamp';
const DEFAULT_TOLERANCE_MS = 5 * 60 * 1000;

export const webhookAuthHeaders = {
  signature: SIGNATURE_HEADER,
  timestamp: TIMESTAMP_HEADER,
} as const;

export interface SignedWebhookHeaders {
  readonly [SIGNATURE_HEADER]: string;
  readonly [TIMESTAMP_HEADER]: string;
}

export function signWebhookBody(
  body: string,
  secret: string,
  now: Date = new Date()
): SignedWebhookHeaders {
  const timestamp = now.toISOString();
  return {
    [SIGNATURE_HEADER]: computeSignature(body, timestamp, secret),
    [TIMESTAMP_HEADER]: timestamp,
  };
}

export function verifyWebhookBody(
  body: string,
  headers: Record<string, string | string[] | undefined>,
  secret: string,
  now: Date = new Date(),
  toleranceMs = DEFAULT_TOLERANCE_MS
): { ok: true } | { ok: false; reason: string } {
  if (!secret) return { ok: false, reason: 'BOT_TRADER_SECRET is not configured' };

  const timestamp = firstHeader(headers[TIMESTAMP_HEADER]);
  const signature = firstHeader(headers[SIGNATURE_HEADER]);
  if (!timestamp || !signature) return { ok: false, reason: 'missing webhook signature headers' };

  const sentAt = Date.parse(timestamp);
  if (!Number.isFinite(sentAt)) return { ok: false, reason: 'invalid webhook timestamp' };
  if (Math.abs(now.getTime() - sentAt) > toleranceMs) {
    return { ok: false, reason: 'webhook timestamp outside tolerance' };
  }

  const expected = computeSignature(body, timestamp, secret);
  if (!safeEquals(signature, expected)) return { ok: false, reason: 'invalid webhook signature' };

  return { ok: true };
}

function computeSignature(body: string, timestamp: string, secret: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex');
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}
