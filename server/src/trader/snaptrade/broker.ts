/**
 * The broker port over SnapTrade, for one brokerage account.
 *
 * Built from the SDK 13.2.5 types and read-only Sandbox recordings: no order
 * has been placed through it yet. What only a live order or a live account at
 * a real broker can confirm is marked `unverified:`.
 *
 * Request budget. SnapTrade allows 10 requests a minute per account, reads and
 * writes together. Nothing here polls, caches or retries, and every port
 * method is at most one request:
 *
 *   getAccount           1   balances
 *   getPositions(kind?)  1   every position, whichever `kind` is asked for
 *   getOrders            1   recent orders, the last 24 hours only
 *   placeOrder           1
 *   cancelOrder          1
 *   getMark              1 for stock; 0 for an option, which is always null
 *   confirmInstrument    1 for stock; 0 for an option, a format check only
 *
 * The SDK itself sleeps and resends on HTTP 429 (5, 10, then 20 seconds)
 * before it gives up, so a caller over the budget is held for up to 35 seconds.
 */
import type {
  AccountOrderRecord,
  AccountPosition,
  AllAccountPositionsResponse,
  Balance,
  CancelOrderResponse,
  ManualTradeFormWithOptions,
  MlegOrderResponse,
  MlegTradeForm,
  RecentOrdersResponse,
  SymbolsQuotesInner,
} from 'snaptrade-typescript-sdk';

import { createLogger } from '../../shared/logger.js';
import { OPTION_TYPES, type OrderSide } from '../../shared/types.js';
import { BrokerUnavailableError, SymbolNotFoundError } from '../broker/errors.js';
import { occSymbol, parseOccSymbol, roundPremiumToTick } from '../broker/instrument.js';
import type {
  Broker,
  BrokerAccount,
  BrokerOrder,
  BrokerPosition,
  Instrument,
  OptionInstrument,
  OrderRequest,
  PlacedOrder,
  TimeInForce,
} from '../broker/types.js';

const log = createLogger('trader:snaptrade');

// =============================================================================
// The SDK calls this adapter makes
// =============================================================================

interface Answer<T> {
  readonly data: T;
}

interface AccountRequest {
  readonly accountId: string;
}

interface RecentOrdersRequest extends AccountRequest {
  readonly onlyExecuted?: boolean;
}

interface QuotesRequest extends AccountRequest {
  /** Comma-separated; tickers when `useTicker` is set. */
  readonly symbols: string;
  readonly useTicker?: boolean;
}

interface CancelRequest extends AccountRequest {
  readonly brokerage_order_id: string;
}

/**
 * The SDK calls the adapter uses and no others, so a test passes a fake. A
 * `Snaptrade` client on a Personal key fits it as it stands. The option quote
 * call is left out on purpose: SnapTrade retired it (HTTP 410).
 */
export interface SnapTradeBrokerClient {
  // Function-typed members, not methods: only these are checked strictly, so
  // an SDK call that wanted more than the request here would not compile.
  readonly accountInformation: {
    readonly getUserAccountBalance: (request: AccountRequest) => Promise<Answer<Balance[]>>;
    readonly getAllAccountPositions: (
      request: AccountRequest
    ) => Promise<Answer<AllAccountPositionsResponse>>;
    readonly getUserAccountRecentOrders: (
      request: RecentOrdersRequest
    ) => Promise<Answer<RecentOrdersResponse>>;
  };
  readonly trading: {
    readonly getUserAccountQuotes: (request: QuotesRequest) => Promise<Answer<SymbolsQuotesInner[]>>;
    readonly placeMlegOrder: (request: AccountRequest & MlegTradeForm) => Promise<Answer<MlegOrderResponse>>;
    readonly placeForceOrder: (request: ManualTradeFormWithOptions) => Promise<Answer<AccountOrderRecord>>;
    readonly cancelOrder: (request: CancelRequest) => Promise<Answer<CancelOrderResponse>>;
  };
}

// =============================================================================
// Vocabulary: SnapTrade's words and the port's
// =============================================================================

const USD = 'USD';

type SnapTradeInstrument = AccountPosition['instrument'];
type ShareInstrument = Extract<SnapTradeInstrument, { kind: 'stock' | 'etf' | 'adr' | 'cef' }>;

/** Position kinds that trade as shares by ticker. Funds, crypto, bonds, futures and cash are not the port's equity. */
const SHARE_KINDS: ReadonlySet<string> = new Set(['stock', 'etf', 'adr', 'cef']);
/** The same four on an order row, which names its security by type code. */
const SHARE_TYPE_CODES: ReadonlySet<string> = new Set(['cs', 'et', 'ad', 'cef']);

