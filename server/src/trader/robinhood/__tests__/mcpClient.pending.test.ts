/** Paste-waiter must be live the moment status would show an auth URL. */
import { describe, expect, it } from 'vitest';

import { RobinhoodMcpClient } from '../mcpClient.js';
import type { BrokerTokenStore } from '../types.js';

type Internals = {
  armManualAuth: () => Promise<{ code: string; state: string | null }>;
};

describe('RobinhoodMcpClient paste waiter', () => {
  it('accepts a pasted code once the auth URL waiter is armed', async () => {
    const mcp = new RobinhoodMcpClient({
      userId: 'user-1',
      db: {} as BrokerTokenStore,
    });
    expect(mcp.isAuthPending()).toBe(false);
    expect(() => mcp.submitAuthCode('the-code', 'the-state')).toThrow(
      /no OAuth authorization is pending/
    );

    const submitted = (mcp as unknown as Internals).armManualAuth();
    expect(mcp.isAuthPending()).toBe(true);
    mcp.submitAuthCode('the-code', 'the-state');
    await expect(submitted).resolves.toEqual({ code: 'the-code', state: 'the-state' });
    expect(mcp.isAuthPending()).toBe(false);
  });
});
