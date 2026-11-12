/**
 * RobinhoodBroker is the port over RobinhoodTools. These tests pin what leaves
 * the process: each port call must reach the Robinhood MCP as the same tool
 * calls, with the same arguments and in the same order, as the RobinhoodTools
 * call the pipeline and monitors made before the port existed.
 */
import { describe, expect, it } from 'vitest';

import { TradeSettingsSchema, type Decision, type SubmittedOrder } from '../../../shared/types.js';
import { createFakeDb, type FakeDb } from '../../__tests__/fakeDb.js';
import { SymbolNotFoundError } from '../../broker/errors.js';
import { roundPremiumToTick } from '../../broker/instrument.js';
import type { Instrument, OrderRequest } from '../../broker/types.js';
import { stopTrigger } from '../../lots.js';
import { submitOrder } from '../../pipeline/execute.js';
import { cancelStops, restMissingStops } from '../../stops.js';
import { RobinhoodBroker } from '../broker.js';
import type { RobinhoodMcpClient } from '../mcpClient.js';
import { RobinhoodTools, TOOL_NAMES } from '../tools.js';
import type { CallToolResult } from '../types.js';

const ACCOUNT = 'ACC-0001';
const OPTION_ID = 'opt-uuid-1';
/** ref_id is a fresh UUID per order; replaced so two runs can be compared. */
const REF_ID = '<ref_id>';

const SPY_CALL: Instrument = {
  kind: 'option',
  symbol: 'SPY',
  optionType: 'call',
  strike: 772,
  expiration: '2026-10-21',
};
const AAPL: Instrument = { kind: 'equity', symbol: 'AAPL' };

const INSTRUMENT_LOOKUP = {
  chain_symbol: 'SPY',
  expiration_dates: '2026-10-21',
  strike_price: '772.0000',
  type: 'call',
  state: 'active',
};

/** Payload shapes as the live MCP returns them: numerics are strings. */
const RESPONSES: Record<string, unknown> = {
  [TOOL_NAMES.accounts]: {
    accounts: [{ account_number: ACCOUNT, agentic_allowed: true, state: 'active' }],
  },
  [TOOL_NAMES.portfolio]: { buying_power: { buying_power: '1234.5600' }, total_value: '5000.0000' },
  [TOOL_NAMES.quote]: { results: [{ symbol: 'AAPL', last_trade_price: '150.2500' }] },
  [TOOL_NAMES.optionInstruments]: {
    results: [
      {
        id: OPTION_ID,
        chain_symbol: 'SPY',
        type: 'call',
        strike_price: '772.0000',
        expiration_date: '2026-10-21',
      },
    ],
  },
  [TOOL_NAMES.optionsQuote]: { results: [{ mark_price: '0.8600' }] },
  [TOOL_NAMES.positions]: {
    results: [
      { symbol: 'AAPL', quantity: '10.0000', average_buy_price: '148.5000' },
      // No average cost on the row, and closed: still returned, with no entry price.
      { symbol: 'MSFT', quantity: '0.0000' },
    ],
  },
  // Live rows name the contract only by option_id; `type` is long/short.
  [TOOL_NAMES.optionPositions]: {
    results: [{ option_id: OPTION_ID, chain_symbol: 'SPY', quantity: '3.0000', type: 'long' }],
  },
  [TOOL_NAMES.optionOrders]: {
    results: [
      {
        id: 'ord-1',
        chain_symbol: 'SPY',
        state: 'filled',
        direction: 'debit',
        // Per-contract scale: the premium paid was 1.59.
        average_price: '159.0000',
        processed_quantity: '3.0000',
        created_at: '2026-10-21T15:18:06Z',
        legs: [
          { side: 'buy', option_type: 'call', strike_price: '772.0000', expiration_date: '2026-10-21' },
        ],
      },
    ],
  },
  [TOOL_NAMES.placeOrder]: { id: 'eq-ord-9', state: 'unconfirmed' },
  [TOOL_NAMES.placeOptionsOrder]: { id: 'opt-ord-9', state: 'unconfirmed' },
  [TOOL_NAMES.cancelOptionOrder]: {},
};

interface WireCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

interface Connection {
  readonly tools: RobinhoodTools;
  /** Every MCP tool call made, in order. */
  readonly wire: WireCall[];
}

