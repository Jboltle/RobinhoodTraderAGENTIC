import { randomUUID } from 'node:crypto';

import { createLogger } from '../../shared/logger.js';
import type { OptionContract, OptionType, OrderSide } from '../../shared/types.js';
import type { RobinhoodMcpClient } from './mcpClient.js';
import { BrokerUnavailableError, McpToolError, assertTokenForTrade } from './mcpClient.js';
import type {
  BuyingPowerResult,
  CallToolResult,
  OptionMinTicks,
  OptionOrder,
  OptionOrdersResult,
  OptionPosition,
  OptionPositionsResult,
  OptionsQuoteResult,
  PlaceOptionsOrderArgs,
  PlaceOrderArgs,
  PlaceOrderResult,
  Position,
  PositionsResult,
  QuoteResult,
  TimeInForce,
  ToolInputSchema,
} from './types.js';

const log = createLogger('trader:rh:tools');

/** Canonical MCP tool names advertised by the Robinhood trading server. */
export const TOOL_NAMES = {
  quote: 'get_equity_quotes',
  optionsQuote: 'get_option_quotes',
  // `get_accounts` lists accounts (no dollar values); `get_portfolio` returns
  // buying power / total value for one account_number.
  accounts: 'get_accounts',
  portfolio: 'get_portfolio',
  positions: 'get_equity_positions',
  optionPositions: 'get_option_positions',
  optionOrders: 'get_option_orders',
  optionInstruments: 'get_option_instruments',
  placeOrder: 'place_equity_order',
  placeOptionsOrder: 'place_option_order',
} as const;

/**
 * The broker was reached and has no usable quote for the symbol — the one
 * failure that really means "not a tradable ticker".
 */
export class SymbolNotFoundError extends Error {
  override readonly name = 'SymbolNotFoundError';
}

// =============================================================================
// Public client
// =============================================================================

/** Option instrument UUID plus its price grid, resolved in one lookup. */
interface OptionInstrumentRef {
  readonly optionId: string;
  readonly minTicks: OptionMinTicks | null;
}

export class RobinhoodTools {
  private accountNumber: string | undefined;
  /** Contract key → instrument ref. Instrument ids and ticks never change. */
  private readonly optionIdCache = new Map<string, OptionInstrumentRef>();

  constructor(private readonly mcp: RobinhoodMcpClient) {}

  async getQuote(symbol: string): Promise<QuoteResult> {
    try {
      return await this.callTool(TOOL_NAMES.quote, { symbols: [symbol] }, parseQuote);
    } catch (err) {
      // The broker answered with a tool error for this symbol: it was reached,
      // so this is the ticker's fault, not the session's.
      if (err instanceof Error && err.cause instanceof McpToolError) {
        throw new SymbolNotFoundError(err.message, { cause: err });
      }
      throw err;
    }
  }

  /**
   * Fetch the mark price for a single-leg option contract.
   * Used for market-order options sizing (premium × 100 × contracts = notional).
   * Returns null if the MCP server doesn't advertise the tools, so callers can
   * fall back gracefully rather than throwing.
   */
  async getOptionsMarkPrice(
    symbol: string,
    optionType: OptionType,
    strike: number,
    expiration: string
  ): Promise<OptionsQuoteResult | null> {
    const advertised = await this.advertisedTools();
    if (
      !advertised.includes(TOOL_NAMES.optionsQuote) ||
      !advertised.includes(TOOL_NAMES.optionInstruments)
    ) {
      return null;
    }
    try {
      const instrument = await this.resolveOptionInstrument(symbol, optionType, strike, expiration);
      return await this.callTool(
        TOOL_NAMES.optionsQuote,
        { instrument_ids: [instrument.optionId] },
        parseOptionsQuote
      );
    } catch {
      return null;
    }
  }

  async getBuyingPower(): Promise<BuyingPowerResult> {
    if (!(await this.advertisedTools()).includes(TOOL_NAMES.portfolio)) {
      // ponytail: older MCP versions don't advertise get_portfolio; fall back
      // to deep-finding dollar fields on get_accounts rows (current servers
      // omit them, yielding amountUsd 0 / portfolioValueUsd null).
      return this.callTool(TOOL_NAMES.accounts, {}, parseBuyingPower);
    }
    const accountNumber = await this.getDefaultAccountNumber();
    return this.callTool(TOOL_NAMES.portfolio, { account_number: accountNumber }, (raw) =>
      parsePortfolio(raw, accountNumber)
    );
  }