/**
 * Underlyings whose options are listed under more than one OCC root (SPX and
 * SPXW share dates and strikes), so the ticker alone does not name a contract.
 * ponytail: refused here. Upgrade path: carry the OCC root on the Instrument.
 */
const MULTI_ROOT_UNDERLYINGS: ReadonlySet<string> = new Set(['SPX', 'NDX', 'RUT', 'VIX']);

/** A status SnapTrade sent that is not in ORDER_STATUS, or none at all. Never terminal. */
const UNKNOWN_STATUS = 'unknown';
const FILLED_STATUS = 'filled';
/** What a fill in the placement answer is stored as; see placedOrder. */
const ACCEPTED_STATUS = 'accepted';

/**
 * Every status in the SDK's AccountOrderRecordStatus, as the word the fill
 * sweep and TERMINAL_ORDER_STATES (shared/types.ts) read. Only the first seven
 * are terminal there.
 */
const ORDER_STATUS: Readonly<Record<string, string>> = {
  EXECUTED: FILLED_STATUS,
  PARTIAL: 'partially_filled',
  CANCELED: 'cancelled',
  // The port has no word for "part filled, rest cancelled": the row still
  // carries the filled quantity and price.
  PARTIAL_CANCELED: 'cancelled',
  REJECTED: 'rejected',
  FAILED: 'failed',
  EXPIRED: 'expired',
  NONE: 'none',
  PENDING: 'pending',
  ACCEPTED: ACCEPTED_STATUS,
  QUEUED: 'queued',
  TRIGGERED: 'triggered',
  ACTIVATED: 'activated',
  STOPPED: 'stopped',
  SUSPENDED: 'suspended',
  CANCEL_PENDING: 'cancel_pending',
  REPLACE_PENDING: 'replace_pending',
  REPLACED: 'replaced',
  PENDING_RISK_REVIEW: 'pending_risk_review',
  CONTINGENT_ORDER: 'contingent_order',
};

/** An order that comes back in one of these was not placed. */
const REFUSED_STATUSES: ReadonlySet<string> = new Set(['rejected', 'failed']);

const OPTION_ORDER_TYPE = { market: 'MARKET', limit: 'LIMIT', stop: 'STOP_LOSS_MARKET' } as const;
const EQUITY_ORDER_TYPE = { market: 'Market', limit: 'Limit', stop: 'Stop' } as const;
const TIME_IN_FORCE = { day: 'Day', gtc: 'GTC' } as const;
const DEFAULT_TIME_IN_FORCE: TimeInForce = 'day';

/** Bad or revoked key, disabled connection, access not granted: the account cannot be reached. */
const UNAVAILABLE_HTTP_STATUSES: ReadonlySet<number> = new Set([401, 402, 403]);
/** Where SnapTrade's error bodies put the reason, by endpoint. */
const DETAIL_KEYS = ['detail', 'default_detail', 'error', 'message'] as const;
const MAX_DETAIL_LENGTH = 300;

// =============================================================================
// The port
// =============================================================================

export class SnapTradeBroker implements Broker {
  constructor(
    private readonly client: SnapTradeBrokerClient,
    /** SnapTrade's id for the account: `accounts.external_account_id`. */
    private readonly accountId: string
  ) {}

  /**
   * What the account can spend without borrowing: the lower of cash and buying
   * power. A margin account's buying power counts money a long option cannot
   * be bought with, and sizing a percentage of it would multiply every entry.
   *
   * unverified: which figure SnapTrade puts in each field for Alpaca.
   * ponytail: no portfolio value; the balance call carries none. Upgrade path:
   * `net_value` from the account detail call, a second request.
   */
  async getAccount(): Promise<BrokerAccount> {
    const balances = await call('the balance read', () =>
      this.client.accountInformation.getUserAccountBalance({ accountId: this.accountId })
    );
    const dollars = balances.find((balance) => balance.currency?.code === USD);
    const spendable = [dollars?.cash, dollars?.buying_power].filter(
      (amount): amount is number => typeof amount === 'number' && Number.isFinite(amount)
    );
    if (spendable.length === 0) {
      throw new Error(`SnapTrade reported no ${USD} cash or buying power for the account`);
    }
    return { buyingPowerUsd: Math.min(...spendable), portfolioValueUsd: null };
  }

  /** SnapTrade prices no option contract; the shared quote source does (`quotesOptions` is false). */
  async getMark(instrument: Instrument): Promise<number | null> {
    return instrument.kind === 'option' ? null : this.lastTradePrice(instrument.symbol);
  }

