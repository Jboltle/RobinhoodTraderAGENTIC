/**
 * RobinhoodTools connection handling and quote classification: a cold session
 * reconnects on the first call, a down session surfaces as
 * BrokerUnavailableError, and only a broker that actually answered can make
 * a symbol "not found".
 */
import { describe, expect, it, vi } from 'vitest';

import { BrokerUnavailableError, McpToolError, type RobinhoodMcpClient } from '../mcpClient.js';
import { RobinhoodTools, SymbolNotFoundError, TOOL_NAMES } from '../tools.js';
import type { CallToolResult } from '../types.js';

function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function makeMcp(opts: {
  ensureReady?: () => Promise<void>;
  callTool?: (name: string) => Promise<CallToolResult>;
}) {
  let connected = false;
  const mcp = {
    ensureReady: vi.fn(
      opts.ensureReady ??
        (async () => {
          connected = true;
        })
    ),
    isConnected: () => connected,
    getToolNames: () => (connected ? Object.values(TOOL_NAMES) : []),
    getToolInputSchema: () => undefined,
    callTool: vi.fn(opts.callTool ?? (async () => jsonResult({ price: 500 }))),
  };
  return mcp;
}

describe('RobinhoodTools connection', () => {
  it('reconnects a cold session before the first call', async () => {
    const mcp = makeMcp({});
    const tools = new RobinhoodTools(mcp as unknown as RobinhoodMcpClient);

    await expect(tools.getQuote('QQQ')).resolves.toMatchObject({ price: 500 });
    expect(mcp.ensureReady).toHaveBeenCalled();
  });

  it('surfaces a down session as BrokerUnavailableError without retrying', async () => {
    const mcp = makeMcp({
      ensureReady: async () => {
        throw new BrokerUnavailableError('Robinhood authorization required');
      },
    });
    const tools = new RobinhoodTools(mcp as unknown as RobinhoodMcpClient);

    await expect(tools.getQuote('QQQ')).rejects.toBeInstanceOf(BrokerUnavailableError);
    expect(mcp.ensureReady).toHaveBeenCalledOnce();
    expect(mcp.callTool).not.toHaveBeenCalled();
  });

  it('classifies a quote with no price as SymbolNotFoundError', async () => {
    const mcp = makeMcp({ callTool: async () => jsonResult({ results: [] }) });
    const tools = new RobinhoodTools(mcp as unknown as RobinhoodMcpClient);

    await expect(tools.getQuote('MTSLA')).rejects.toBeInstanceOf(SymbolNotFoundError);
    expect(mcp.callTool).toHaveBeenCalledOnce();
  });

  it('classifies a broker tool error on the quote as SymbolNotFoundError', async () => {
    const mcp = makeMcp({
      callTool: async () => {
        throw new McpToolError('Tool get_equity_quotes returned error: invalid symbol');
      },
    });
    const tools = new RobinhoodTools(mcp as unknown as RobinhoodMcpClient);

    await expect(tools.getQuote('MTSLA')).rejects.toBeInstanceOf(SymbolNotFoundError);
  });

  it('leaves a transport failure unclassified (not a ticker problem)', async () => {
    const mcp = makeMcp({
      callTool: async () => {
        throw new Error('fetch failed');
      },
    });
    const tools = new RobinhoodTools(mcp as unknown as RobinhoodMcpClient);

    const err = await tools.getQuote('QQQ').catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(SymbolNotFoundError);
    expect(err).not.toBeInstanceOf(BrokerUnavailableError);
    expect((err as Error).message).toMatch(/fetch failed/);
  });
});
