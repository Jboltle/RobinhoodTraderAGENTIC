/**
 * Types for the Robinhood MCP layer: the raw call result, the typed tool
 * registry (args/results/wire payloads), OAuth persistence, and runtime token
 * bootstrap. Runtime code lives in the sibling modules; this file is types-only.
 */
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

// =============================================================================
// MCP transport
// =============================================================================

export interface CallToolResult {
  readonly content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  readonly isError?: boolean;
  readonly structuredContent?: Record<string, unknown>;
}

// =============================================================================
// Tool args / results / wire payloads
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

export interface AccountScopedArgs {
  readonly account_number: string;
}

export interface BuyingPowerResult {
  readonly amountUsd: number;
  readonly accountNumber: string | null;
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

export interface OptionPosition {
  readonly symbol: string;
  readonly optionType: 'call' | 'put';
  readonly strike: number;
  readonly expiration: string;
  readonly quantity: number;
  readonly raw: unknown;
}

export interface OptionPositionsResult {
  readonly positions: readonly OptionPosition[];
  readonly raw: unknown;
}

export type OrderSide = 'buy' | 'sell';
export type OrderType = 'market' | 'limit';
export type TimeInForce = 'day' | 'gtc';

/** Wire-format payload sent to the `place_equity_order` MCP tool. */
export interface PlaceOrderPayload {
  readonly account_number: string;
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

/** Options quote — used to estimate premium for market-order sizing. */
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
  readonly account_number: string;
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

// =============================================================================
// Tool registry
// =============================================================================

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
  positions: { name: 'get_equity_positions'; args: AccountScopedArgs; result: PositionsResult };
  optionPositions: { name: 'get_option_positions'; args: AccountScopedArgs; result: OptionPositionsResult };
  placeOrder: { name: 'place_equity_order'; args: PlaceOrderPayload; result: PlaceOrderResult };
  placeOptionsOrder: {
    name: 'place_option_order';
    args: PlaceOptionsOrderPayload;
    result: PlaceOptionsOrderResult;
  };
}

export type ToolKind = keyof RhToolMap;
export type ToolName = RhToolMap[ToolKind]['name'];
export type ToolArgs<K extends ToolKind> = RhToolMap[K]['args'];
export type ToolResult<K extends ToolKind> = RhToolMap[K]['result'];

export interface ToolDescriptor<K extends ToolKind> {
  readonly name: RhToolMap[K]['name'];
  readonly parse: (raw: CallToolResult) => RhToolMap[K]['result'];
}

export type ToolRegistry = { [K in ToolKind]: ToolDescriptor<K> };

// =============================================================================
// OAuth persistence
// =============================================================================

export interface FileOAuthProviderOptions {
  readonly path: string;
  readonly clientName: string;
  readonly redirectUri: string;
  readonly onAuthorizationUrl: (url: URL) => void | Promise<void>;
}

export interface PersistedState {
  client?: OAuthClientInformationFull;
  tokens?: OAuthTokens;
  codeVerifier?: string;
}

// =============================================================================
// Runtime token bootstrap
// =============================================================================

export type TokenState = 'missing' | 'valid' | 'refreshable' | 'expired';

export interface TokenStatus {
  readonly state: TokenState;
  /** Seconds until the access token's `exp`; null when unknown/missing. */
  readonly expiresInSec: number | null;
  readonly hasRefreshToken: boolean;
}

/** Shape of the persisted token file, as read by the bootstrap. */
export interface StoredTokens {
  access_token?: string;
  refresh_token?: string;
}

export interface StoredState {
  tokens?: StoredTokens;
}

/** A single credential entry as stored by Codex in ~/.codex/.credentials.json. */
export interface CodexCredential {
  server_name: string;
  server_url: string;
  client_id: string;
  access_token: string;
  expires_at: number;
  refresh_token: string;
  scopes: string[];
}

export interface ImportCodexOptions {
  readonly path: string;
  readonly redirectUri: string;
  readonly clientName: string;
  /** Import the refresh token too (enables silent refresh). Default false. */
  readonly includeRefreshToken?: boolean;
}

export type ImportCodexResult =
  | { readonly imported: true; readonly expiresInSec: number }
  | { readonly imported: false; readonly reason: string };
