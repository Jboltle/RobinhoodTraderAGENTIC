/**
 * AES-256-GCM for Robinhood OAuth token material at rest.
 *
 * Broker tokens live in Postgres, so they are encrypted before they leave the
 * process: a database dump, a leaked backup, or a mis-scoped query yields
 * ciphertext rather than a tradable session.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

const deriveKey = (secret: string): Buffer => createHash('sha256').update(secret).digest();

/** Blob layout: iv (12 bytes) || authTag (16 bytes) || ciphertext. */
export function encryptTokens(plaintext: string, secret: string): Buffer {
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

/** Inverse of encryptTokens; throws on tampering or a wrong secret. */
export function decryptTokens(blob: Buffer, secret: string): string {
  const iv = blob.subarray(0, GCM_IV_BYTES);
  const authTag = blob.subarray(GCM_IV_BYTES, GCM_IV_BYTES + GCM_TAG_BYTES);
  const ciphertext = blob.subarray(GCM_IV_BYTES + GCM_TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
