import type { OptionType, OrderSide } from '../../shared/types.js';
import type { RobinhoodMcpClient } from '../robinhood/mcpClient.js';

/** What an order, a position or a price refers to. */
export type Instrument =
  | { readonly kind: 'equity'; readonly symbol: string }
  | {
      readonly kind: 'option';
      readonly symbol: string;
      readonly optionType: OptionType;
      readonly strike: number;
      readonly expiration: string;
    };

export type OptionInstrument = Extract<Instrument, { kind: 'option' }>;

export interface BrokerAccount {
  readonly buyingPowerUsd: number;
  /** Total account value; null when the broker reports none. */
  readonly portfolioValueUsd: number | null;
}

export interface BrokerPosition {
  readonly instrument: Instrument;
  /** Shares for equity, contracts for options. */
  readonly quantity: number;
  /** Per-unit average cost from the broker's own position row; null when the row carries none. */
  readonly averageEntryPrice: number | null;
}

export interface BrokerOrder {
  readonly orderId: string | null;
  readonly instrument: Instrument;
  readonly side: OrderSide;
  /** The broker's own state word: 'filled', 'cancelled', 'queued', … */
  readonly status: string | null;
  /**
   * Average fill price exactly as the broker reports it. Robinhood reports an
   * option fill per contract on some endpoints (159.0) and per share on others
   * (1.59); callers that need a cost basis scale it with normalizeOptionPremium.
   */
  readonly fillPrice: number | null;
  readonly quantity: number;
  /** ISO timestamp; the ordering key for "most recently opened". */
  readonly createdAt: string | null;
}

export type TimeInForce = 'day' | 'gtc';

export interface OrderRequest {
  readonly instrument: Instrument;
  readonly side: OrderSide;
  /** Shares for equity, contracts for options. */
  readonly quantity: number;
  readonly type: 'market' | 'limit' | 'stop';
  /** Per-unit price; required for a limit order. */
  readonly limitPrice?: number;
  /** Trigger price; required for a stop order. */
  readonly stopPrice?: number;
  readonly timeInForce?: TimeInForce;
}

export interface PlacedOrder {
  readonly orderId: string | null;
  readonly status: string | null;
}

/**
 * The project's own broker interface. The pipeline and the monitors call only
 * this; each broker connection is an adapter behind it.
 */
export interface Broker {
  getAccount(): Promise<BrokerAccount>;
  /** Current per-unit price. Null when this broker cannot price the instrument. */
  getMark(instrument: Instrument): Promise<number | null>;
  /** Rejects with SymbolNotFoundError when the broker cannot trade the instrument. */
  confirmInstrument(instrument: Instrument): Promise<void>;
  /**
   * Every position row the broker returns, equity first, zero quantities
   * included. `kind` limits the read to that kind, for brokers (Robinhood)
   * where equity and option positions are separate calls.
   */
  getPositions(kind?: Instrument['kind']): Promise<readonly BrokerPosition[]>;
  /** Order history. Null when the broker offers none. */
  getOrders(): Promise<readonly BrokerOrder[] | null>;
  placeOrder(order: OrderRequest): Promise<PlacedOrder>;
  cancelOrder(orderId: string): Promise<void>;
}

/** How an account is reached: the adapter that opens it. */
export type BrokerId = 'robinhood' | 'snaptrade';

/** What reaching a SnapTrade account needs beyond the shared columns. */
export interface SnapTradeAdapterData {
  /** The brokerage connection the account came from (`connection_id`). */
  readonly connectionId: string;
  /** The connection's `brokerage.slug`. */
  readonly institutionSlug: string;
  /** Last four digits only; SnapTrade gives no full number. */
  readonly maskedAccountNumber: string | null;
}

interface AccountIdentity {
  readonly id: string;
  readonly userId: string;
  /** Which broker holds it: 'robinhood', 'alpaca-paper', … */
  readonly institution: string;
  /** The broker's own account id; null on a direct Robinhood account. */
  readonly externalAccountId: string | null;
  readonly label: string;
  readonly isPaper: boolean;
  readonly needsReconnect: boolean;
}

/**
 * One connected brokerage account: an `accounts` row without its settings or
 * credentials. `adapterData` is whatever that adapter needs to reach it.
 */
export type AccountRow =
  | (AccountIdentity & { readonly adapter: 'robinhood'; readonly adapterData: Record<string, never> })
  | (AccountIdentity & { readonly adapter: 'snaptrade'; readonly adapterData: SnapTradeAdapterData });

// ponytail: the session is still the Robinhood MCP client class. Upgrade path:
// a BrokerSession interface once a second adapter has a session of its own.
/** One account's session and the Broker over it. */
export interface UserBroker {
  readonly session: RobinhoodMcpClient;
  readonly broker: Broker;
  /** Its adapter's `quotesOptions`, stamped on by the registry. */
  readonly quotesOptions: boolean;
}

/** Opens one account's broker session; the registry holds the result per account. */
export interface BrokerAdapter {
  readonly id: BrokerId;
  /** Whether this broker can price option contracts; the shared quote source asks only these. */
  readonly quotesOptions: boolean;
  open(account: AccountRow): Omit<UserBroker, 'quotesOptions'>;
}