  async getPositions(): Promise<PositionsResult> {
    return this.callTool(
      TOOL_NAMES.positions,
      { account_number: await this.getDefaultAccountNumber() },
      parsePositions
    );
  }

  async getOptionPositions(): Promise<OptionPositionsResult> {
    const result = await this.callTool(
      TOOL_NAMES.optionPositions,
      { account_number: await this.getDefaultAccountNumber() },
      parseOptionPositions
    );
    if (result.incomplete.length === 0) {
      return { positions: result.positions, raw: result.raw };
    }

    // Current RH MCP position rows carry only an option_id — no strike and no
    // call/put — so resolve those contracts in one batched instruments call.
    const ids = [...new Set(result.incomplete.map((row) => row.optionId))];
    const instruments = await this.callTool(
      TOOL_NAMES.optionInstruments,
      optionInstrumentIdArgs(this.optionInstrumentSchema(), ids),
      parseOptionInstruments
    );
    const positions = [...result.positions];
    for (const row of result.incomplete) {
      const contract = instruments.get(row.optionId);
      if (!contract) continue;
      positions.push({
        symbol: (row.symbol ?? contract.symbol).toUpperCase(),
        optionType: contract.optionType,
        strike: contract.strike,
        expiration: contract.expiration,
        quantity: row.quantity,
        raw: row.raw,
      });
    }
    return { positions, raw: result.raw };
  }

  /**
   * Historical option orders. Position rows carry no fill price and no
   * timestamp, so this is the only source for a real cost basis and for
   * ranking contracts by when they were opened. Returns null when the server
   * doesn't advertise the tool, so callers degrade instead of throwing.
   */
  async getOptionOrders(): Promise<OptionOrdersResult | null> {
    if (!(await this.advertisedTools()).includes(TOOL_NAMES.optionOrders)) return null;
    return this.callTool(
      TOOL_NAMES.optionOrders,
      { account_number: await this.getDefaultAccountNumber() },
      parseOptionOrders
    );
  }

  async placeOrder(args: PlaceOrderArgs): Promise<PlaceOrderResult> {
    await this.requireTokenForTrade();
    if (args.orderType === 'limit' && typeof args.limitPrice !== 'number') {
      throw new Error('limitPrice required for limit orders');
    }
    return this.callTool(
      TOOL_NAMES.placeOrder,
      {
        account_number: await this.getDefaultAccountNumber(),
        symbol: args.symbol,
        side: args.side,
        type: args.orderType,
        // RH MCP's schema types quantity and prices as strings, mirroring its
        // string-encoded numerics elsewhere ("100.0000"); raw numbers fail
        // validation with -32602.
        quantity: String(args.quantity),
        time_in_force: toRhTimeInForce(args.timeInForce),
        // Constant across withRetry attempts, so a retry after a lost
        // response can't fill the same order twice.
        ref_id: randomUUID(),
        ...(args.orderType === 'limit' && args.limitPrice !== undefined
          ? { limit_price: String(args.limitPrice) }
          : {}),
      },
      parsePlaceOrder
    );
  }

  async placeOptionsOrder(args: PlaceOptionsOrderArgs): Promise<PlaceOrderResult> {
    await this.requireTokenForTrade();
    if (args.orderType === 'limit' && typeof args.limitPremium !== 'number') {
      throw new Error('limitPremium (per-contract price) required for limit options orders');
    }
    const instrument = await this.resolveOptionInstrument(
      args.symbol,
      args.optionType,
      args.strike,
      args.expiration
    );

    // Callers relay premiums verbatim from callouts, which are often quoted on
    // another broker's grid (IBKR half-cents like 0.195); Robinhood rejects
    // off-grid prices with 400 "Price does not satisfy the min tick value".
    let limitPremium = args.limitPremium;
    if (args.orderType === 'limit' && typeof limitPremium === 'number') {
      const rounded = roundPremiumToTick(limitPremium, args.side, instrument.minTicks);
      if (rounded !== limitPremium) {
        log.info('rounded limit premium to Robinhood tick grid', {
          symbol: args.symbol,
          side: args.side,
          from: limitPremium,
          to: rounded,
        });
        limitPremium = rounded;
      }
    }

    return this.callTool(
      TOOL_NAMES.placeOptionsOrder,
      {
        account_number: await this.getDefaultAccountNumber(),
        legs: [
          {
            option_id: instrument.optionId,
            side: args.side,
            // ponytail: single-leg long-only mapping — buys open, sells close.
            // Opening a short (sell/open) needs a new PlaceOptionsOrderArgs
            // field if ever required; the pipeline only sells held positions.
            position_effect: args.side === 'buy' ? 'open' : 'close',
            ratio_quantity: 1,
          },
        ],
        type: args.orderType,
        quantity: String(args.contracts),
        time_in_force: toRhTimeInForce(args.timeInForce),
        ref_id: randomUUID(),
        // price is required for limit and must be OMITTED for market orders.
        ...(args.orderType === 'limit' && limitPremium !== undefined
          ? { price: String(limitPremium) }
          : {}),
      },
      parsePlaceOrder
    );
  }

