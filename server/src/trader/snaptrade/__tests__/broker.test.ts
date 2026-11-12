/**
 * SnapTradeBroker is the port over the SnapTrade SDK. These tests pin what
 * leaves the process (each port call must reach the SDK as one named call with
 * exact arguments) and what comes back in the port's shape.
 *
 * No test builds the SDK client: the broker gets a fake of the narrow client
 * interface, so nothing here can reach SnapTrade whatever the environment holds.
 *
 * Fixtures. `fixtures/*.json` are answers recorded read-only from SnapTrade's
 * Sandbox brokerage: rows are as recorded, lists are cut to the rows a test
 * reads, and the order rows come from the 30-day order history (the Sandbox's
 * recent list was empty) with the account-scoped symbol id removed.
 * `fixtures/unverified.ts` holds every option, order placement, cancel and
 * quote shape: those are written from the SDK types and were never recorded.
 */
import { readFileSync } from 'node:fs';

import type {
  AccountOrderRecord,
  AccountPosition,
  AllAccountPositionsResponse,
  Balance,
  CancelOrderResponse,
  MlegOrderResponse,
  PersonalApiKeyAuth,
  RecentOrdersResponse,
  Snaptrade,
  SymbolsQuotesInner,
} from 'snaptrade-typescript-sdk';
import { describe, expect, it } from 'vitest';

import { isTerminalOrderState } from '../../../shared/types.js';
import { BrokerUnavailableError, SymbolNotFoundError } from '../../broker/errors.js';
import type { Instrument, OrderRequest } from '../../broker/types.js';
import { SnapTradeBroker, type SnapTradeBrokerClient } from '../broker.js';
import { fakeSnapTradeClient, type FakeSnapTradeAnswers, type RecordedCall } from './fakeClient.js';
import {
  equityOrderPlaced,
  equityQuote,
  optionOrder,
  optionOrderPlaced,
  optionPosition,
  ORDER_CANCELLED,
  SPY_CALL_OCC,
} from './fixtures/unverified.js';

const ACCOUNT_ID = 'snaptrade-account-1';

const SPY_CALL: Instrument = {
  kind: 'option',
  symbol: 'SPY',
  optionType: 'call',
  strike: 772,
  expiration: '2026-10-21',
};
const AAPL: Instrument = { kind: 'equity', symbol: 'AAPL' };

function recorded<T>(name: string): T {
  // The one place a recording becomes an SDK type: JSON carries none.
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as T;
}

const CASH_BALANCES = recorded<Balance[]>('balances.cash');
const MARGIN_BALANCES = recorded<Balance[]>('balances.margin');
const CASH_POSITIONS = recorded<AllAccountPositionsResponse>('positions.cash');
const MARGIN_POSITIONS = recorded<AllAccountPositionsResponse>('positions.margin');
const ORDERS = recorded<RecentOrdersResponse>('orders');

function positionsOf(...results: AccountPosition[]): AllAccountPositionsResponse {
  return { ...MARGIN_POSITIONS, results };
}

/** The SDK client on a Personal key is the adapter's client as it stands; never built here. */
export type SdkClientFits = Snaptrade<PersonalApiKeyAuth> extends SnapTradeBrokerClient ? true : never;
const SDK_CLIENT_FITS: SdkClientFits = true;

interface Fake {
  readonly broker: SnapTradeBroker;
  /** Every SDK call the broker made, in order. */
  readonly calls: RecordedCall[];
}

function fake(answers: FakeSnapTradeAnswers = {}): Fake {
  const { client, calls } = fakeSnapTradeClient(answers);
  return { broker: new SnapTradeBroker(client, ACCOUNT_ID), calls };
}

/** An SDK failure as SnaptradeError carries it: an HTTP status and the parsed body. */
function sdkFailure(status: number, responseBody: unknown): Error {
  return Object.assign(
    new Error(`Request failed with status code ${status}\nRESPONSE HEADERS:\n{"x-request-id":"abc"}`),
    { status, responseBody, url: 'https://api.snaptrade.com/api/v1/accounts' }
  );
}