function connect(
  overrides: Record<string, unknown> = {},
  advertised: readonly string[] = Object.values(TOOL_NAMES)
): Connection {
  const wire: WireCall[] = [];
  const responses = { ...RESPONSES, ...overrides };
  const mcp = {
    ensureReady: async () => undefined,
    isConnected: () => true,
    getToolNames: () => advertised,
    getToolInputSchema: () => undefined,
    getTokenStatus: async () => ({ state: 'valid', hasRefreshToken: true }),
    callTool: async (name: string, args: Record<string, unknown>): Promise<CallToolResult> => {
      if ('ref_id' in args) expect(args.ref_id).toMatch(/^[0-9a-f-]{36}$/);
      wire.push({ name, args: 'ref_id' in args ? { ...args, ref_id: REF_ID } : args });
      return { content: [{ type: 'text', text: JSON.stringify(responses[name]) }] };
    },
  };
  return { tools: new RobinhoodTools(mcp as unknown as RobinhoodMcpClient), wire };
}

/** The MCP calls one RobinhoodTools call made before the port existed. */
async function legacyWire(
  run: (tools: RobinhoodTools) => Promise<unknown>,
  overrides?: Record<string, unknown>
): Promise<WireCall[]> {
  const { tools, wire } = connect(overrides);
  await run(tools);
  return wire;
}

