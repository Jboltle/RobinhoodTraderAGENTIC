import { createLogger } from '../../shared/logger.js';
import type { CallToolResult, RobinhoodMcpClient } from './mcpClient.js';

const log = createLogger('trader:rh:tools');

// =============================================================================
// Tool registry
//
// Each entry binds a logical capability (`ToolKind`) to:
//   - the exact MCP tool name advertised by Robinhood,
//   - a typed args shape sent on the wire,
//   - a typed result shape returned to callers,
//   - a parser that turns the raw `CallToolResult` into that shape.
//
// The registry is the single source of truth: `RobinhoodTools.call(kind, args)`
// is a fully type-safe dispatch — args/result are inferred from `kind`.
// =============================================================================

/** `get_equity_quotes` accepts a list of symbols (note the plural tool name). */
export interface QuoteArgs {
  readonly symbols: readonly string[];
}

export interface QuoteResult {
  readonly price: number;
  readonly raw: unknown;
}

export type EmptyArgs = Record<string, never>;

export interface BuyingPowerResult {
  readonly amountUsd: number;
  readonly raw: unknown;
}

export interface Position {
  readonly symbol: string;
  readonly quantity: number;
  readonly raw: unknown;
}

export interface PositionsResult {
  readonly positions: readonly Position[];
  readonly raw: unknown;
}

export type OrderSide = 'buy' | 'sell';
export type OrderType = 'market' | 'limit';
export type TimeInForce = 'day' | 'gtc';

/** Wire-format payload sent to the `place_equity_order` MCP tool. */
export interface PlaceOrderPayload {
  readonly symbol: string;
  readonly side: OrderSide;
  readonly type: OrderType;
  readonly quantity: number;
  readonly time_in_force: TimeInForce;
  readonly limit_price?: number;
  readonly price?: number;
}

/** Ergonomic camelCase shape used by callers (e.g. `executeTrade`). */
export interface PlaceOrderArgs {
  readonly symbol: string;
  readonly side: OrderSide;
  readonly orderType: OrderType;
  readonly quantity: number;
  readonly limitPrice?: number;
  readonly timeInForce?: TimeInForce;
}

export interface PlaceOrderResult {
  readonly orderId: string | null;
  readonly status: string | null;
  readonly raw: unknown;
}

export interface OrdersListResult {
  readonly raw: unknown;
}

// ---------------------------------------------------------------------------
// Options-specific types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Options quote — used to estimate premium for market-order sizing
// ---------------------------------------------------------------------------

export interface OptionsQuoteArgs {
  readonly symbol: string;
  readonly option_type: 'call' | 'put';
  readonly strike_price: number;
  readonly expiration_date: string; // YYYY-MM-DD
}

export interface OptionsQuoteResult {
  /** Mid-market (mark) premium per contract unit (not × 100). */
  readonly markPrice: number;
  readonly raw: unknown;
}

/** Wire-format payload sent to the `place_options_order` MCP tool. */
export interface PlaceOptionsOrderPayload {
  readonly symbol: string;
  readonly option_type: 'call' | 'put';
  readonly strike_price: number;
  readonly expiration_date: string; // YYYY-MM-DD
  readonly quantity: number;        // contracts (each controls 100 shares)
  readonly side: OrderSide;
  readonly type: OrderType;
  readonly time_in_force: TimeInForce;
  /** Per-contract limit premium (required for limit orders). */
  readonly price?: number;
}

/** Ergonomic camelCase shape used by callers. */
export interface PlaceOptionsOrderArgs {
  readonly symbol: string;
  readonly optionType: 'call' | 'put';
  readonly strike: number;
  readonly expiration: string;      // YYYY-MM-DD
  readonly contracts: number;
  readonly side: OrderSide;
  readonly orderType: OrderType;
  readonly limitPremium?: number;
  readonly timeInForce?: TimeInForce;
}

export interface PlaceOptionsOrderResult {
  readonly orderId: string | null;
  readonly status: string | null;
  readonly raw: unknown;
}

export interface RhToolMap {
  quote: { name: 'get_equity_quotes'; args: QuoteArgs; result: QuoteResult };
  optionsQuote: {
    name: 'get_option_quotes';
    args: OptionsQuoteArgs;
    result: OptionsQuoteResult;
  };
  // RH does not advertise a dedicated buying-power tool. `get_accounts`
  // typically returns buying_power on each account row; `get_portfolio`
  // is the alternate candidate. We default to `get_accounts` and let
  // `parseBuyingPower` deep-find for the relevant key.
  buyingPower: { name: 'get_accounts'; args: EmptyArgs; result: BuyingPowerResult };
  positions: { name: 'get_equity_positions'; args: EmptyArgs; result: PositionsResult };
  placeOrder: { name: 'place_equity_order'; args: PlaceOrderPayload; result: PlaceOrderResult };
  listOrders: { name: 'get_equity_orders'; args: EmptyArgs; result: OrdersListResult };
  placeOptionsOrder: {
    name: 'place_option_order';
    args: PlaceOptionsOrderPayload;
    result: PlaceOptionsOrderResult;
  };
  listOptionsOrders: { name: 'get_option_orders'; args: EmptyArgs; result: OrdersListResult };
}

