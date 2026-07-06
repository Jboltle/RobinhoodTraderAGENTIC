import { createLogger } from '../../shared/logger.js';
import type { RobinhoodMcpClient } from './mcpClient.js';
import type {
  AccountScopedArgs,
  BuyingPowerResult,
  CallToolResult,
  OptionPosition,
  OptionPositionsResult,
  OptionsQuoteResult,
  PlaceOptionsOrderArgs,
  PlaceOptionsOrderPayload,
  PlaceOptionsOrderResult,
  PlaceOrderArgs,
  PlaceOrderPayload,
  PlaceOrderResult,
  Position,
  PositionsResult,
  QuoteResult,
  RhToolMap,
  ToolArgs,
  ToolKind,
  ToolRegistry,
  ToolResult,
} from './types.js';

export type * from './types.js';

const log = createLogger('trader:rh:tools');

// =============================================================================
// Tool registry
//
// Each entry binds a logical capability (`ToolKind`) to the exact MCP tool
// name advertised by Robinhood and a parser that turns the raw
// `CallToolResult` into the typed result registered for that kind. The
// registry is the single source of truth: `RobinhoodTools.call(kind, args)`
// is a fully type-safe dispatch — args/result are inferred from `kind`.
// See ./types.ts for the full tool map and payload shapes.
// =============================================================================

const TOOL_REGISTRY: ToolRegistry = {
  quote: { name: 'get_equity_quotes', parse: parseQuote },
  optionsQuote: { name: 'get_option_quotes', parse: parseOptionsQuote },
  buyingPower: { name: 'get_accounts', parse: parseBuyingPower },
  positions: { name: 'get_equity_positions', parse: parsePositions },
  optionPositions: { name: 'get_option_positions', parse: parseOptionPositions },
  placeOrder: { name: 'place_equity_order', parse: parsePlaceOrder },
  placeOptionsOrder: { name: 'place_option_order', parse: parsePlaceOrder },
};

/** Canonical MCP tool name expected for each ToolKind. Read-only view of the registry. */
export const TOOL_NAMES: { readonly [K in ToolKind]: RhToolMap[K]['name'] } = {
  quote: TOOL_REGISTRY.quote.name,
  optionsQuote: TOOL_REGISTRY.optionsQuote.name,
  buyingPower: TOOL_REGISTRY.buyingPower.name,
  positions: TOOL_REGISTRY.positions.name,
  optionPositions: TOOL_REGISTRY.optionPositions.name,
  placeOrder: TOOL_REGISTRY.placeOrder.name,
  placeOptionsOrder: TOOL_REGISTRY.placeOptionsOrder.name,
};

// =============================================================================
// Public client
// =============================================================================

export class RobinhoodTools {
  private accountNumber: string | undefined;

  constructor(private readonly mcp: RobinhoodMcpClient) {}

  /**
   * Single type-safe dispatch. Validates that the live MCP server advertises
   * the canonical tool name, calls it with retries, and parses the response
   * into the typed result registered for `kind`.
   */
  async call<K extends ToolKind>(kind: K, args: ToolArgs<K>): Promise<ToolResult<K>> {
    const descriptor = TOOL_REGISTRY[kind];
    const advertised = this.mcp.getToolNames();
    if (!advertised.includes(descriptor.name)) {
      throw new Error(
        `Robinhood MCP does not advertise "${descriptor.name}" (${kind}). ` +
          `Available: ${advertised.join(', ')}`
      );
    }
    return withRetry(descriptor.name, async () => {
      const result = await this.mcp.callTool(descriptor.name, args as Record<string, unknown>);
      return descriptor.parse(result);
    });
  }

  // -- Ergonomic typed facades over `call(...)` ------------------------------

  getQuote(symbol: string): Promise<QuoteResult> {
    return this.call('quote', { symbols: [symbol] });
  }

  /**
   * Fetch the mark price for a single-leg option contract.
   * Used for market-order options sizing (premium × 100 × contracts = notional).
   * Returns null if the MCP server doesn't advertise the tool, so callers can
   * fall back gracefully rather than throwing.
   */
  async getOptionsMarkPrice(
    symbol: string,
    optionType: 'call' | 'put',
    strike: number,
    expiration: string
  ): Promise<OptionsQuoteResult | null> {
    if (!this.mcp.getToolNames().includes(TOOL_NAMES.optionsQuote)) return null;
    try {
      return await this.call('optionsQuote', {
        symbol,
        option_type: optionType,
        strike_price: strike,
        expiration_date: expiration,
      });
    } catch {
      return null;
    }
  }

