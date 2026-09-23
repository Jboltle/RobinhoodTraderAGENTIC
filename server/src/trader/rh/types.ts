/**
 * Types for the Robinhood MCP layer: the raw call result, tool args/results,
 * OAuth persistence, and runtime token bootstrap. Runtime code lives in the
 * sibling modules; this file is types-only.
 */
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

import type { OptionContract, OrderSide, OrderType } from '../../shared/types.js';

// ---- MCP transport ----------------------------------------------------------

export interface CallToolResult {
  readonly content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  readonly isError?: boolean;
  readonly structuredContent?: Record<string, unknown>;
}

/** JSON Schema fragment advertised by MCP `tools/list` for one tool. */
export interface ToolInputSchema {
  readonly type?: string;
  readonly properties?: Record<string, unknown>;
  readonly additionalProperties?: boolean;
  readonly required?: readonly string[];
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

export interface OptionPosition extends OptionContract {
  readonly symbol: string;
  readonly quantity: number;
  readonly raw: unknown;
}

export interface OptionPositionsResult {
  readonly positions: readonly OptionPosition[];
  readonly raw: unknown;
}

export interface OptionOrder extends OptionContract {
  readonly orderId: string | null;
  readonly symbol: string;
  readonly side: OrderSide;
  /** Robinhood order state: 'filled', 'cancelled', 'queued', … */
  readonly state: string | null;
  /**
   * Fill price exactly as Robinhood reports it. Robinhood quotes option
   * averages per contract on some endpoints (159.0) and per share on others
   * (1.59), so confirm the scale against a known fill before treating this as
   * a cost basis.
   */
  readonly averagePrice: number | null;
  readonly quantity: number;
  /** ISO timestamp; the ordering key for "most recently opened". */
  readonly createdAt: string | null;
  readonly raw: unknown;
}

export interface OptionOrdersResult {
  readonly orders: readonly OptionOrder[];
  readonly raw: unknown;
}

export interface OptionsQuoteResult {
  /** Mid-market (mark) premium per contract unit (not × 100). */
  readonly markPrice: number;
  readonly raw: unknown;
}

/**
 * Robinhood's price increments for one option contract (`min_ticks` on the
 * option instrument): premiums below `cutoffPrice` move in `belowTick` steps,
 * at/above it in `aboveTick` steps. A limit price off this grid is rejected
 * with API error 400 "Price does not satisfy the min tick value."
 */
export interface OptionMinTicks {
  readonly aboveTick: number;
  readonly belowTick: number;
  readonly cutoffPrice: number;
}

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

/** Broker acknowledgement of a placed order — equity and options alike. */
export interface PlaceOrderResult {
  readonly orderId: string | null;
  readonly status: string | null;
  readonly raw: unknown;
}

/** Ergonomic camelCase shape used by callers. */
export interface PlaceOptionsOrderArgs extends OptionContract {
  readonly symbol: string;
  readonly contracts: number;       // each controls 100 shares
  readonly side: OrderSide;
  readonly orderType: OrderType;
  readonly limitPremium?: number;
  readonly timeInForce?: TimeInForce;
}

// ---- OAuth persistence -------------------------------------------------------

/** The subset of the data layer the OAuth provider needs. */
export interface BrokerTokenStore {
  getBrokerTokens(userId: string): Promise<PersistedState | null>;
  saveBrokerTokens(userId: string, state: PersistedState): Promise<void>;
}

export interface SupabaseOAuthProviderOptions {
  readonly userId: string;
  readonly db: BrokerTokenStore;
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
  readonly hasRefreshToken: boolean;
}
