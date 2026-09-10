import { describe, expect, it } from 'vitest';

import { assertTokenForTrade, readTokenStatus } from '../mcpClient.js';

describe('readTokenStatus', () => {
  it('reports missing when nothing is stored', () => {
    expect(readTokenStatus(undefined)).toEqual({
      state: 'missing',
      hasRefreshToken: false,
    });
    expect(readTokenStatus({ access_token: '', token_type: 'Bearer' })).toEqual({
      state: 'missing',
      hasRefreshToken: false,
    });
  });

  it('reports valid when an access token is stored, JWT or not', () => {
    expect(
      readTokenStatus({
        access_token: 'opaque-rh-bearer',
        token_type: 'Bearer',
        refresh_token: 'refresh',
      })
    ).toEqual({ state: 'valid', hasRefreshToken: true });
  });

  it('reports refreshable when only a refresh token is stored', () => {
    expect(
      readTokenStatus({
        access_token: '',
        token_type: 'Bearer',
        refresh_token: 'refresh',
      }).state
    ).toBe('refreshable');
  });
});

describe('assertTokenForTrade', () => {
  it('throws when no token material is stored', () => {
    expect(() =>
      assertTokenForTrade({ state: 'missing', hasRefreshToken: false })
    ).toThrow(/token is missing/);
  });

  it('allows a stored access token', () => {
    expect(() =>
      assertTokenForTrade({ state: 'valid', hasRefreshToken: true })
    ).not.toThrow();
  });

  it('allows a refreshable token so the SDK can refresh on the trade call', () => {
    expect(() =>
      assertTokenForTrade({ state: 'refreshable', hasRefreshToken: true })
    ).not.toThrow();
  });
});