  /**
   * ponytail: an option is checked for a symbol the order call can carry, not
   * against a chain; SDK 13 has no chain lookup. A contract that is not listed
   * is found out when the broker refuses the order.
   */
  async confirmInstrument(instrument: Instrument): Promise<void> {
    if (instrument.kind === 'option') {
      orderSymbol(instrument);
      return;
    }
    if ((await this.lastTradePrice(instrument.symbol)) === null) {
      throw new SymbolNotFoundError(`SnapTrade has no quote for ${instrument.symbol}`);
    }
  }

  /** One read returns every kind, so `kind` saves no request here; it only filters. */
  async getPositions(kind?: Instrument['kind']): Promise<readonly BrokerPosition[]> {
    const { results } = await call('the positions read', () =>
      this.client.accountInformation.getAllAccountPositions({ accountId: this.accountId })
    );
    const positions = results.flatMap((row) => brokerPosition(row) ?? []);
    return (['equity', 'option'] as const)
      .filter((wanted) => kind === undefined || kind === wanted)
      .flatMap((wanted) => positions.filter((position) => position.instrument.kind === wanted));
  }

  /** Working, filled and refused orders alike, placed in the last 24 hours; SnapTrade's recent list goes no further back. */
  async getOrders(): Promise<readonly BrokerOrder[]> {
    const { orders } = await call('the recent orders read', () =>
      this.client.accountInformation.getUserAccountRecentOrders({
        accountId: this.accountId,
        onlyExecuted: false,
      })
    );
    return (orders ?? []).flatMap((row) => brokerOrder(row) ?? []);
  }

  /** Rejects when the order is malformed, when SnapTrade fails the call, and when the order comes back refused. */
  async placeOrder(order: OrderRequest): Promise<PlacedOrder> {
    assertPlaceable(order);
    return order.instrument.kind === 'option'
      ? this.placeOptionOrder(order, order.instrument)
      : this.placeEquityOrder(order, order.instrument.symbol);
  }

  async cancelOrder(orderId: string): Promise<void> {
    await call('the order cancel', () =>
      this.client.trading.cancelOrder({ accountId: this.accountId, brokerage_order_id: orderId })
    );
  }

  /**
   * One leg through the multi-leg option call, as the Phase 0 script sends it.
   * A buy opens and a sell closes: this system never writes a contract.
   *
   * unverified: that the call takes a single leg at the account's broker; that
   * `price_effect` is wanted on one; that the price grid below is the one the
   * broker accepts; and that the id it answers with is the id recent orders
   * list the order under, which the fill read-back matches on.
   */
  private async placeOptionOrder(order: OrderRequest, contract: OptionInstrument): Promise<PlacedOrder> {
    const symbol = orderSymbol(contract);
    const placed = await call('the option order', () =>
      this.client.trading.placeMlegOrder({
        accountId: this.accountId,
        order_type: OPTION_ORDER_TYPE[order.type],
        time_in_force: TIME_IN_FORCE[order.timeInForce ?? DEFAULT_TIME_IN_FORCE],
        // The same grid a Robinhood order is rounded onto: a buy up, a sell down.
        ...(order.type === 'limit' ? { limit_price: tickPrice(order.limitPrice, order.side) } : {}),
        ...(order.type === 'stop' ? { stop_price: tickPrice(order.stopPrice, order.side) } : {}),
        price_effect: order.side === 'buy' ? 'DEBIT' : 'CREDIT',
        legs: [
          {
            instrument: { symbol, instrument_type: 'OPTION' },
            action: order.side === 'buy' ? 'BUY_TO_OPEN' : 'SELL_TO_CLOSE',
            units: order.quantity,
          },
        ],
      })
    );
    return placedOrder('option order', placed.brokerage_order_id, placed.orders?.[0]?.status);
  }

  /**
   * The SDK's direct equity order (`placeForceOrder`): one request, where
   * `placeOrder` there needs an impact check first.
   *
   * unverified: that a ticker with `universal_symbol_id` null reaches the
   * right listing at the account's broker.
   */
  private async placeEquityOrder(order: OrderRequest, symbol: string): Promise<PlacedOrder> {
    const placed = await call('the equity order', () =>
      this.client.trading.placeForceOrder({
        account_id: this.accountId,
        action: order.side === 'buy' ? 'BUY' : 'SELL',
        symbol,
        universal_symbol_id: null,
        order_type: EQUITY_ORDER_TYPE[order.type],
        time_in_force: TIME_IN_FORCE[order.timeInForce ?? DEFAULT_TIME_IN_FORCE],
        units: order.quantity,
        ...(order.type === 'limit' ? { price: order.limitPrice } : {}),
        ...(order.type === 'stop' ? { stop: order.stopPrice } : {}),
      })
    );
    return placedOrder('equity order', placed.brokerage_order_id, placed.status);
  }