  getBuyingPower(): Promise<BuyingPowerResult> {
    return this.call('buyingPower', {});
  }

  async getPositions(): Promise<PositionsResult> {
    return this.call('positions', { account_number: await this.getDefaultAccountNumber() });
  }

  async getOptionPositions(): Promise<OptionPositionsResult> {
    return this.call('optionPositions', { account_number: await this.getDefaultAccountNumber() });
  }

  async placeOrder(args: PlaceOrderArgs): Promise<PlaceOrderResult> {
    if (args.orderType === 'limit' && typeof args.limitPrice !== 'number') {
      throw new Error('limitPrice required for limit orders');
    }
    const payload: PlaceOrderPayload = {
      account_number: await this.getDefaultAccountNumber(),
      symbol: args.symbol,
      side: args.side,
      type: args.orderType,
      quantity: args.quantity,
      time_in_force: args.timeInForce ?? 'day',
      ...(args.orderType === 'limit' && args.limitPrice !== undefined
        ? { limit_price: args.limitPrice, price: args.limitPrice }
        : {}),
    };
    return this.call('placeOrder', payload);
  }

  async placeOptionsOrder(args: PlaceOptionsOrderArgs): Promise<PlaceOptionsOrderResult> {
    if (args.orderType === 'limit' && typeof args.limitPremium !== 'number') {
      throw new Error('limitPremium (per-contract price) required for limit options orders');
    }
    const payload: PlaceOptionsOrderPayload = {
      account_number: await this.getDefaultAccountNumber(),
      symbol: args.symbol,
      option_type: args.optionType,
      strike_price: args.strike,
      expiration_date: args.expiration,
      quantity: args.contracts,
      side: args.side,
      type: args.orderType,
      time_in_force: args.timeInForce ?? 'day',
      ...(args.orderType === 'limit' && args.limitPremium !== undefined
        ? { price: args.limitPremium }
        : {}),
    };
    return this.call('placeOptionsOrder', payload);
  }

  private async getDefaultAccountNumber(): Promise<string> {
    if (this.accountNumber) return this.accountNumber;
    const buyingPower = await this.getBuyingPower();
    if (!buyingPower.accountNumber) {
      throw new Error('could not determine Robinhood account_number from get_accounts');
    }
    this.accountNumber = buyingPower.accountNumber;
    return this.accountNumber;
  }
}

// =============================================================================
// Per-tool parsers (kept as `function` declarations so they can be referenced
// from `TOOL_REGISTRY` above thanks to hoisting).
// =============================================================================

function parseOptionsQuote(result: CallToolResult): OptionsQuoteResult {
  const data = structuredOrJson(result);
  const markPrice =
    deepFindNumber(data, ['mark_price', 'mark', 'mid_price', 'last_trade_price', 'ask_price']) ??
    deepFindNumber(data, ['price', 'last_price']);
  if (markPrice === null || markPrice <= 0) {
    throw new Error(`could not parse options mark price: ${extractText(result).slice(0, 200)}`);
  }
  return { markPrice, raw: data ?? result };
}

function parseQuote(result: CallToolResult): QuoteResult {
  const data = structuredOrJson(result);
  const price =
    deepFindNumber(data, ['price', 'last_trade_price', 'last_price', 'mark_price', 'ask_price']) ??
    deepFindNumber(data, ['close', 'previous_close']);
  if (price === null || price <= 0) {
    throw new Error(`could not parse quote price: ${extractText(result).slice(0, 200)}`);
  }
  return { price, raw: data ?? result };
}

function parseBuyingPower(result: CallToolResult): BuyingPowerResult {
  const data = structuredOrJson(result);
  const accountNumber = deepFindString(data, ['account_number', 'accountNumber', 'account_id', 'id']);
  const amountUsd =
    deepFindNumber(data, [
      'buying_power',
      'available_cash',
      'available_funds',
      'cash_available_for_withdrawal',
      'cash_balance',
    ]) ?? 0;
  return { amountUsd, accountNumber, raw: data ?? result };
}