describe('RobinhoodBroker reads', () => {
  it('getAccount is getBuyingPower: buying power and portfolio value', async () => {
    const { tools, wire } = connect();

    const account = await new RobinhoodBroker(tools).getAccount();

    expect(account).toStrictEqual({ buyingPowerUsd: 1234.56, portfolioValueUsd: 5000 });
    expect(wire).toStrictEqual([
      { name: 'get_accounts', args: {} },
      { name: 'get_portfolio', args: { account_number: ACCOUNT } },
    ]);
    expect(wire).toStrictEqual(await legacyWire((t) => t.getBuyingPower()));
  });

  it('getMark on stock is getQuote', async () => {
    const { tools, wire } = connect();

    expect(await new RobinhoodBroker(tools).getMark(AAPL)).toBe(150.25);

    expect(wire).toStrictEqual([{ name: 'get_equity_quotes', args: { symbols: ['AAPL'] } }]);
  });

  it('getMark on stock with no quote rejects with SymbolNotFoundError, as getQuote does', async () => {
    const { tools } = connect({ [TOOL_NAMES.quote]: { results: [] } });

    await expect(new RobinhoodBroker(tools).getMark(AAPL)).rejects.toBeInstanceOf(SymbolNotFoundError);
  });

  it('getMark on a contract is getOptionsMarkPrice: instrument lookup, then the quote by id', async () => {
    const { tools, wire } = connect();

    expect(await new RobinhoodBroker(tools).getMark(SPY_CALL)).toBe(0.86);

    expect(wire).toStrictEqual([
      { name: 'get_option_instruments', args: INSTRUMENT_LOOKUP },
      { name: 'get_option_quotes', args: { instrument_ids: [OPTION_ID] } },
    ]);
    expect(wire).toStrictEqual(
      await legacyWire((t) => t.getOptionsMarkPrice('SPY', 'call', 772, '2026-10-21'))
    );
  });

  it('getMark on a contract is null when Robinhood returns no usable quote', async () => {
    const { tools } = connect({ [TOOL_NAMES.optionsQuote]: { results: [] } });

    expect(await new RobinhoodBroker(tools).getMark(SPY_CALL)).toBeNull();
  });

  it('confirmInstrument on a contract is confirmOption: one chain lookup', async () => {
    const { tools, wire } = connect();

    await new RobinhoodBroker(tools).confirmInstrument(SPY_CALL);

    expect(wire).toStrictEqual([{ name: 'get_option_instruments', args: INSTRUMENT_LOOKUP }]);
  });

  it('confirmInstrument rejects with SymbolNotFoundError when the chain lists no such contract', async () => {
    const { tools } = connect({ [TOOL_NAMES.optionInstruments]: { results: [] } });

    await expect(new RobinhoodBroker(tools).confirmInstrument(SPY_CALL)).rejects.toBeInstanceOf(
      SymbolNotFoundError
    );
  });

  it('confirmInstrument on stock is the equity quote', async () => {
    const { tools, wire } = connect();

    await new RobinhoodBroker(tools).confirmInstrument(AAPL);

    expect(wire).toStrictEqual([{ name: 'get_equity_quotes', args: { symbols: ['AAPL'] } }]);
  });

  it('getPositions reads stock then options, keeps closed rows, and takes the cost basis only from stock rows', async () => {
    const { tools, wire } = connect();

    const positions = await new RobinhoodBroker(tools).getPositions();

    expect(positions).toStrictEqual([
      { instrument: { kind: 'equity', symbol: 'AAPL' }, quantity: 10, averageEntryPrice: 148.5 },
      { instrument: { kind: 'equity', symbol: 'MSFT' }, quantity: 0, averageEntryPrice: null },
      { instrument: SPY_CALL, quantity: 3, averageEntryPrice: null },
    ]);
    // The same calls, in the same order, as the Promise.all Max Loss and the dashboard ran.
    expect(wire).toStrictEqual(
      await legacyWire((t) => Promise.all([t.getPositions(), t.getOptionPositions()]))
    );
    expect(wire.map((call) => call.name).filter((name) => name !== 'get_accounts')).toStrictEqual([
      'get_equity_positions',
      'get_option_positions',
      'get_option_instruments',
    ]);
    expect(wire.at(-1)).toStrictEqual({ name: 'get_option_instruments', args: { ids: OPTION_ID } });
  });

  it("getPositions('option') reads only option positions, as exit sizing does", async () => {
    const { tools, wire } = connect();

    const positions = await new RobinhoodBroker(tools).getPositions('option');

    expect(positions).toStrictEqual([{ instrument: SPY_CALL, quantity: 3, averageEntryPrice: null }]);
    expect(wire).toStrictEqual([
      { name: 'get_accounts', args: {} },
      { name: 'get_option_positions', args: { account_number: ACCOUNT } },
      { name: 'get_option_instruments', args: { ids: OPTION_ID } },
    ]);
    expect(wire).toStrictEqual(await legacyWire((t) => t.getOptionPositions()));
  });

  it("getPositions('equity') reads only stock positions, as the add gate does", async () => {
    const { tools, wire } = connect();

    const positions = await new RobinhoodBroker(tools).getPositions('equity');

    expect(positions.map((position) => position.instrument.symbol)).toStrictEqual(['AAPL', 'MSFT']);
    expect(wire).toStrictEqual([
      { name: 'get_accounts', args: {} },
      { name: 'get_equity_positions', args: { account_number: ACCOUNT } },
    ]);
  });

  it('getOrders is getOptionOrders, with state and fill price exactly as Robinhood reports them', async () => {
    const { tools, wire } = connect();

    const orders = await new RobinhoodBroker(tools).getOrders();

    expect(orders).toStrictEqual([
      {
        orderId: 'ord-1',
        instrument: SPY_CALL,
        side: 'buy',
        status: 'filled',
        // Not rescaled here: the 159-vs-1.59 fix needs the mark or the order's
        // limit as its reference, so it stays with the callers that have one.
        fillPrice: 159,
        quantity: 3,
        createdAt: '2026-10-21T15:18:06Z',
      },
    ]);
    expect(wire).toStrictEqual([
      { name: 'get_accounts', args: {} },
      { name: 'get_option_orders', args: { account_number: ACCOUNT } },
    ]);
  });

  it('getOrders is null, with no call, when the server offers no order history', async () => {
    const { tools, wire } = connect(
      {},
      Object.values(TOOL_NAMES).filter((name) => name !== TOOL_NAMES.optionOrders)
    );

    expect(await new RobinhoodBroker(tools).getOrders()).toBeNull();
    expect(wire).toStrictEqual([]);
  });
});

