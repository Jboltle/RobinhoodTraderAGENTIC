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
