/**
 * Types for the Robinhood MCP layer: the raw call result, tool args/results,
 * OAuth persistence, and runtime token bootstrap. Runtime code lives in the
 * sibling modules; this file is types-only.
 */
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

// ---- MCP transport ----------------------------------------------------------

export interface CallToolResult {
  readonly content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  readonly isError?: boolean;
  readonly structuredContent?: Record<string, unknown>;
}

// ---- Tool results / caller-facing args --------------------------------------

export interface QuoteResult {
  readonly price: number;
  readonly raw: unknown;
}

export interface BuyingPowerResult {
  readonly amountUsd: number;
  readonly accountNumber: string | null;
  /** Total account value (get_portfolio total_value); null when absent. */
  readonly portfolioValueUsd: number | null;
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

export interface OptionsQuoteResult {
  /** Mid-market (mark) premium per contract unit (not × 100). */
  readonly markPrice: number;
  readonly raw: unknown;
}

export type OrderSide = 'buy' | 'sell';
export type OrderType = 'market' | 'limit';
export type TimeInForce = 'day' | 'gtc';

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

/** Ergonomic camelCase shape used by callers. */
export interface PlaceOptionsOrderArgs {
  readonly symbol: string;
  readonly optionType: 'call' | 'put';
  readonly strike: number;
  readonly expiration: string;      // YYYY-MM-DD
  readonly contracts: number;       // each controls 100 shares
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

// ---- OAuth persistence -------------------------------------------------------

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

// ---- Runtime token bootstrap --------------------------------------------------

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