function parsePositions(result: CallToolResult): PositionsResult {
  const data = structuredOrJson(result);
  const list = extractList(data);
  const positions: Position[] = [];
  for (const item of list) {
    const symbol = deepFindString(item, ['symbol', 'ticker', 'instrument_symbol']);
    const quantity = deepFindNumber(item, ['quantity', 'shares', 'qty']) ?? 0;
    if (symbol) positions.push({ symbol, quantity, raw: item });
  }
  return { positions, raw: data ?? result };
}

function parseOptionPositions(result: CallToolResult): OptionPositionsResult {
  const data = structuredOrJson(result);
  const positions: OptionPosition[] = [];

  for (const item of extractList(data)) {
    const symbol = deepFindString(item, ['symbol', 'chain_symbol', 'underlying_symbol', 'ticker']);
    const optionType = normalizeOptionType(deepFindString(item, ['option_type', 'type', 'optionType']));
    const strike = deepFindNumber(item, ['strike_price', 'strike']);
    const expiration = deepFindString(item, ['expiration_date', 'expiration', 'expires_at']);
    const quantity = deepFindNumber(item, ['quantity', 'contracts', 'qty']) ?? 0;

    if (symbol && optionType && strike !== null && expiration) {
      positions.push({
        symbol: symbol.toUpperCase(),
        optionType,
        strike,
        expiration: expiration.slice(0, 10),
        quantity,
        raw: item,
      });
    }
  }

  return { positions, raw: data ?? result };
}

function parsePlaceOrder(result: CallToolResult): PlaceOrderResult {
  const data = structuredOrJson(result);
  const orderId = deepFindString(data, ['order_id', 'id', 'client_order_id']);
  const status = deepFindString(data, ['status', 'state']) ?? (orderId ? 'submitted' : null);
  return { orderId, status, raw: data ?? result };
}

// =============================================================================
// Internal helpers
// =============================================================================

interface RetryOptions {
  readonly attempts?: number;
  readonly initialDelayMs?: number;
}

async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const initialDelayMs = opts.initialDelayMs ?? 250;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      log.warn('tool call failed, will retry', {
        label,
        attempt: i + 1,
        attempts,
        error: (err as Error).message,
      });
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, initialDelayMs * Math.pow(2, i)));
      }
    }
  }
  throw lastErr instanceof Error
    ? new Error(`${label} failed after ${attempts} attempts: ${lastErr.message}`)
    : new Error(`${label} failed after ${attempts} attempts`);
}

function extractText(result: CallToolResult): string {
  return (result.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
}

function structuredOrJson(result: CallToolResult): unknown {
  if (result.structuredContent) return result.structuredContent;
  const text = extractText(result).trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const rec = asRecord(value);
  const candidates = [rec?.positions, rec?.results, rec?.items, rec?.data];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function normalizeOptionType(value: string | null): 'call' | 'put' | null {
  const normalized = value?.toLowerCase();
  if (normalized === 'call' || normalized === 'c') return 'call';
  if (normalized === 'put' || normalized === 'p') return 'put';
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function deepFindNumber(value: unknown, keys: readonly string[]): number | null {
  return deepFind(value, keys, (v): v is number => typeof v === 'number' && Number.isFinite(v));
}

function deepFindString(value: unknown, keys: readonly string[]): string | null {
  return deepFind(value, keys, (v): v is string => typeof v === 'string' && v.length > 0);
}

function deepFind<T>(
  value: unknown,
  keys: readonly string[],
  pred: (v: unknown) => v is T
): T | null {
  const visited = new WeakSet<object>();
  const stack: unknown[] = [value];
  while (stack.length) {
    const v = stack.pop();
    if (v === null || v === undefined) continue;
    if (typeof v === 'object') {
      if (visited.has(v as object)) continue;
      visited.add(v as object);
      const rec = asRecord(v);
      if (rec) {
        for (const k of keys) {
          if (k in rec && pred(rec[k])) return rec[k];
        }
        for (const child of Object.values(rec)) stack.push(child);
      } else if (Array.isArray(v)) {
        for (const child of v) stack.push(child);
      }
    }
  }
  return null;
}