  /**
   * Resolve a (symbol, type, strike, expiration) contract to the option
   * instrument UUID (and its min-tick grid) via get_option_instruments.
   */
  private async resolveOptionInstrument(
    symbol: string,
    optionType: OptionType,
    strike: number,
    expiration: string
  ): Promise<OptionInstrumentRef> {
    const key = `${symbol}|${optionType}|${strike}|${expiration}`;
    const cached = this.optionIdCache.get(key);
    if (cached) return cached;
    // Input schema (tools/list) is the source of truth. The empty-match *guide*
    // names response fields (expiration_date); sending that as an argument is
    // rejected with additionalProperties: false (-32602).
    const instrument = await this.callTool(
      TOOL_NAMES.optionInstruments,
      optionInstrumentLookupArgs(this.optionInstrumentSchema(), {
        symbol,
        optionType,
        strike,
        expiration,
      }),
      (raw) => parseOptionInstrumentRef(raw, `${symbol} ${strike.toFixed(4)} ${optionType} ${expiration}`)
    );
    this.optionIdCache.set(key, instrument);
    return instrument;
  }

  private async requireTokenForTrade(): Promise<void> {
    assertTokenForTrade(await this.mcp.getTokenStatus());
  }

  /**
   * Validate the live MCP server advertises the tool, call it with retries,
   * and parse the raw response into the typed result.
   */
  private async callTool<T>(
    name: string,
    args: Record<string, unknown>,
    parse: (raw: CallToolResult) => T
  ): Promise<T> {
    // A dropped or never-restored session reconnects here from stored tokens,
    // so trading self-heals instead of failing every callout until restart.
    // Throws BrokerUnavailableError when that needs a human (OAuth consent).
    const advertised = await this.advertisedTools();
    if (!advertised.includes(name)) {
      throw new Error(
        `Robinhood MCP does not advertise "${name}". Available: ${advertised.join(', ')}`
      );
    }
    return withRetry(name, async () => parse(await this.mcp.callTool(name, args)));
  }

  /** The live tool list, connecting first — empty before connect otherwise. */
  private async advertisedTools(): Promise<readonly string[]> {
    await this.mcp.ensureReady();
    return this.mcp.getToolNames();
  }

  /**
   * Resolve and cache the trading account from `get_accounts`, preferring the
   * agentic-allowed account: the `is_default` account is often one the agent
   * is NOT allowed to act on (agentic_allowed: false).
   */
  private async getDefaultAccountNumber(): Promise<string> {
    if (this.accountNumber) return this.accountNumber;
    const account = await this.callTool(TOOL_NAMES.accounts, {}, selectAccount);
    this.accountNumber = account.accountNumber;
    const masked = `••••${account.accountNumber.slice(-4)}`;
    log.info('selected Robinhood account', {
      account: masked,
      agenticAllowed: account.agenticAllowed,
    });
    if (!account.agenticAllowed) {
      log.warn('selected account is not agentic_allowed — order placement may be rejected', {
        account: masked,
      });
    }
    return this.accountNumber;
  }

  private optionInstrumentSchema(): ToolInputSchema | undefined {
    return this.mcp.getToolInputSchema?.(TOOL_NAMES.optionInstruments);
  }
}

// =============================================================================
// Live-schema argument builders
// =============================================================================

/** Input filter name from the July 2026 dump; `expiration_date` is a response field. */
const DEFAULT_EXPIRY_KEY = 'expiration_dates';

