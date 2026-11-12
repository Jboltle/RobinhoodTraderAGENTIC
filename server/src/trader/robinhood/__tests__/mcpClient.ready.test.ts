/**
 * ensureReady — the trade path's bounded connect. It reconnects a cold
 * session from stored tokens, but never waits on a human: OAuth consent or a
 * slow connect fails fast as BrokerUnavailableError instead of a callout
 * hanging (or being mislabeled as a bad ticker).
 */
import { describe, expect, it, vi } from 'vitest';

import { BrokerUnavailableError, RobinhoodMcpClient } from '../mcpClient.js';
import type { BrokerTokenStore } from '../types.js';

type Internals = {
  connect: () => Promise<void>;
  client: unknown;
  pendingAuthUrl: string | null;
};

function makeClient(connect: (self: Internals) => Promise<void>): {
  mcp: RobinhoodMcpClient;
  internals: Internals;
  connectSpy: ReturnType<typeof vi.fn>;
} {
  const mcp = new RobinhoodMcpClient({ userId: 'user-1', db: {} as BrokerTokenStore });
  const internals = mcp as unknown as Internals;
  const connectSpy = vi.fn(() => connect(internals));
  internals.connect = connectSpy;
  return { mcp, internals, connectSpy };
}

describe('RobinhoodMcpClient.ensureReady', () => {
  it('connects a cold session from stored tokens', async () => {
    const { mcp, connectSpy } = makeClient(async (self) => {
      self.client = {};
    });

    await mcp.ensureReady(1_000);

    expect(connectSpy).toHaveBeenCalledOnce();
    expect(mcp.isConnected()).toBe(true);
  });

  it('shares one in-flight connect between concurrent callers', async () => {
    const { mcp, connectSpy } = makeClient(async (self) => {
      await new Promise((r) => setTimeout(r, 20));
      self.client = {};
    });

    await Promise.all([mcp.ensureReady(1_000), mcp.ensureReady(1_000)]);

    expect(connectSpy).toHaveBeenCalledOnce();
  });

  it('fails fast once the connect falls back to OAuth consent', async () => {
    const { mcp } = makeClient((self) => {
      self.pendingAuthUrl = 'https://robinhood.com/mcp/trading?x=1';
      return new Promise<void>(() => {}); // waits on a paste forever
    });

    const started = Date.now();
    await expect(mcp.ensureReady(5_000)).rejects.toBeInstanceOf(BrokerUnavailableError);
    expect(Date.now() - started).toBeLessThan(2_000);
    // Still pending: a later call rejects immediately without a new connect.
    await expect(mcp.ensureReady(5_000)).rejects.toThrow(/authorization required/);
  });

  it('times out a connect that never settles', async () => {
    const { mcp } = makeClient(() => new Promise<void>(() => {}));

    await expect(mcp.ensureReady(50)).rejects.toThrow(/timed out/);
  });

  it('wraps a failed connect as BrokerUnavailableError', async () => {
    const { mcp } = makeClient(async () => {
      throw new Error('ECONNREFUSED');
    });

    const err = await mcp.ensureReady(1_000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrokerUnavailableError);
    expect((err as Error).message).toMatch(/ECONNREFUSED/);
  });
});