function orderRequest(overrides: Partial<OrderRequest> = {}): OrderRequest {
  return { instrument: SPY_CALL, side: 'buy', quantity: 3, type: 'limit', limitPrice: 1.6, ...overrides };
}

describe('the SDK client', () => {
  it('fits the adapter client interface on a Personal key', () => {
    expect(SDK_CLIENT_FITS).toBe(true);
  });
});

describe('SnapTradeBroker reads', () => {
  describe('getAccount', () => {
    it('reads the balance once and reports cash as buying power', async () => {
      const { broker, calls } = fake({ balances: CASH_BALANCES });

      expect(await broker.getAccount()).toStrictEqual({ buyingPowerUsd: 12500, portfolioValueUsd: null });
      expect(calls).toStrictEqual([['accountInformation.getUserAccountBalance', { accountId: ACCOUNT_ID }]]);
    });

    it('takes the lower of cash and margin buying power', async () => {
      const { broker } = fake({ balances: MARGIN_BALANCES });

      expect((await broker.getAccount()).buyingPowerUsd).toBe(25000);
    });

    it('uses whichever figure the broker reports when the other is missing', async () => {
      const usd = { code: 'USD' };

      expect(
        (await fake({ balances: [{ currency: usd, cash: null, buying_power: 900 }] }).broker.getAccount())
          .buyingPowerUsd
      ).toBe(900);
      expect(
        (await fake({ balances: [{ currency: usd, cash: 400 }] }).broker.getAccount()).buyingPowerUsd
      ).toBe(400);
    });

    it('reads the dollar row among several currencies', async () => {
      const { broker } = fake({
        balances: [{ currency: { code: 'CAD' }, cash: 99999, buying_power: 99999 }, ...CASH_BALANCES],
      });

      expect((await broker.getAccount()).buyingPowerUsd).toBe(12500);
    });

    it('rejects rather than size against nothing when no dollar figure comes back', async () => {
      await expect(fake({ balances: [] }).broker.getAccount()).rejects.toThrow(/no USD cash or buying power/);
      await expect(
        fake({
          balances: [{ currency: { code: 'USD' }, cash: null, buying_power: null }],
        }).broker.getAccount()
      ).rejects.toThrow(/no USD cash or buying power/);
    });
  });

  describe('getPositions', () => {
    it('reads every position once and returns the shares, leaving funds out', async () => {
      const { broker, calls } = fake({ positions: CASH_POSITIONS });

      expect(await broker.getPositions()).toStrictEqual([
        { instrument: { kind: 'equity', symbol: 'NVDA' }, quantity: 12, averageEntryPrice: 115 },
        { instrument: { kind: 'equity', symbol: 'GOOGL' }, quantity: 3, averageEntryPrice: 165 },
      ]);
      expect(calls).toStrictEqual([['accountInformation.getAllAccountPositions', { accountId: ACCOUNT_ID }]]);
    });

    it('counts an ETF as equity and leaves crypto out', async () => {
      const { broker } = fake({ positions: MARGIN_POSITIONS });

      expect(await broker.getPositions()).toStrictEqual([
        { instrument: { kind: 'equity', symbol: 'AAPL' }, quantity: 5, averageEntryPrice: 175 },
        { instrument: { kind: 'equity', symbol: 'SPY' }, quantity: 15, averageEntryPrice: 540 },
      ]);
    });

    it('returns an option with its contract and its cost per share as reported', async () => {
      const { broker } = fake({ positions: positionsOf(optionPosition(), ...MARGIN_POSITIONS.results) });

      // 1.59 stays 1.59: SnapTrade reports an option's cost basis per share, so nothing is divided by 100.
      expect(await broker.getPositions('option')).toStrictEqual([
        { instrument: SPY_CALL, quantity: 3, averageEntryPrice: 1.59 },
      ]);
    });

    it('returns equity before options, and one read serves either kind', async () => {
      const positions = positionsOf(optionPosition(), ...MARGIN_POSITIONS.results);
      const all = fake({ positions });
      const equity = fake({ positions });

      expect((await all.broker.getPositions()).map((position) => position.instrument.kind)).toStrictEqual([
        'equity',
        'equity',
        'option',
      ]);
      expect(
        (await equity.broker.getPositions('equity')).map((position) => position.instrument.symbol)
      ).toStrictEqual(['AAPL', 'SPY']);
      expect(all.calls).toHaveLength(1);
      expect(equity.calls).toHaveLength(1);
    });

    it('keeps a closed position at zero and reports no entry price when the cost basis is missing', async () => {
      const { broker } = fake({
        positions: positionsOf(
          optionPosition({ units: '0', cost_basis: null }),
          optionPosition({ units: null, cost_basis: '0' }),
          optionPosition({ cost_basis: undefined })
        ),
      });

      expect(await broker.getPositions()).toStrictEqual([
        { instrument: SPY_CALL, quantity: 0, averageEntryPrice: null },
        { instrument: SPY_CALL, quantity: 0, averageEntryPrice: null },
        { instrument: SPY_CALL, quantity: 3, averageEntryPrice: null },
      ]);
    });

    it('reads the contract from an unpadded OCC symbol, and the ticker from the underlying', async () => {
      const { broker } = fake({
        positions: positionsOf(
          optionPosition({}, { symbol: 'SPY261021C00772000' }),
          optionPosition(
            {},
            {
              symbol: 'SPXW  261021P05000000',
              underlying: {
                kind: 'other',
                id: 'symbol-spx',
                symbol: 'SPX',
                raw_symbol: 'SPX',
                currency: 'USD',
              },
            }
          )
        ),
      });

      expect((await broker.getPositions()).map((position) => position.instrument)).toStrictEqual([
        SPY_CALL,
        { kind: 'option', symbol: 'SPX', optionType: 'put', strike: 5000, expiration: '2026-10-21' },
      ]);
    });

    it('falls back to the row fields when the symbol is not OCC, and leaves out a row naming no contract', async () => {
      const { broker } = fake({
        positions: positionsOf(
          optionPosition({}, { symbol: 'SPY 21OCT26 772 C' }),
          optionPosition({}, { symbol: 'not-occ', strike_price: '' })
        ),
      });

      expect(await broker.getPositions()).toStrictEqual([
        { instrument: SPY_CALL, quantity: 3, averageEntryPrice: 1.59 },
      ]);
    });
  });

  describe('getOrders', () => {
    it('reads recent orders once, working and finished alike, and leaves crypto out', async () => {
      const { broker, calls } = fake({ orders: ORDERS });

      expect(await broker.getOrders()).toStrictEqual([
        {
          orderId: 'sandbox-order-3',
          instrument: { kind: 'equity', symbol: 'MSFT' },
          side: 'buy',
          status: 'accepted',
          fillPrice: null,
          fillPricePerShare: true,
          quantity: 0,
          createdAt: '2026-11-11T07:10:13.024821Z',
        },
        {
          orderId: 'sandbox-order-1',
          instrument: AAPL,
          side: 'buy',
          status: 'filled',
          fillPrice: 180.5,
          fillPricePerShare: true,
          quantity: 10,
          createdAt: '2026-11-10T07:10:13.024821Z',
        },
        {
          orderId: 'sandbox-order-4',
          instrument: AAPL,
          side: 'sell',
          status: 'cancelled',
          fillPrice: null,
          fillPricePerShare: true,
          quantity: 0,
          createdAt: '2026-10-29T07:10:13.024821Z',
        },
        // Partially filled: 10 of 20. `quantity` is the filled count, which the fill sweep reads.
        {
          orderId: 'sandbox-order-5',
          instrument: { kind: 'equity', symbol: 'NVDA' },
          side: 'buy',
          status: 'partially_filled',
          fillPrice: 120,
          fillPricePerShare: true,
          quantity: 10,
          createdAt: '2026-11-05T07:10:11.537164Z',
        },
      ]);
      expect(calls).toStrictEqual([
        ['accountInformation.getUserAccountRecentOrders', { accountId: ACCOUNT_ID, onlyExecuted: false }],
      ]);
    });

    it('returns an option order with its contract and its fill price per share', async () => {
      const { broker } = fake({
        orders: {
          orders: [optionOrder(), optionOrder({ action: 'SELL_TO_CLOSE', execution_price: '2.10' })],
        },
      });

      expect(await broker.getOrders()).toStrictEqual([
        {
          orderId: 'option-order-1',
          instrument: SPY_CALL,
          side: 'buy',
          status: 'filled',
          fillPrice: 1.59,
          fillPricePerShare: true,
          quantity: 3,
          createdAt: '2026-10-21T15:18:06Z',
        },
        {
          orderId: 'option-order-1',
          instrument: SPY_CALL,
          side: 'sell',
          status: 'filled',
          fillPrice: 2.1,
          fillPricePerShare: true,
          quantity: 3,
          createdAt: '2026-10-21T15:18:06Z',
        },
      ]);
    });

    it('reports a rejected order as rejected, with nothing filled', async () => {
      const { broker } = fake({
        orders: {
          orders: [optionOrder({ status: 'REJECTED', filled_quantity: '0', execution_price: null })],
        },
      });

      const [order] = await broker.getOrders();
      expect(order).toMatchObject({ status: 'rejected', quantity: 0, fillPrice: null });
      expect(isTerminalOrderState(order?.status)).toBe(true);
    });

    it('reports a partial fill with the count and price filled so far, and keeps it open', async () => {
      const { broker } = fake({
        orders: {
          orders: [
            optionOrder({
              status: 'PARTIAL',
              filled_quantity: '1',
              open_quantity: '2',
              execution_price: '1.58',
            }),
          ],
        },
      });

      const [order] = await broker.getOrders();
      expect(order).toMatchObject({ status: 'partially_filled', quantity: 1, fillPrice: 1.58 });
      expect(isTerminalOrderState(order?.status)).toBe(false);
    });

    it('maps the statuses that end an order and leaves every other one open', async () => {
      const statusOf = async (status: AccountOrderRecord['status']): Promise<string | null | undefined> =>
        (await fake({ orders: { orders: [optionOrder({ status })] } }).broker.getOrders())[0]?.status;

      expect(await statusOf('EXECUTED')).toBe('filled');
      expect(await statusOf('CANCELED')).toBe('cancelled');
      expect(await statusOf('PARTIAL_CANCELED')).toBe('cancelled');
      expect(await statusOf('REJECTED')).toBe('rejected');
      expect(await statusOf('FAILED')).toBe('failed');
      expect(await statusOf('EXPIRED')).toBe('expired');

      const open: AccountOrderRecord['status'][] = [
        'NONE',
        'PENDING',
        'ACCEPTED',
        'QUEUED',
        'TRIGGERED',
        'ACTIVATED',
        'STOPPED',
        'SUSPENDED',
        'CANCEL_PENDING',
        'REPLACE_PENDING',
        'REPLACED',
        'PENDING_RISK_REVIEW',
        'CONTINGENT_ORDER',
        'PARTIAL',
      ];
      for (const status of open) {
        expect(isTerminalOrderState(await statusOf(status)), status).toBe(false);
      }
    });

    it('never reads a status it does not know as filled or finished', async () => {
      const { broker } = fake({
        orders: {
          orders: [
            // A word SnapTrade may add later, and one that only looks like a fill.
            { ...optionOrder(), status: 'FILLED' } as unknown as AccountOrderRecord,
            { ...optionOrder(), status: 'SETTLING' } as unknown as AccountOrderRecord,
            optionOrder({ status: undefined }),
          ],
        },
      });

      const statuses = (await broker.getOrders()).map((order) => order.status);
      expect(statuses).toStrictEqual(['unknown:filled', 'unknown:settling', 'unknown']);
      expect(statuses.some((status) => isTerminalOrderState(status))).toBe(false);
    });

    it('leaves out an order on a side it cannot name, and answers an empty list as none', async () => {
      expect(
        await fake({ orders: { orders: [optionOrder({ action: 'EXERCISE' })] } }).broker.getOrders()
      ).toStrictEqual([]);
      expect(await fake({ orders: {} }).broker.getOrders()).toStrictEqual([]);
    });
  });

  describe('getMark', () => {
    it('asks for one stock quote by ticker and returns the last trade', async () => {
      const { broker, calls } = fake({ quotes: [equityQuote('AAPL', 150.25)] });

      expect(await broker.getMark(AAPL)).toBe(150.25);
      expect(calls).toStrictEqual([
        ['trading.getUserAccountQuotes', { accountId: ACCOUNT_ID, symbols: 'AAPL', useTicker: true }],
      ]);
    });

    it('is null when no quote, another listing, or no price comes back', async () => {
      expect(await fake({ quotes: [] }).broker.getMark(AAPL)).toBeNull();
      expect(await fake({ quotes: [equityQuote('AAPL.TO', 150.25)] }).broker.getMark(AAPL)).toBeNull();
      expect(await fake({ quotes: [equityQuote('AAPL', 0)] }).broker.getMark(AAPL)).toBeNull();
      expect(await fake({ quotes: [equityQuote('AAPL', undefined)] }).broker.getMark(AAPL)).toBeNull();
    });

    it('is null for every option without a call: the retired option quote endpoint is never reached', async () => {
      const { broker, calls } = fake();

      expect(await broker.getMark(SPY_CALL)).toBeNull();
      await broker.confirmInstrument(SPY_CALL);
      expect(calls).toStrictEqual([]);
    });
  });

  describe('confirmInstrument', () => {
    it('confirms a stock by its quote', async () => {
      const { broker, calls } = fake({ quotes: [equityQuote('AAPL', 150.25)] });

      await expect(broker.confirmInstrument(AAPL)).resolves.toBeUndefined();
      expect(calls).toHaveLength(1);
    });

    it('rejects a stock SnapTrade has no quote for as not found', async () => {
      await expect(fake({ quotes: [] }).broker.confirmInstrument(AAPL)).rejects.toBeInstanceOf(
        SymbolNotFoundError
      );
    });

    it('rejects an option no order could name, without a call', async () => {
      const { broker, calls } = fake();

      await expect(
        broker.confirmInstrument({ ...SPY_CALL, expiration: '2026-02-30' })
      ).rejects.toBeInstanceOf(SymbolNotFoundError);
      await expect(broker.confirmInstrument({ ...SPY_CALL, strike: 0 })).rejects.toBeInstanceOf(
        SymbolNotFoundError
      );
      // SPX and SPXW share dates and strikes; the ticker alone does not say which.
      await expect(broker.confirmInstrument({ ...SPY_CALL, symbol: 'SPX' })).rejects.toBeInstanceOf(
        SymbolNotFoundError
      );
      expect(calls).toStrictEqual([]);
    });
  });
});