/** Build get_option_instruments args from the live tools/list schema. */
export function optionInstrumentLookupArgs(
  schema: ToolInputSchema | undefined,
  contract: OptionContract & { symbol: string }
): Record<string, unknown> {
  const props = schema?.properties;
  const expiryKey = pickSchemaKey(props, ['expiration_dates', 'expiration_date']);
  if (props && !expiryKey) {
    throw new Error(
      `get_option_instruments schema has no expiry filter. Properties: ${Object.keys(props).join(', ')}`
    );
  }
  const key = expiryKey ?? DEFAULT_EXPIRY_KEY;
  return retainSchemaProperties(
    {
      chain_symbol: contract.symbol,
      [key]: schemaScalarOrArray(props?.[key], contract.expiration),
      strike_price: contract.strike.toFixed(4),
      type: contract.optionType,
      state: 'active',
    },
    props
  );
}

/** Build a by-id get_option_instruments query from the live schema. */
export function optionInstrumentIdArgs(
  schema: ToolInputSchema | undefined,
  ids: readonly string[]
): Record<string, unknown> {
  const props = schema?.properties;
  const key = pickSchemaKey(props, ['ids', 'id', 'instrument_ids']);
  if (props && !key) {
    throw new Error(
      `get_option_instruments schema has no id filter. Properties: ${Object.keys(props).join(', ')}`
    );
  }
  const idKey = key ?? 'ids';
  const value = idKey === 'instrument_ids' ? [...ids] : ids.join(',');
  return retainSchemaProperties({ [idKey]: value }, props);
}

function pickSchemaKey(
  props: Record<string, unknown> | undefined,
  candidates: readonly string[]
): string | undefined {
  if (!props) return undefined;
  return candidates.find((k) => k in props);
}

function schemaScalarOrArray(spec: unknown, scalar: string): string | string[] {
  const rec = asRecord(spec);
  if (rec?.type === 'array' || rec?.items !== undefined) return [scalar];
  return scalar;
}

function retainSchemaProperties(
  args: Record<string, unknown>,
  props: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!props) return args;
  const kept: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k in props) kept[k] = v;
  }
  return kept;
}

// =============================================================================
// Per-tool parsers
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
    throw new SymbolNotFoundError(`no quote price: ${extractText(result).slice(0, 200)}`);
  }
  return { price, raw: data ?? result };
}

interface SelectedAccount {
  readonly accountNumber: string;
  readonly agenticAllowed: boolean;
}

/**
 * Pick the tradable account from the get_accounts list, in priority order:
 * agentic-allowed + active, then is_default, then the first row.
 */
function selectAccount(result: CallToolResult): SelectedAccount {
  const data = structuredOrJson(result);
  const rows = extractAccountRows(data);
  const pick =
    rows.find((r) => r.agentic_allowed === true && r.state === 'active') ??
    rows.find((r) => r.is_default === true) ??
    rows[0];
  const accountNumber = pick
    ? deepFindString(pick, ['account_number', 'accountNumber', 'account_id', 'id'])
    : null;
  if (!accountNumber) {
    throw new Error('could not determine Robinhood account_number from get_accounts');
  }
  return { accountNumber, agenticAllowed: pick?.agentic_allowed === true };
}

function extractAccountRows(value: unknown): Record<string, unknown>[] {
  const accounts =
    deepFind(value, ['accounts'], (v): v is unknown[] => Array.isArray(v)) ?? extractList(value);
  return accounts
    .map(asRecord)
    .filter((r): r is Record<string, unknown> => r !== null);
}