describe('RobinhoodBroker writes', () => {
  const optionOrder = (overrides: Partial<OrderRequest>): OrderRequest => ({
    instrument: SPY_CALL,
    side: 'buy',
    quantity: 3,
    type: 'limit',
    ...overrides,
  });
  const contract = { symbol: 'SPY', optionType: 'call' as const, strike: 772, expiration: '2026-10-21' };
  const leg = (side: 'buy' | 'sell') => ({
    option_id: OPTION_ID,
    side,
    position_effect: side === 'buy' ? 'open' : 'close',
    ratio_quantity: 1,
  });

  it('a limit option buy is placeOptionsOrder, the premium rounded up to the tick', async () => {
    const { tools, wire } = connect();

    const placed = await new RobinhoodBroker(tools).placeOrder(optionOrder({ limitPrice: 0.195 }));

    expect(placed).toStrictEqual({ orderId: 'opt-ord-9', status: 'unconfirmed' });
    expect(wire).toStrictEqual([
      { name: 'get_option_instruments', args: INSTRUMENT_LOOKUP },
      { name: 'get_accounts', args: {} },
      {
        name: 'place_option_order',
        args: {
          account_number: ACCOUNT,
          legs: [leg('buy')],
          type: 'limit',
          quantity: '3',
          time_in_force: 'gfd',
          ref_id: REF_ID,
          price: '0.2',
        },
      },
    ]);
    expect(wire).toStrictEqual(
      await legacyWire((t) =>
        t.placeOptionsOrder({ ...contract, contracts: 3, side: 'buy', orderType: 'limit', limitPremium: 0.195 })
      )
    );
  });

  it('a limit option sell rounds down, on the grid the instrument reports', async () => {
    const nickelAboveThree = {
      [TOOL_NAMES.optionInstruments]: {
        results: [
          { id: OPTION_ID, min_ticks: { above_tick: '0.05', below_tick: '0.01', cutoff_price: '3.00' } },
        ],
      },
    };
    const { tools, wire } = connect(nickelAboveThree);

    await new RobinhoodBroker(tools).placeOrder(optionOrder({ side: 'sell', quantity: 2, limitPrice: 3.38 }));

    expect(wire.at(-1)).toStrictEqual({
      name: 'place_option_order',
      args: {
        account_number: ACCOUNT,
        legs: [leg('sell')],
        type: 'limit',
        quantity: '2',
        time_in_force: 'gfd',
        ref_id: REF_ID,
        price: '3.35',
      },
    });
    expect(wire).toStrictEqual(
      await legacyWire(
        (t) =>
          t.placeOptionsOrder({ ...contract, contracts: 2, side: 'sell', orderType: 'limit', limitPremium: 3.38 }),
        nickelAboveThree
      )
    );
  });

  it('a market option sell (the Max Loss close) carries no price', async () => {
    const { tools, wire } = connect();

    await new RobinhoodBroker(tools).placeOrder(optionOrder({ side: 'sell', quantity: 2, type: 'market' }));

    expect(wire.at(-1)).toStrictEqual({
      name: 'place_option_order',
      args: {
        account_number: ACCOUNT,
        legs: [leg('sell')],
        type: 'market',
        quantity: '2',
        time_in_force: 'gfd',
        ref_id: REF_ID,
      },
    });
    expect(wire).toStrictEqual(
      await legacyWire((t) => t.placeOptionsOrder({ ...contract, contracts: 2, side: 'sell', orderType: 'market' }))
    );
  });

  it('a market option order that still names a price sends none, as before', async () => {
    const { tools, wire } = connect();

    await new RobinhoodBroker(tools).placeOrder(optionOrder({ type: 'market', limitPrice: 0.97 }));

    expect(wire.at(-1)!.args).not.toHaveProperty('price');
    expect(wire).toStrictEqual(
      await legacyWire((t) =>
        t.placeOptionsOrder({ ...contract, contracts: 3, side: 'buy', orderType: 'market', limitPremium: 0.97 })
      )
    );
  });

  it("a stop is Robinhood's stop_market: good till cancelled, trigger on the tick, no limit price", async () => {
    const { tools, wire } = connect();

    await new RobinhoodBroker(tools).placeOrder(
      optionOrder({ side: 'sell', quantity: 2, type: 'stop', stopPrice: 0.2, timeInForce: 'gtc' })
    );

    expect(wire.at(-1)).toStrictEqual({
      name: 'place_option_order',
      args: {
        account_number: ACCOUNT,
        legs: [leg('sell')],
        type: 'stop_market',
        quantity: '2',
        time_in_force: 'gtc',
        ref_id: REF_ID,
        stop_price: '0.2',
      },
    });
    expect(wire).toStrictEqual(
      await legacyWire((t) =>
        t.placeOptionsOrder({
          ...contract,
          contracts: 2,
          side: 'sell',
          orderType: 'stop_market',
          stopPrice: 0.2,
          timeInForce: 'gtc',
        })
      )
    );
  });

  it('a market stock buy is placeOrder with a string quantity and no limit', async () => {
    const { tools, wire } = connect();

    const placed = await new RobinhoodBroker(tools).placeOrder({
      instrument: AAPL,
      side: 'buy',
      quantity: 4,
      type: 'market',
    });

    expect(placed).toStrictEqual({ orderId: 'eq-ord-9', status: 'unconfirmed' });
    expect(wire).toStrictEqual([
      { name: 'get_accounts', args: {} },
      {
        name: 'place_equity_order',
        args: {
          account_number: ACCOUNT,
          symbol: 'AAPL',
          side: 'buy',
          type: 'market',
          quantity: '4',
          time_in_force: 'gfd',
          ref_id: REF_ID,
        },
      },
    ]);
    expect(wire).toStrictEqual(
      await legacyWire((t) => t.placeOrder({ symbol: 'AAPL', side: 'buy', orderType: 'market', quantity: 4 }))
    );
  });

  it('a limit stock sell sends the limit as a string', async () => {
    const { tools, wire } = connect();

    await new RobinhoodBroker(tools).placeOrder({
      instrument: AAPL,
      side: 'sell',
      quantity: 5,
      type: 'limit',
      limitPrice: 160.5,
    });

    expect(wire.at(-1)).toStrictEqual({
      name: 'place_equity_order',
      args: {
        account_number: ACCOUNT,
        symbol: 'AAPL',
        side: 'sell',
        type: 'limit',
        quantity: '5',
        time_in_force: 'gfd',
        ref_id: REF_ID,
        limit_price: '160.5',
      },
    });
    expect(wire).toStrictEqual(
      await legacyWire((t) =>
        t.placeOrder({ symbol: 'AAPL', side: 'sell', orderType: 'limit', quantity: 5, limitPrice: 160.5 })
      )
    );
  });

  it('a stock stop is refused before any call: only option stops are wired', async () => {
    const { tools, wire } = connect();

    await expect(
      new RobinhoodBroker(tools).placeOrder({
        instrument: AAPL,
        side: 'sell',
        quantity: 5,
        type: 'stop',
        stopPrice: 140,
      })
    ).rejects.toThrow(/options only/);
    expect(wire).toStrictEqual([]);
  });

  it('cancelOrder is cancelOptionOrder', async () => {
    const { tools, wire } = connect();

    await new RobinhoodBroker(tools).cancelOrder('stop-1');

    expect(wire).toStrictEqual([
      { name: 'get_accounts', args: {} },
      { name: 'cancel_option_order', args: { account_number: ACCOUNT, order_id: 'stop-1' } },
    ]);
    expect(wire).toStrictEqual(await legacyWire((t) => t.cancelOptionOrder('stop-1')));
  });
});