describe('SnapTradeBroker writes', () => {
  describe('an option order', () => {
    it('sends a limit buy as one leg that opens, a debit, priced as a string', async () => {
      const { broker, calls } = fake({ optionOrder: optionOrderPlaced() });

      expect(await broker.placeOrder(orderRequest())).toStrictEqual({
        orderId: 'option-order-1',
        status: 'pending',
      });
      expect(calls).toStrictEqual([
        [
          'trading.placeMlegOrder',
          {
            accountId: ACCOUNT_ID,
            order_type: 'LIMIT',
            time_in_force: 'Day',
            limit_price: '1.6',
            price_effect: 'DEBIT',
            legs: [
              {
                instrument: { symbol: SPY_CALL_OCC, instrument_type: 'OPTION' },
                action: 'BUY_TO_OPEN',
                units: 3,
              },
            ],
          },
        ],
      ]);
    });

    it('sends a limit sell as one leg that closes, a credit', async () => {
      const { broker, calls } = fake({ optionOrder: optionOrderPlaced('ACCEPTED') });

      expect(
        await broker.placeOrder(
          orderRequest({ side: 'sell', quantity: 2, limitPrice: 2.1, timeInForce: 'gtc' })
        )
      ).toStrictEqual({ orderId: 'option-order-1', status: 'accepted' });
      expect(calls).toStrictEqual([
        [
          'trading.placeMlegOrder',
          {
            accountId: ACCOUNT_ID,
            order_type: 'LIMIT',
            time_in_force: 'GTC',
            limit_price: '2.1',
            price_effect: 'CREDIT',
            legs: [
              {
                instrument: { symbol: SPY_CALL_OCC, instrument_type: 'OPTION' },
                action: 'SELL_TO_CLOSE',
                units: 2,
              },
            ],
          },
        ],
      ]);
    });

    it('sends a market sell with no price at all', async () => {
      const { broker, calls } = fake({ optionOrder: optionOrderPlaced() });

      await broker.placeOrder({ instrument: SPY_CALL, side: 'sell', quantity: 3, type: 'market' });
      expect(calls).toStrictEqual([
        [
          'trading.placeMlegOrder',
          {
            accountId: ACCOUNT_ID,
            order_type: 'MARKET',
            time_in_force: 'Day',
            price_effect: 'CREDIT',
            legs: [
              {
                instrument: { symbol: SPY_CALL_OCC, instrument_type: 'OPTION' },
                action: 'SELL_TO_CLOSE',
                units: 3,
              },
            ],
          },
        ],
      ]);
    });

    it('sends a stop as a stop-loss market order with only the stop price', async () => {
      const { broker, calls } = fake({ optionOrder: optionOrderPlaced() });

      await broker.placeOrder({
        instrument: SPY_CALL,
        side: 'sell',
        quantity: 3,
        type: 'stop',
        stopPrice: 0.8,
        timeInForce: 'gtc',
      });
      expect(calls[0]?.[1]).toMatchObject({
        order_type: 'STOP_LOSS_MARKET',
        time_in_force: 'GTC',
        stop_price: '0.8',
      });
      expect(calls[0]?.[1]).not.toHaveProperty('limit_price');
    });

    it('rounds the premium onto the price grid: a buy up, a sell down', async () => {
      const buy = fake({ optionOrder: optionOrderPlaced() });
      const sell = fake({ optionOrder: optionOrderPlaced() });

      await buy.broker.placeOrder(orderRequest({ limitPrice: 1.234 }));
      await sell.broker.placeOrder(orderRequest({ side: 'sell', limitPrice: 3.07 }));

      expect(buy.calls[0]?.[1]).toMatchObject({ limit_price: '1.24' });
      expect(sell.calls[0]?.[1]).toMatchObject({ limit_price: '3.05' });
    });

    it('refuses a contract it cannot name before any call', async () => {
      const { broker, calls } = fake({ optionOrder: optionOrderPlaced() });

      await expect(
        broker.placeOrder(orderRequest({ instrument: { ...SPY_CALL, symbol: 'SPX' } }))
      ).rejects.toBeInstanceOf(SymbolNotFoundError);
      await expect(
        broker.placeOrder(orderRequest({ instrument: { ...SPY_CALL, expiration: 'tomorrow' } }))
      ).rejects.toBeInstanceOf(SymbolNotFoundError);
      expect(calls).toStrictEqual([]);
    });
  });

  describe('an equity order', () => {
    it('sends a market buy by ticker through the direct order call', async () => {
      const { broker, calls } = fake({ equityOrder: equityOrderPlaced() });

      expect(
        await broker.placeOrder({ instrument: AAPL, side: 'buy', quantity: 10, type: 'market' })
      ).toStrictEqual({
        orderId: 'equity-order-1',
        status: 'pending',
      });
      expect(calls).toStrictEqual([
        [
          'trading.placeForceOrder',
          {
            account_id: ACCOUNT_ID,
            action: 'BUY',
            symbol: 'AAPL',
            universal_symbol_id: null,
            order_type: 'Market',
            time_in_force: 'Day',
            units: 10,
          },
        ],
      ]);
    });

    it('sends a limit sell with its price as a number', async () => {
      const { broker, calls } = fake({
        equityOrder: equityOrderPlaced({ action: 'SELL', order_type: 'Limit' }),
      });

      await broker.placeOrder({
        instrument: AAPL,
        side: 'sell',
        quantity: 2.5,
        type: 'limit',
        limitPrice: 151.5,
        timeInForce: 'gtc',
      });
      expect(calls).toStrictEqual([
        [
          'trading.placeForceOrder',
          {
            account_id: ACCOUNT_ID,
            action: 'SELL',
            symbol: 'AAPL',
            universal_symbol_id: null,
            order_type: 'Limit',
            time_in_force: 'GTC',
            units: 2.5,
            price: 151.5,
          },
        ],
      ]);
    });

    it('sends a stop with only the stop price', async () => {
      const { broker, calls } = fake({
        equityOrder: equityOrderPlaced({ action: 'SELL', order_type: 'Stop' }),
      });

      await broker.placeOrder({ instrument: AAPL, side: 'sell', quantity: 10, type: 'stop', stopPrice: 140 });
      expect(calls[0]?.[1]).toMatchObject({ order_type: 'Stop', stop: 140 });
      expect(calls[0]?.[1]).not.toHaveProperty('price');
    });
  });

  describe('an order that did not go through', () => {
    it('rejects when the order comes back rejected or failed, whichever call placed it', async () => {
      await expect(
        fake({ optionOrder: optionOrderPlaced('REJECTED') }).broker.placeOrder(orderRequest())
      ).rejects.toThrow(/option-order-1 was rejected by the broker/);
      await expect(
        fake({ optionOrder: optionOrderPlaced('FAILED') }).broker.placeOrder(orderRequest())
      ).rejects.toThrow(/was failed by the broker/);
      await expect(
        fake({ equityOrder: equityOrderPlaced({ status: 'REJECTED' }) }).broker.placeOrder({
          instrument: AAPL,
          side: 'buy',
          quantity: 1,
          type: 'market',
        })
      ).rejects.toThrow(/equity-order-1 was rejected by the broker/);
    });

    it('rejects an answer that names no order', async () => {
      await expect(
        fake({ optionOrder: { brokerage_order_id: '', orders: [] } }).broker.placeOrder(orderRequest())
      ).rejects.toThrow(/without an order id/);
      await expect(
        fake({ equityOrder: equityOrderPlaced({ brokerage_order_id: undefined }) }).broker.placeOrder({
          instrument: AAPL,
          side: 'buy',
          quantity: 1,
          type: 'market',
        })
      ).rejects.toThrow(/without an order id/);
    });

    it('rejects a malformed order before any call', async () => {
      const { broker, calls } = fake({ optionOrder: optionOrderPlaced(), equityOrder: equityOrderPlaced() });

      await expect(broker.placeOrder(orderRequest({ quantity: 0 }))).rejects.toThrow(/quantity/);
      await expect(broker.placeOrder(orderRequest({ quantity: Number.NaN }))).rejects.toThrow(/quantity/);
      await expect(broker.placeOrder(orderRequest({ quantity: 1.5 }))).rejects.toThrow(
        /whole number of contracts/
      );
      await expect(broker.placeOrder(orderRequest({ limitPrice: undefined }))).rejects.toThrow(/limit price/);
      await expect(broker.placeOrder(orderRequest({ limitPrice: -1 }))).rejects.toThrow(/limit price/);
      await expect(broker.placeOrder(orderRequest({ type: 'stop', limitPrice: undefined }))).rejects.toThrow(
        /stop price/
      );
      await expect(
        broker.placeOrder({ instrument: AAPL, side: 'buy', quantity: -3, type: 'market' })
      ).rejects.toThrow(/quantity/);
      expect(calls).toStrictEqual([]);
    });

    it('stores an order that filled at once as accepted, so the fill sweep reads its price back', async () => {
      const { broker } = fake({ optionOrder: optionOrderPlaced('EXECUTED') });

      expect(await broker.placeOrder(orderRequest())).toStrictEqual({
        orderId: 'option-order-1',
        status: 'accepted',
      });
    });

    it('never reports an unknown placement status as finished', async () => {
      const { broker } = fake({ optionOrder: { brokerage_order_id: 'option-order-1', orders: [] } });

      const placed = await broker.placeOrder(orderRequest());
      expect(placed).toStrictEqual({ orderId: 'option-order-1', status: 'unknown' });
      expect(isTerminalOrderState(placed.status)).toBe(false);
    });
  });

  it('cancelOrder cancels by the broker order id in one call', async () => {
    const { broker, calls } = fake({ cancel: ORDER_CANCELLED });

    await expect(broker.cancelOrder('option-order-1')).resolves.toBeUndefined();
    expect(calls).toStrictEqual([
      ['trading.cancelOrder', { accountId: ACCOUNT_ID, brokerage_order_id: 'option-order-1' }],
    ]);
  });
});

