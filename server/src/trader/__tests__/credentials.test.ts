import { describe, expect, it } from 'vitest';

import { hashSessionToken, newSessionToken } from '../credentials.js';

describe('session tokens', () => {
  it('are unique, and stored as a stable hash that is not the token', () => {
    const token = newSessionToken();
    expect(newSessionToken()).not.toBe(token);
    expect(hashSessionToken(token)).toBe(hashSessionToken(token));
    expect(hashSessionToken(token)).not.toBe(token);
  });
});
