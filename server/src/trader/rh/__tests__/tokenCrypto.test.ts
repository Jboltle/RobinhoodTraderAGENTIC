/** Broker-token encryption: round-trip, and a wrong key must not decrypt. */

import { describe, expect, it } from 'vitest';

import { decryptTokens, encryptTokens } from '../tokenCrypto.js';

const SECRET = 'test-vault-key';
const TOKENS_JSON = JSON.stringify({ tokens: { access_token: 'abc', refresh_token: 'def' } });

describe('encryptTokens / decryptTokens', () => {
  it('round-trips plaintext without leaking it into the blob', () => {
    const blob = encryptTokens(TOKENS_JSON, SECRET);
    expect(blob.toString('utf8')).not.toContain('access_token');
    expect(decryptTokens(blob, SECRET)).toBe(TOKENS_JSON);
  });

  it('throws when decrypting with the wrong secret', () => {
    const blob = encryptTokens(TOKENS_JSON, SECRET);
    expect(() => decryptTokens(blob, 'wrong-secret')).toThrow();
  });

  it('throws when the ciphertext is tampered with', () => {
    const blob = encryptTokens(TOKENS_JSON, SECRET);
    blob.writeUInt8(blob.readUInt8(blob.length - 1) ^ 0xff, blob.length - 1);
    expect(() => decryptTokens(blob, SECRET)).toThrow();
  });
});