function parsePortfolio(result: CallToolResult, accountNumber: string): BuyingPowerResult {
  const data = structuredOrJson(result);
  // buying_power is nested ({ buying_power: { buying_power: "100.0000" } }),
  // so search for it alone first — otherwise a sibling `cash` key wins.
  const amountUsd =
    deepFindNumber(data, ['buying_power']) ??
    deepFindNumber(data, ['unleveraged_buying_power', 'cash']) ??
    0;
  const portfolioValueUsd = deepFindNumber(data, [
    'total_value',
    'portfolio_value',
    'equity_value',
  ]);
  return { amountUsd, accountNumber, portfolioValueUsd, raw: data ?? result };
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
  // Total account value from the same get_accounts row ('equity' is
  // Robinhood's name for total portfolio value, not stock-only).
  const portfolioValueUsd = deepFindNumber(data, [
    'portfolio_value',
    'total_equity',
    'equity',
    'market_value',
    'total_value',
  ]);
  return { amountUsd, accountNumber, portfolioValueUsd, raw: data ?? result };
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

function parseOptionOrders(result: CallToolResult): OptionOrdersResult {
  const data = structuredOrJson(result);
  const rows =
    deepFind(data, ['results', 'orders'], (v): v is unknown[] => Array.isArray(v)) ??
    extractList(data);

  const orders: OptionOrder[] = [];
  for (const item of rows) {
    const symbol = deepFindString(item, ['chain_symbol', 'symbol', 'underlying_symbol', 'ticker']);
    const optionType = normalizeOptionType(deepFindString(item, ['option_type', 'optionType']));
    const strike = deepFindNumber(item, ['strike_price', 'strike']);
    const expiration = deepFindString(item, ['expiration_date', 'expiration', 'expires_at']);
    // Legs carry `side`; only the order envelope carries `direction`. Searched
    // separately so a top-level 'direction' can't shadow a leg's 'side'.
    const side =
      normalizeOrderSide(deepFindString(item, ['side'])) ??
      normalizeOrderSide(deepFindString(item, ['direction']));
    if (!symbol || !optionType || strike === null || !expiration || !side) continue;

    orders.push({
      orderId: deepFindString(item, ['id', 'order_id']),
      symbol: symbol.toUpperCase(),
      optionType,
      strike,
      expiration: expiration.slice(0, 10),
      side,
      state: deepFindString(item, ['state', 'status']),
      averagePrice: deepFindNumber(item, ['average_price', 'average_fill_price', 'price']),
      quantity: deepFindNumber(item, ['processed_quantity', 'quantity', 'contracts']) ?? 0,
      createdAt: deepFindString(item, ['created_at', 'createdAt', 'updated_at']),
      raw: item,
    });
  }
  return { orders, raw: data ?? result };
}

/** A position row that only references its contract by option_id. */
interface IncompleteOptionPosition {
  readonly optionId: string;
  readonly symbol: string | null;
  readonly quantity: number;
  readonly raw: unknown;
}

interface ParsedOptionPositions extends OptionPositionsResult {
  readonly incomplete: readonly IncompleteOptionPosition[];
}

function parseOptionPositions(result: CallToolResult): ParsedOptionPositions {
  const data = structuredOrJson(result);
  const positions: OptionPosition[] = [];
  const incomplete: IncompleteOptionPosition[] = [];

  // The live server nests rows under data.results; older shapes were flat.
  const rows =
    deepFind(data, ['results', 'positions'], (v): v is unknown[] => Array.isArray(v)) ??
    extractList(data);
  for (const item of rows) {
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
      continue;
    }

    // Current RH MCP rows: `type` is direction (long/short), the contract is
    // only identified by option_id. Short rows are hedges/zero-quantity
    // mirrors, never positions this bot can sell to close.
    const optionId = deepFindString(item, ['option_id', 'instrument_id']);
    const direction = deepFindString(item, ['type'])?.toLowerCase();
    if (optionId && quantity > 0 && direction !== 'short') {
      incomplete.push({ optionId, symbol, quantity, raw: item });
    }
  }

  return { positions, incomplete, raw: data ?? result };
}

interface OptionInstrument extends OptionContract {
  readonly symbol: string;
}

/** Rows of get_option_instruments keyed by instrument UUID. */
function parseOptionInstruments(result: CallToolResult): Map<string, OptionInstrument> {
  const data = structuredOrJson(result);
  const list =
    deepFind(data, ['instruments', 'results'], (v): v is unknown[] => Array.isArray(v)) ?? [];
  const byId = new Map<string, OptionInstrument>();
  for (const item of list) {
    const rec = asRecord(item);
    if (!rec) continue;
    const id = typeof rec.id === 'string' ? rec.id : null;
    const symbol = deepFindString(rec, ['chain_symbol', 'symbol']);
    const optionType = normalizeOptionType(deepFindString(rec, ['type', 'option_type']));
    const strike = deepFindNumber(rec, ['strike_price', 'strike']);
    const expiration = deepFindString(rec, ['expiration_date', 'expiration']);
    if (id && symbol && optionType && strike !== null && expiration) {
      byId.set(id, { symbol, optionType, strike, expiration: expiration.slice(0, 10) });
    }
  }
  return byId;
}

function parseOptionInstrumentRef(result: CallToolResult, contract: string): OptionInstrumentRef {
  const data = structuredOrJson(result);
  const list =
    deepFind(data, ['instruments', 'results'], (v): v is unknown[] => Array.isArray(v)) ?? [];
  for (const item of list) {
    const rec = asRecord(item);
    const id = rec?.id;
    if (typeof id === 'string' && id.length > 0) {
      return { optionId: id, minTicks: parseMinTicks(rec?.min_ticks) };
    }
  }
  throw new Error(
    `no option instrument matched ${contract}: ${extractText(result).slice(0, 200)}`
  );
}