  /**
   * The broker's last trade for a ticker, null when it returns none.
   *
   * unverified: that the quote call answers on a Personal key, and what it
   * answers for a ticker it does not know (taken here as no matching row).
   */
  private async lastTradePrice(symbol: string): Promise<number | null> {
    const ticker = symbol.toUpperCase();
    const quotes = await call('the quote read', () =>
      this.client.trading.getUserAccountQuotes({
        accountId: this.accountId,
        symbols: ticker,
        useTicker: true,
      })
    );
    // Matched on the full symbol, so a listing on another exchange (VAB.TO for VAB) is not taken for it.
    const quote = quotes.find((candidate) => candidate.symbol?.symbol?.toUpperCase() === ticker);
    return positiveNumber(quote?.last_trade_price);
  }
}

// =============================================================================
// Mapping
// =============================================================================

function isShares(instrument: SnapTradeInstrument): instrument is ShareInstrument {
  return SHARE_KINDS.has(instrument.kind);
}

/** Null for a holding the port has no instrument for, and for an option row that names no contract. */
function brokerPosition(position: AccountPosition): BrokerPosition | null {
  const held = position.instrument;
  let instrument: Instrument | null = null;
  if (isShares(held)) {
    instrument = { kind: 'equity', symbol: held.symbol };
  } else if (held.kind === 'option') {
    instrument = optionContract(held.symbol, {
      underlying: held.underlying?.symbol,
      optionType: held.option_type,
      strike: held.strike_price,
      expiration: held.expiration_date,
    });
  }
  if (instrument === null) return null;
  return {
    instrument,
    quantity: finiteNumber(position.units) ?? 0,
    // Per share on every kind, options included, so it is the premium as it stands.
    // unverified: that the account's broker reports an option's cost basis per share.
    averageEntryPrice: positiveNumber(position.cost_basis),
  };
}

/** Null for an order in something the port has no instrument for, or on a side it cannot name. */
function brokerOrder(order: AccountOrderRecord): BrokerOrder | null {
  const instrument = orderInstrument(order);
  const side = orderSide(order.action);
  if (instrument === null || side === null) return null;
  return {
    orderId: order.brokerage_order_id ?? null,
    instrument,
    side,
    status: portStatus(order.status),
    // Per share on an option order too, by the SDK's own account of the field,
    // and said so: the callers' Robinhood scale fix must leave it alone.
    fillPrice: positiveNumber(order.execution_price),
    fillPricePerShare: true,
    // The filled count, as on a Robinhood row: what the fill sweep reads on a partial fill.
    quantity: finiteNumber(order.filled_quantity) ?? 0,
    createdAt: order.time_placed ?? null,
  };
}

function orderInstrument(order: AccountOrderRecord): Instrument | null {
  const option = order.option_symbol;
  if (option) {
    return optionContract(option.ticker, {
      underlying: option.underlying_symbol?.symbol,
      optionType: option.option_type,
      strike: option.strike_price,
      expiration: option.expiration_date,
    });
  }
  const security = order.universal_symbol;
  if (!security || !SHARE_TYPE_CODES.has(security.type?.code ?? '')) return null;
  return { kind: 'equity', symbol: security.symbol };
}

/** BUY, BUY_OPEN, BUY_TO_CLOSE, SELL_SHORT, …: SnapTrade passes the broker's own word through. */
function orderSide(action: string | undefined): OrderSide | null {
  const word = action?.toUpperCase() ?? '';
  if (word.startsWith('BUY')) return 'buy';
  if (word.startsWith('SELL')) return 'sell';
  return null;
}

function portStatus(status: string | undefined): string {
  if (status === undefined) return UNKNOWN_STATUS;
  // Prefixed, so a word SnapTrade adds later can never read as terminal, least of all as filled.
  return ORDER_STATUS[status] ?? `${UNKNOWN_STATUS}:${status.toLowerCase()}`;
}

interface ContractFields {
  readonly underlying: string | undefined;
  readonly optionType: string | undefined;
  readonly strike: string | number | undefined;
  readonly expiration: string | undefined;
}

/**
 * The contract a position or order row names. The terms come from the OCC
 * symbol, and from the row's own fields when the symbol is not OCC; the ticker
 * is the row's underlying, which the OCC root is not always (SPXW on SPX).
 */
