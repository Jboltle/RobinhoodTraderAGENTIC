/**
 * UNVERIFIED fixtures: nothing in this file was recorded.
 *
 * The recordings beside it (the .json files) come from SnapTrade's Sandbox
 * brokerage, which holds no option, and no order has been placed, cancelled or
 * quoted through SnapTrade yet. Every shape here is written from the SDK
 * 13.2.5 types and SnapTrade's own account of each field. Replace them with
 * recordings after the first Alpaca Paper run.
 */
import type {
  AccountOrderRecord,
  AccountPosition,
  CancelOrderResponse,
  MlegOrderResponse,
  OptionInstrument,
  SymbolsQuotesInner,
  UniversalSymbol,
} from 'snaptrade-typescript-sdk';

/** SPY 772 call expiring 2026-10-21, as SnapTrade writes an OCC symbol: root padded to six. */
export const SPY_CALL_OCC = 'SPY   261021C00772000';

const USD_CURRENCY = { id: 'currency-usd', code: 'USD', name: 'US Dollar' };

function listedSymbol(symbol: string): UniversalSymbol {
  return {
    id: `symbol-${symbol.toLowerCase()}`,
    symbol,
    raw_symbol: symbol,
    currency: USD_CURRENCY,
    type: { id: 'type-cs', code: 'cs', description: 'Common Stock' },
    currencies: [],
  };
}

/** A long option position: three contracts bought at a 1.59 premium, quoted per share. */
export function optionPosition(
  overrides: Partial<AccountPosition> = {},
  contract: Partial<OptionInstrument> = {}
): AccountPosition {
  return {
    instrument: {
      kind: 'option',
      id: 'option-spy-call',
      symbol: SPY_CALL_OCC,
      option_type: 'CALL',
      strike_price: '772',
      expiration_date: '2026-10-21',
      multiplier: '100',
      underlying: { kind: 'etf', id: 'symbol-spy', symbol: 'SPY', raw_symbol: 'SPY', currency: 'USD' },
      ...contract,
    },
    units: '3',
    price: '1.75',
    cost_basis: '1.59',
    currency: 'USD',
    ...overrides,
  };
}

/** An option order as the recent orders list is expected to carry it: filled, price per share. */
export function optionOrder(overrides: Partial<AccountOrderRecord> = {}): AccountOrderRecord {
  return {
    brokerage_order_id: 'option-order-1',
    status: 'EXECUTED',
    universal_symbol: null,
    option_symbol: {
      id: 'option-spy-call',
      ticker: SPY_CALL_OCC,
      option_type: 'CALL',
      strike_price: 772,
      expiration_date: '2026-10-21',
      underlying_symbol: listedSymbol('SPY'),
    },
    action: 'BUY_TO_OPEN',
    total_quantity: '3',
    open_quantity: '0',
    canceled_quantity: null,
    filled_quantity: '3',
    execution_price: '1.59',
    limit_price: '1.60',
    stop_price: null,
    order_type: 'Limit',
    time_in_force: 'Day',
    time_placed: '2026-10-21T15:18:06Z',
    time_executed: '2026-10-21T15:18:07Z',
    ...overrides,
  };
}

/** What the multi-leg option order call is expected to answer. */
export function optionOrderPlaced(status: AccountOrderRecord['status'] = 'PENDING'): MlegOrderResponse {
  return {
    brokerage_order_id: 'option-order-1',
    orders: [
      optionOrder({
        status,
        filled_quantity: '0',
        open_quantity: '3',
        execution_price: null,
        time_executed: null,
      }),
    ],
  };
}

/** What the equity order call is expected to answer: the order's own record. */
export function equityOrderPlaced(overrides: Partial<AccountOrderRecord> = {}): AccountOrderRecord {
  return {
    brokerage_order_id: 'equity-order-1',
    status: 'PENDING',
    universal_symbol: listedSymbol('AAPL'),
    option_symbol: null,
    action: 'BUY',
    total_quantity: '10',
    open_quantity: '10',
    filled_quantity: '0',
    execution_price: null,
    order_type: 'Market',
    time_in_force: 'Day',
    time_placed: '2026-10-21T15:18:06Z',
    ...overrides,
  };
}

export const ORDER_CANCELLED: CancelOrderResponse = { brokerage_order_id: 'option-order-1' };

export function equityQuote(symbol: string, lastTradePrice: number | undefined): SymbolsQuotesInner {
  return {
    symbol: listedSymbol(symbol),
    last_trade_price: lastTradePrice,
    bid_price: 150.2,
    ask_price: 150.3,
  };
}