/** `min_ticks` rows encode the grid as strings ("0.05"); null when absent/partial. */
function parseMinTicks(value: unknown): OptionMinTicks | null {
  const rec = asRecord(value);
  if (!rec) return null;
  const aboveTick = deepFindNumber(rec, ['above_tick']);
  const belowTick = deepFindNumber(rec, ['below_tick']);
  const cutoffPrice = deepFindNumber(rec, ['cutoff_price']);
  if (aboveTick === null || belowTick === null || cutoffPrice === null) return null;
  if (aboveTick <= 0 || belowTick <= 0) return null;
  return { aboveTick, belowTick, cutoffPrice };
}

// =============================================================================
// Price grid rounding
// =============================================================================

/**
 * The standard US options grid (penny below $3, nickel above), used when the
 * instrument row carries no `min_ticks`. Exact for penny-program symbols and
 * never produces sub-penny prices, which is the failure seen in the wild.
 */
const DEFAULT_MIN_TICKS: OptionMinTicks = { aboveTick: 0.05, belowTick: 0.01, cutoffPrice: 3 };

const TICK_EPSILON = 1e-9;

/**
 * Snap a per-contract premium onto the instrument's price grid. Buys round up
 * and sells round down so the rounded order is always at least as marketable
 * as the requested one (cost: under one tick per contract).
 */
export function roundPremiumToTick(
  premium: number,
  side: OrderSide,
  minTicks: OptionMinTicks | null
): number {
  const grid = minTicks ?? DEFAULT_MIN_TICKS;
  const tick = premium < grid.cutoffPrice ? grid.belowTick : grid.aboveTick;
  const steps =
    side === 'buy'
      ? Math.ceil(premium / tick - TICK_EPSILON)
      : Math.floor(premium / tick + TICK_EPSILON);
  // A sell floored to zero is off-grid too; the smallest valid price is one tick.
  const snapped = Math.max(tick, steps * tick);
  return Number(snapped.toFixed(4));
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

const RETRY_ATTEMPTS = 3;
const RETRY_INITIAL_DELAY_MS = 250;

/** RH MCP spells day orders 'gfd'; callers use the conventional 'day'. */
function toRhTimeInForce(tif: TimeInForce | undefined): 'gfd' | 'gtc' {
  return tif === 'gtc' ? 'gtc' : 'gfd';
}

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < RETRY_ATTEMPTS; i++) {
    try {
      return await fn();
    } catch (err) {
      // Deterministic answers: retrying cannot change them, only delay them.
      if (err instanceof BrokerUnavailableError || err instanceof SymbolNotFoundError) throw err;
      lastErr = err;
      log.warn('tool call failed, will retry', {
        label,
        attempt: i + 1,
        attempts: RETRY_ATTEMPTS,
        error: (err as Error).message,
      });
      if (i < RETRY_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, RETRY_INITIAL_DELAY_MS * Math.pow(2, i)));
      }
    }
  }
  throw lastErr instanceof Error
    ? new Error(`${label} failed after ${RETRY_ATTEMPTS} attempts: ${lastErr.message}`, {
        cause: lastErr,
      })
    : new Error(`${label} failed after ${RETRY_ATTEMPTS} attempts`);
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

/**
 * Order legs spell the side 'buy'/'sell'; the order envelope spells it
 * 'debit'/'credit'. For the single-leg long-only orders this system places, a
 * debit opens a long and a credit closes it.
 */
function normalizeOrderSide(value: string | null): OrderSide | null {
  const normalized = value?.toLowerCase();
  if (normalized === 'buy' || normalized === 'debit') return 'buy';
  if (normalized === 'sell' || normalized === 'credit') return 'sell';
  return null;
}

function normalizeOptionType(value: string | null): OptionType | null {
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

// RH MCP payloads encode dollar amounts as strings ("100.0000"); coerce
// numeric strings so parsers work with either convention.
function deepFindNumber(value: unknown, keys: readonly string[]): number | null {
  const found = deepFind(
    value,
    keys,
    (v): v is number | string =>
      (typeof v === 'number' && Number.isFinite(v)) ||
      (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)))
  );
  return found === null ? null : Number(found);
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