describe('SnapTradeBroker failures', () => {
  it.each([
    [401, { detail: 'Unable to verify signature sent' }],
    [402, { detail: 'Brokerage connection is disabled', code: '3003' }],
    [403, { detail: 'Trading is not enabled for this connection' }],
  ])('reports HTTP %i as the broker being unavailable, on a read and on a write', async (status, body) => {
    const { broker } = fake({ failure: sdkFailure(status, body) });

    await expect(broker.getAccount()).rejects.toBeInstanceOf(BrokerUnavailableError);
    await expect(broker.placeOrder(orderRequest())).rejects.toBeInstanceOf(BrokerUnavailableError);
    await expect(broker.cancelOrder('option-order-1')).rejects.toThrow(body.detail);
  });

  it('reports any other failure as an ordinary error carrying the reason SnapTrade gave', async () => {
    const { broker } = fake({
      failure: sdkFailure(400, { detail: 'Insufficient buying power', code: '1068' }),
    });

    const failure: unknown = await broker.placeOrder(orderRequest()).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(BrokerUnavailableError);
    expect(failure).not.toBeInstanceOf(SymbolNotFoundError);
    expect((failure as Error).message).toBe(
      'SnapTrade failed the option order (HTTP 400): Insufficient buying power'
    );
  });

  it('keeps the request, its address and the response headers out of the error', async () => {
    const { broker } = fake({ failure: sdkFailure(500, undefined) });

    const failure: unknown = await broker.getPositions().catch((err: unknown) => err);
    expect((failure as Error).message).toBe(
      'SnapTrade failed the positions read (HTTP 500): Request failed with status code 500'
    );
    expect((failure as Error).cause).toBeUndefined();
  });

  it('surfaces a failure with no HTTP status, such as the SDK giving up on rate limits', async () => {
    const { broker } = fake({
      failure: new Error('Request failed after 3 retries due to 429 (rate limit) errors.'),
    });

    await expect(broker.getOrders()).rejects.toThrow(
      'SnapTrade failed the recent orders read: Request failed after 3 retries due to 429 (rate limit) errors.'
    );
  });

  it('lets a failed quote read fail rather than read as no such symbol', async () => {
    const { broker } = fake({ failure: sdkFailure(500, { detail: 'Brokerage is down' }) });

    await expect(broker.getMark(AAPL)).rejects.toThrow(/Brokerage is down/);
    await expect(broker.confirmInstrument(AAPL)).rejects.not.toBeInstanceOf(SymbolNotFoundError);
  });
});