function optionContract(occ: string | undefined, fields: ContractFields): OptionInstrument | null {
  const parsed = occ === undefined ? null : parseOccSymbol(occ);
  const symbol = fields.underlying ?? parsed?.symbol;
  const optionType =
    parsed?.optionType ?? OPTION_TYPES.find((candidate) => candidate === fields.optionType?.toLowerCase());
  const strike = parsed?.strike ?? positiveNumber(fields.strike);
  const expiration = parsed?.expiration ?? fields.expiration;
  if (!symbol || !optionType || strike === null || !expiration) {
    log.warn('option row names no contract; left out', { symbol: occ ?? null });
    return null;
  }
  return { kind: 'option', symbol, optionType, strike, expiration };
}

/** The OCC symbol an order for the contract is sent under. */
function orderSymbol(contract: OptionInstrument): string {
  const ticker = contract.symbol.toUpperCase();
  if (MULTI_ROOT_UNDERLYINGS.has(ticker)) {
    throw new SymbolNotFoundError(
      `${ticker} options are listed under more than one OCC root; this adapter cannot tell which the order means`
    );
  }
  try {
    return occSymbol(contract);
  } catch (err) {
    throw new SymbolNotFoundError(err instanceof Error ? err.message : String(err));
  }
}

function assertPlaceable(order: OrderRequest): void {
  const contracts = order.instrument.kind === 'option';
  if (!(order.quantity > 0) || (contracts && !Number.isInteger(order.quantity))) {
    throw new Error(
      `order quantity must be a positive ${contracts ? 'whole number of contracts' : 'number of shares'}, got ${order.quantity}`
    );
  }
  if (order.type === 'limit' && !((order.limitPrice ?? 0) > 0)) {
    throw new Error(`a limit order needs a positive limit price, got ${order.limitPrice}`);
  }
  if (order.type === 'stop' && !((order.stopPrice ?? 0) > 0)) {
    throw new Error(`a stop order needs a positive stop price, got ${order.stopPrice}`);
  }
}

/** A premium on the option price grid, as the string the option order call takes. */
function tickPrice(premium: number | undefined, side: OrderSide): string {
  // assertPlaceable has already refused an order of this type without its price.
  return String(roundPremiumToTick(premium ?? 0, side, null));
}

/**
 * The port's answer to a placement. A refusal that arrives as an order status
 * (HTTP 200, status REJECTED) is thrown: it must never read as placed.
 */
function placedOrder(what: string, orderId: string | undefined, status: string | undefined): PlacedOrder {
  const state = portStatus(status);
  if (REFUSED_STATUSES.has(state)) {
    throw new Error(`SnapTrade ${what} ${orderId ?? '(no id)'} was ${state} by the broker`);
  }
  if (!orderId) {
    throw new Error(
      `SnapTrade answered the ${what} without an order id; check the account before sending it again`
    );
  }
  // An order stored as filled is never read again, and this answer carries no
  // fill price. Stored as accepted, the fill sweep reads price and count back.
  return { orderId, status: state === FILLED_STATUS ? ACCEPTED_STATUS : state };
}

// =============================================================================
// Numbers and failures
// =============================================================================

function finiteNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveNumber(value: string | number | null | undefined): number | null {
  const number = finiteNumber(value);
  return number !== null && number > 0 ? number : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** One SDK call, with its failure turned into the errors the port's callers handle. */
async function call<T>(what: string, send: () => Promise<Answer<T>>): Promise<T> {
  try {
    return (await send()).data;
  } catch (err) {
    throw brokerFailure(what, err);
  }
}

/**
 * The SDK's error is not kept as `cause`: it carries the request, and nothing
 * of the key may reach a log. The message is SnapTrade's own reason.
 */
function brokerFailure(what: string, err: unknown): Error {
  const status = isRecord(err) && typeof err.status === 'number' ? err.status : undefined;
  const message = `SnapTrade failed ${what}${status === undefined ? '' : ` (HTTP ${status})`}: ${failureDetail(err)}`;
  return status !== undefined && UNAVAILABLE_HTTP_STATUSES.has(status)
    ? new BrokerUnavailableError(message)
    : new Error(message);
}

function failureDetail(err: unknown): string {
  const body = isRecord(err) ? err.responseBody : undefined;
  if (isRecord(body)) {
    const reason = DETAIL_KEYS.map((key) => body[key]).find(
      (value) => typeof value === 'string' && value !== ''
    );
    return String(reason ?? JSON.stringify(body)).slice(0, MAX_DETAIL_LENGTH);
  }
  if (typeof body === 'string' && body !== '') return body.slice(0, MAX_DETAIL_LENGTH);
  // The SDK appends the response headers to its message; the first line is the failure.
  const text = err instanceof Error ? err.message : String(err);
  return (text.split('\n')[0] ?? text).slice(0, MAX_DETAIL_LENGTH);
}