/**
 * The callers that write, run over a real RobinhoodBroker: each must put on the
 * wire exactly what its pre-port body did when it called RobinhoodTools itself.
 */
describe("the trader's write paths over RobinhoodBroker", () => {
  const USER = 'user-1';
  const CONTRACT = { optionType: 'call' as const, strike: 772, expiration: '2026-10-21' };
  const ENTRY_FILL = 1;
  const MAX_LOSS_PCT = 80;
  const LOT_CONTRACTS = 4;
  const LOT_MESSAGE_ID = 'buy-SPY';

  const sized = (overrides: Partial<SubmittedOrder> = {}): SubmittedOrder => ({
    symbol: 'SPY',
    side: 'buy',
    assetType: 'option',
    quantity: 3,
    orderType: 'limit',
    limitPrice: 0.195,
    option: CONTRACT,
    orderId: null,
    status: null,
    ...overrides,
  });

  /** One filled four-contract lot, bought at 1.00, with Max Loss at 80%. */
  function dbWithLot(stopOrderId?: string): FakeDb {
    const db = createFakeDb();
    db.seedSettings(USER, TradeSettingsSchema.parse({ maxLossPct: MAX_LOSS_PCT }));
    db.seedMessage({ messageId: LOT_MESSAGE_ID, sentAt: '2026-10-21T15:18:06.000Z' });
    const bought: Decision = {
      at: '2026-10-21T15:18:06.000Z',
      messageId: LOT_MESSAGE_ID,
      kind: 'submitted',
      code: null,
      reason: 'bought',
      ticker: 'SPY',
      action: 'buy',
      order: sized({
        quantity: LOT_CONTRACTS,
        limitPrice: ENTRY_FILL,
        orderId: 'buy-1',
        status: 'filled',
        ...(stopOrderId !== undefined ? { stopOrderId } : {}),
      }),
    };
    db.seedDecision(USER, bought);
    return db;
  }

  it('submitOrder places a limit option entry as it did', async () => {
    const { tools, wire } = connect();

    await submitOrder(sized(), new RobinhoodBroker(tools));

    expect(wire.at(-1)!.args).toMatchObject({ type: 'limit', quantity: '3', price: '0.2' });
    expect(wire).toStrictEqual(
      await legacyWire((t) =>
        t.placeOptionsOrder({
          symbol: 'SPY',
          ...CONTRACT,
          contracts: 3,
          side: 'buy',
          orderType: 'limit',
          limitPremium: 0.195,
        })
      )
    );
  });

  it('submitOrder places the Max Loss market close as it did', async () => {
    const { tools, wire } = connect();

    await submitOrder(
      sized({ side: 'sell', quantity: 2, orderType: 'market', limitPrice: null }),
      new RobinhoodBroker(tools)
    );

    expect(wire.at(-1)!.name).toBe('place_option_order');
    expect(wire.at(-1)!.args).toMatchObject({ type: 'market', quantity: '2' });
    expect(wire.at(-1)!.args).not.toHaveProperty('price');
    expect(wire).toStrictEqual(
      await legacyWire((t) =>
        t.placeOptionsOrder({
          symbol: 'SPY',
          ...CONTRACT,
          contracts: 2,
          side: 'sell',
          orderType: 'market',
        })
      )
    );
  });

  it('submitOrder places a stock order as it did', async () => {
    const { tools, wire } = connect();

    await submitOrder(
      sized({ symbol: 'AAPL', assetType: 'equity', option: null, quantity: 4, limitPrice: 150.25 }),
      new RobinhoodBroker(tools)
    );

    expect(wire.at(-1)!.name).toBe('place_equity_order');
    expect(wire).toStrictEqual(
      await legacyWire((t) =>
        t.placeOrder({ symbol: 'AAPL', side: 'buy', orderType: 'limit', quantity: 4, limitPrice: 150.25 })
      )
    );
  });

  it('restMissingStops rests the stop it did and records its id on the lot', async () => {
    const { tools, wire } = connect();
    const db = dbWithLot();

    await restMissingStops({
      userId: USER,
      db,
      broker: new RobinhoodBroker(tools),
      executionMode: 'immediate',
    });

    expect(wire.at(-1)!.args).toMatchObject({
      type: 'stop_market',
      quantity: String(LOT_CONTRACTS),
      time_in_force: 'gtc',
      stop_price: '0.2',
    });
    expect(wire).toStrictEqual(
      await legacyWire((t) =>
        t.placeOptionsOrder({
          symbol: 'SPY',
          ...CONTRACT,
          contracts: LOT_CONTRACTS,
          side: 'sell',
          orderType: 'stop_market',
          stopPrice: roundPremiumToTick(stopTrigger(ENTRY_FILL, MAX_LOSS_PCT), 'sell', null),
          timeInForce: 'gtc',
        })
      )
    );
    expect((await db.listOpenOptionLots(USER))[0]!.stopOrderId).toBe('opt-ord-9');
  });

  it('cancelStops cancels the resting stop as it did and clears it from the lot', async () => {
    const { tools, wire } = connect();
    const db = dbWithLot('stop-1');

    await cancelStops(db, USER, new RobinhoodBroker(tools), 'SPY', CONTRACT);

    expect(wire).toStrictEqual(await legacyWire((t) => t.cancelOptionOrder('stop-1')));
    expect(wire.at(-1)).toStrictEqual({
      name: 'cancel_option_order',
      args: { account_number: ACCOUNT, order_id: 'stop-1' },
    });
    expect((await db.listOpenOptionLots(USER))[0]!.stopOrderId).toBeNull();
  });
});