export type ToolKind = keyof RhToolMap;
export type ToolName = RhToolMap[ToolKind]['name'];
export type ToolArgs<K extends ToolKind> = RhToolMap[K]['args'];
export type ToolResult<K extends ToolKind> = RhToolMap[K]['result'];

interface ToolDescriptor<K extends ToolKind> {
  readonly name: RhToolMap[K]['name'];
  readonly parse: (raw: CallToolResult) => RhToolMap[K]['result'];
}

type ToolRegistry = { [K in ToolKind]: ToolDescriptor<K> };

const TOOL_REGISTRY: ToolRegistry = {
  quote: { name: 'get_equity_quotes', parse: parseQuote },
  optionsQuote: { name: 'get_option_quotes', parse: parseOptionsQuote },
  buyingPower: { name: 'get_accounts', parse: parseBuyingPower },
  positions: { name: 'get_equity_positions', parse: parsePositions },
  placeOrder: { name: 'place_equity_order', parse: parsePlaceOrder },
  listOrders: { name: 'get_equity_orders', parse: parseListOrders },
  placeOptionsOrder: { name: 'place_option_order', parse: parsePlaceOrder },
  listOptionsOrders: { name: 'get_option_orders', parse: parseListOrders },
};

/** Canonical MCP tool name expected for each ToolKind. Read-only view of the registry. */
export const TOOL_NAMES: { readonly [K in ToolKind]: RhToolMap[K]['name'] } = {
  quote: TOOL_REGISTRY.quote.name,
  optionsQuote: TOOL_REGISTRY.optionsQuote.name,
  buyingPower: TOOL_REGISTRY.buyingPower.name,
  positions: TOOL_REGISTRY.positions.name,
  placeOrder: TOOL_REGISTRY.placeOrder.name,
  listOrders: TOOL_REGISTRY.listOrders.name,
  placeOptionsOrder: TOOL_REGISTRY.placeOptionsOrder.name,
  listOptionsOrders: TOOL_REGISTRY.listOptionsOrders.name,
};

// =============================================================================
// Public client
// =============================================================================

export class RobinhoodTools {
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

  getPositions(): Promise<PositionsResult> {
    return this.call('positions', {});
  }

  placeOrder(args: PlaceOrderArgs): Promise<PlaceOrderResult> {
    if (args.orderType === 'limit' && typeof args.limitPrice !== 'number') {
      throw new Error('limitPrice required for limit orders');
    }
    const payload: PlaceOrderPayload = {
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

  listRecentOrders(): Promise<OrdersListResult> {
    return this.call('listOrders', {});
  }

  placeOptionsOrder(args: PlaceOptionsOrderArgs): Promise<PlaceOptionsOrderResult> {
    if (args.orderType === 'limit' && typeof args.limitPremium !== 'number') {
      throw new Error('limitPremium (per-contract price) required for limit options orders');
    }
    const payload: PlaceOptionsOrderPayload = {
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

  listRecentOptionsOrders(): Promise<OrdersListResult> {
    return this.call('listOptionsOrders', {});
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
  const amountUsd =
    deepFindNumber(data, [
      'buying_power',
      'available_cash',
      'available_funds',
      'cash_available_for_withdrawal',
      'cash_balance',
    ]) ?? 0;
  return { amountUsd, raw: data ?? result };
}

function parsePositions(result: CallToolResult): PositionsResult {
  const data = structuredOrJson(result);
  const list = Array.isArray(data)
    ? data
    : asRecord(data)?.positions ?? asRecord(data)?.results ?? [];
  const positions: Position[] = [];
  if (Array.isArray(list)) {
    for (const item of list) {
      const symbol = deepFindString(item, ['symbol', 'ticker', 'instrument_symbol']);
      const quantity = deepFindNumber(item, ['quantity', 'shares', 'qty']) ?? 0;
      if (symbol) positions.push({ symbol, quantity, raw: item });
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

function parseListOrders(result: CallToolResult): OrdersListResult {
  return { raw: structuredOrJson(result) ?? result };
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
