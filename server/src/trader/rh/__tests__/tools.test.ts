import { describe, expect, it, vi } from 'vitest';

import type { RobinhoodMcpClient } from '../mcpClient.js';
import type { CallToolResult } from '../types.js';
import { RobinhoodTools, TOOL_NAMES } from '../tools.js';

// Live-verified payload shapes from the real Robinhood MCP server.
const ACCOUNTS_PAYLOAD = {
  data: {
    accounts: [
      {
        account_number: '856500400',
        type: 'margin',
        is_default: true,
        agentic_allowed: false,
        state: 'active',
      },
      {
        account_number: '633644000',
        type: 'cash',
        nickname: 'Agentic',
        is_default: false,
        agentic_allowed: true,
        state: 'active',
      },
    ],
  },
};

const PORTFOLIO_PAYLOAD = {
  data: {
    total_value: '100',
    equity_value: '0',
    options_value: '0',
    cash: '100',
    currency: 'USD',
    buying_power: {
      buying_power: '100.0000',
      unleveraged_buying_power: '100.0000',
      display_currency: 'USD',
    },
  },
};

function textResult(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function makeMcp(
  toolNames: string[],
  responses: Record<string, unknown>
): RobinhoodMcpClient {
  return {
    isConnected: vi.fn().mockReturnValue(true),
    getToolNames: vi.fn().mockReturnValue(toolNames),
    callTool: vi.fn(async (name: string) => textResult(responses[name])),
  } as unknown as RobinhoodMcpClient;
}

describe('RobinhoodTools account selection', () => {
  it('prefers the agentic_allowed active account over is_default', async () => {
    const mcp = makeMcp([TOOL_NAMES.accounts, TOOL_NAMES.portfolio], {
      [TOOL_NAMES.accounts]: ACCOUNTS_PAYLOAD,
      [TOOL_NAMES.portfolio]: PORTFOLIO_PAYLOAD,
    });
    const bp = await new RobinhoodTools(mcp).getBuyingPower();

    expect(bp.accountNumber).toBe('633644000');
    expect(mcp.callTool).toHaveBeenCalledWith(TOOL_NAMES.portfolio, {
      account_number: '633644000',
    });
  });

  it('falls back to the is_default account when no account is agentic_allowed', async () => {
    const noAgentic = {
      data: {
        accounts: [
          { account_number: '111100001', is_default: false, agentic_allowed: false, state: 'active' },
          { account_number: '856500400', is_default: true, agentic_allowed: false, state: 'active' },
        ],
      },
    };
    const mcp = makeMcp([TOOL_NAMES.accounts, TOOL_NAMES.portfolio], {
      [TOOL_NAMES.accounts]: noAgentic,
      [TOOL_NAMES.portfolio]: PORTFOLIO_PAYLOAD,
    });
    const bp = await new RobinhoodTools(mcp).getBuyingPower();

    expect(bp.accountNumber).toBe('856500400');
  });
});

// Live schema (dumped 2026-07-29): place_option_order takes legs referencing
// an option instrument UUID; flat symbol/strike/expiry args are rejected with
// "unexpected additional properties".
const INSTRUMENTS_PAYLOAD = {
  data: {
    instruments: [
      {
        id: 'opt-uuid-1',
        chain_symbol: 'RIVN',
        type: 'call',
        strike_price: '16.0000',
        expiration_date: '2026-07-24',
        state: 'active',
        tradability: 'tradable',
      },
    ],
  },
};

describe('RobinhoodTools order placement argument shapes', () => {
  const ORDER_PAYLOAD = { data: { order: { id: 'order-1', state: 'queued' } } };

  function orderMcp(): RobinhoodMcpClient {
    return makeMcp(
      [TOOL_NAMES.accounts, TOOL_NAMES.optionInstruments, TOOL_NAMES.placeOptionsOrder],
      {
        [TOOL_NAMES.accounts]: ACCOUNTS_PAYLOAD,
        [TOOL_NAMES.optionInstruments]: INSTRUMENTS_PAYLOAD,
        [TOOL_NAMES.placeOptionsOrder]: ORDER_PAYLOAD,
      }
    );
  }

  function lastCallArgs(mcp: RobinhoodMcpClient, tool: string): Record<string, unknown> {
    const calls = (mcp.callTool as ReturnType<typeof vi.fn>).mock.calls;
    return calls.filter(([name]) => name === tool).at(-1)![1];
  }

  it('resolves the option_id and places a legs-based market buy (no price, gfd)', async () => {
    const mcp = orderMcp();
    await new RobinhoodTools(mcp).placeOptionsOrder({
      symbol: 'RIVN',
      optionType: 'call',
      strike: 16,
      expiration: '2026-07-24',
      contracts: 5,
      side: 'buy',
      orderType: 'market',
    });

    expect(mcp.callTool).toHaveBeenCalledWith(
      TOOL_NAMES.optionInstruments,
      expect.objectContaining({
        chain_symbol: 'RIVN',
        expiration_dates: '2026-07-24',
        strike_price: '16.0000',
        type: 'call',
      })
    );
    const args = lastCallArgs(mcp, TOOL_NAMES.placeOptionsOrder);
    expect(args).toMatchObject({
      legs: [{ option_id: 'opt-uuid-1', side: 'buy', position_effect: 'open', ratio_quantity: 1 }],
      type: 'market',
      quantity: '5',
      time_in_force: 'gfd',
    });
    expect(args.ref_id).toEqual(expect.any(String));
    // Rejected by the live schema (additionalProperties: false / market order).
    for (const banned of ['price', 'symbol', 'strike_price', 'expiration_date', 'option_type', 'side']) {
      expect(args).not.toHaveProperty(banned);
    }
  });

  it('places a limit sell as a closing leg with a string price', async () => {
    const mcp = orderMcp();
    await new RobinhoodTools(mcp).placeOptionsOrder({
      symbol: 'RIVN',
      optionType: 'call',
      strike: 16,
      expiration: '2026-07-24',
      contracts: 1,
      side: 'sell',
      orderType: 'limit',
      limitPremium: 0.5,
    });

    const args = lastCallArgs(mcp, TOOL_NAMES.placeOptionsOrder);
    expect(args).toMatchObject({
      legs: [{ option_id: 'opt-uuid-1', side: 'sell', position_effect: 'close', ratio_quantity: 1 }],
      type: 'limit',
      price: '0.5',
      quantity: '1',
    });
  });

  it('passes equity order quantity as a string with gfd time in force', async () => {
    const mcp = makeMcp([TOOL_NAMES.accounts, TOOL_NAMES.placeOrder], {
      [TOOL_NAMES.accounts]: ACCOUNTS_PAYLOAD,
      [TOOL_NAMES.placeOrder]: ORDER_PAYLOAD,
    });
    await new RobinhoodTools(mcp).placeOrder({
      symbol: 'AMD',
      side: 'buy',
      quantity: 2,
      orderType: 'market',
    });

    expect(mcp.callTool).toHaveBeenCalledWith(
      TOOL_NAMES.placeOrder,
      expect.objectContaining({ quantity: '2', time_in_force: 'gfd' })
    );
  });

  it('sends limit_price but never the unsupported price field on equity limit orders', async () => {
    const mcp = makeMcp([TOOL_NAMES.accounts, TOOL_NAMES.placeOrder], {
      [TOOL_NAMES.accounts]: ACCOUNTS_PAYLOAD,
      [TOOL_NAMES.placeOrder]: ORDER_PAYLOAD,
    });
    await new RobinhoodTools(mcp).placeOrder({
      symbol: 'AMD',
      side: 'buy',
      quantity: 2,
      orderType: 'limit',
      limitPrice: 100,
    });

    const args = lastCallArgs(mcp, TOOL_NAMES.placeOrder);
    expect(args.limit_price).toBe('100');
    expect(args).not.toHaveProperty('price');
  });
});

describe('RobinhoodTools option position enrichment', () => {
  it('resolves strike/type for rows that only carry an option_id', async () => {
    // Live shape: no strike_price, no call/put, type = long/short direction.
    const positionsPayload = {
      data: {
        results: [
          { option_id: 'opt-uuid-1', chain_symbol: 'RIVN', type: 'long', quantity: '2.0000', expiration_date: '2026-07-24' },
          { option_id: 'opt-uuid-1', chain_symbol: 'RIVN', type: 'short', quantity: '0.0000', expiration_date: '2026-07-24' },
        ],
      },
    };
    const mcp = makeMcp(
      [TOOL_NAMES.accounts, TOOL_NAMES.optionPositions, TOOL_NAMES.optionInstruments],
      {
        [TOOL_NAMES.accounts]: ACCOUNTS_PAYLOAD,
        [TOOL_NAMES.optionPositions]: positionsPayload,
        [TOOL_NAMES.optionInstruments]: INSTRUMENTS_PAYLOAD,
      }
    );
    const { positions } = await new RobinhoodTools(mcp).getOptionPositions();

    expect(positions).toEqual([
      expect.objectContaining({
        symbol: 'RIVN',
        optionType: 'call',
        strike: 16,
        expiration: '2026-07-24',
        quantity: 2,
      }),
    ]);
    expect(mcp.callTool).toHaveBeenCalledWith(
      TOOL_NAMES.optionInstruments,
      expect.objectContaining({ ids: 'opt-uuid-1' })
    );
  });
});

describe('RobinhoodTools get_portfolio parsing', () => {
  it('parses string-valued buying power and total value', async () => {
    const mcp = makeMcp([TOOL_NAMES.accounts, TOOL_NAMES.portfolio], {
      [TOOL_NAMES.accounts]: ACCOUNTS_PAYLOAD,
      [TOOL_NAMES.portfolio]: PORTFOLIO_PAYLOAD,
    });
    const bp = await new RobinhoodTools(mcp).getBuyingPower();

    expect(bp.amountUsd).toBe(100);
    expect(bp.portfolioValueUsd).toBe(100);
  });

  it('falls back to get_accounts parsing when get_portfolio is not advertised', async () => {
    const mcp = makeMcp([TOOL_NAMES.accounts], {
      [TOOL_NAMES.accounts]: ACCOUNTS_PAYLOAD,
    });
    const bp = await new RobinhoodTools(mcp).getBuyingPower();

    // Old servers without dollar fields on get_accounts yield 0 / null.
    expect(bp.amountUsd).toBe(0);
    expect(bp.portfolioValueUsd).toBeNull();
    expect(mcp.callTool).toHaveBeenCalledWith(TOOL_NAMES.accounts, {});
  });
});
