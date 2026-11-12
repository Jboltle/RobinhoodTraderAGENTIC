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

describe('RobinhoodTools.getOptionOrders', () => {
  // Field names are the ones parseOptionOrders reads; no live payload is on file.
  const STOP_ROW = {
    id: 'stop-1',
    chain_symbol: 'QQQ',
    state: 'cancelled',
    processed_quantity: '0.00000',
    quantity: '2.00000',
    legs: [{ side: 'sell', option_type: 'call', strike_price: '707.0000', expiration_date: '2026-06-11' }],
  };

  function makeOrdersMcp(row: Record<string, unknown> = STOP_ROW) {
    const callTool = vi.fn(async (name: string, _args: Record<string, unknown>) =>
      name === TOOL_NAMES.accounts
        ? jsonResult({ accounts: [{ account_number: 'ACCT1', agentic_allowed: true, state: 'active' }] })
        : jsonResult({ results: [row] })
    );
    return {
      ensureReady: vi.fn(async () => undefined),
      getToolNames: () => Object.values(TOOL_NAMES),
      getTokenStatus: async () => ({ state: 'valid', hasRefreshToken: true }),
      callTool,
    };
  }

  const orderCalls = (mcp: ReturnType<typeof makeOrdersMcp>): unknown[] =>
    mcp.callTool.mock.calls.filter((call) => call[0] === TOOL_NAMES.optionOrders).map((call) => call[1]);

  it('filters by order id when one is given, and reads its state', async () => {
    const mcp = makeOrdersMcp();
    const tools = new RobinhoodTools(mcp as unknown as RobinhoodMcpClient);

    const result = await tools.getOptionOrders('stop-1');

    expect(orderCalls(mcp)).toEqual([{ account_number: 'ACCT1', order_id: 'stop-1' }]);
    expect(result?.orders).toMatchObject([{ orderId: 'stop-1', state: 'cancelled', quantity: 0 }]);
  });

  it('reports a processed quantity only when the row carries one', async () => {
    const partial = new RobinhoodTools(
      makeOrdersMcp({ ...STOP_ROW, processed_quantity: '1.00000' }) as unknown as RobinhoodMcpClient
    );
    const { processed_quantity: _absent, ...bare } = STOP_ROW;
    const silent = new RobinhoodTools(makeOrdersMcp(bare) as unknown as RobinhoodMcpClient);

    expect((await partial.getOptionOrders('stop-1'))?.orders).toMatchObject([{ processedQuantity: 1 }]);
    // `quantity` falls back to the order size; the processed quantity must not.
    expect((await silent.getOptionOrders('stop-1'))?.orders).toMatchObject([{ quantity: 2, processedQuantity: null }]);
  });

  it('sends no order filter for the history read', async () => {
    const mcp = makeOrdersMcp();
    const tools = new RobinhoodTools(mcp as unknown as RobinhoodMcpClient);

    await tools.getOptionOrders();

    expect(orderCalls(mcp)).toEqual([{ account_number: 'ACCT1' }]);
  });
});
