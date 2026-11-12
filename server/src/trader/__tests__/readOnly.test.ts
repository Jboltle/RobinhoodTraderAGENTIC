/**
 * TRADE_EXECUTION_MODE=read_only is enforced in one place: the registry hands
 * out every adapter's Broker behind guardWrites. These tests pin that a
 * read-only deployment makes no write call on any adapter — including through
 * a caller whose own policy check would have let the write through.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  TradeSettingsSchema,
  type Decision,
  type OptionContract,
  type TradeExecutionMode,
} from '../../shared/types.js';
import { BrokerUnavailableError, BrokerWritesDisabledError } from '../broker/errors.js';
import { createMcpRegistry } from '../broker/registry.js';
import type { AccountRow, Broker, BrokerAdapter, Instrument, OrderRequest } from '../broker/types.js';
import { TraderEvents } from '../events.js';
import { sweepLadders } from '../ladderMonitor.js';
import { submitOrder } from '../pipeline/execute.js';
import { RobinhoodBroker } from '../robinhood/broker.js';
import type { RobinhoodMcpClient } from '../robinhood/mcpClient.js';
import { RobinhoodTools, TOOL_NAMES } from '../robinhood/tools.js';
import { cancelStops, restMissingStops } from '../stops.js';
import { createFakeDb, fakeAccount, fakeTokens, type FakeDb } from './fakeDb.js';
import { makeFakeBroker, makeFakeRegistry, type FakeBroker } from './harness.js';

const USER = 'user-1';
const CONTRACT: OptionContract = { optionType: 'call', strike: 707, expiration: '2026-06-11' };
const QQQ_CALL: Instrument = { kind: 'option', symbol: 'QQQ', ...CONTRACT };
const AAPL: Instrument = { kind: 'equity', symbol: 'AAPL' };
const ENTRY_PRICE = 1;
const LOT_MESSAGE_ID = 'buy-QQQ';
const RESTING_STOP_ID = 'stop-1';

const SESSION = { ensureReady: async () => undefined } as unknown as RobinhoodMcpClient;

/** Every kind of write the trader makes: entries, exits, the Max Loss close, a resting stop. */
const WRITES: readonly OrderRequest[] = [
  { instrument: AAPL, side: 'buy', quantity: 4, type: 'market' },
  { instrument: AAPL, side: 'sell', quantity: 4, type: 'limit', limitPrice: 150 },
  { instrument: QQQ_CALL, side: 'buy', quantity: 2, type: 'limit', limitPrice: 0.97 },
  { instrument: QQQ_CALL, side: 'sell', quantity: 2, type: 'market' },
  { instrument: QQQ_CALL, side: 'sell', quantity: 2, type: 'stop', stopPrice: 0.5, timeInForce: 'gtc' },
];

interface AdapterUnderTest {
  readonly broker: Broker;
  /** How many times anything was asked of the real broker behind the adapter. */
  readonly callsReachingBroker: () => number;
}

function fakeAdapter(): AdapterUnderTest {
  const broker = makeFakeBroker();
  return {
    broker,
    callsReachingBroker: () =>
      broker.placeOrder.mock.calls.length + broker.cancelOrder.mock.calls.length,
  };
}

/** The real Robinhood adapter stack over an MCP client that records every tool call. */
function robinhoodAdapter(): AdapterUnderTest {
  const callTool = vi.fn().mockRejectedValue(new Error('no tool call may be made'));
  const mcp = {
    ensureReady: async () => undefined,
    isConnected: () => true,
    getToolNames: () => Object.values(TOOL_NAMES),
    getToolInputSchema: () => undefined,
    callTool,
  } as unknown as RobinhoodMcpClient;
  return {
    broker: new RobinhoodBroker(new RobinhoodTools(mcp)),
    callsReachingBroker: () => callTool.mock.calls.length,
  };
}

const ADAPTERS = [
  ['the shared fake', fakeAdapter],
  ['Robinhood', robinhoodAdapter],
] as const;

const registryOver = (adapter: AdapterUnderTest, mode: TradeExecutionMode): Broker =>
  createMcpRegistry(
    [{ id: 'robinhood', quotesOptions: true, open: () => ({ session: SESSION, broker: adapter.broker }) }],
    mode
  ).for(fakeAccount(USER)).broker;

describe.each(ADAPTERS)('read_only deployment over %s', (_name, makeAdapter) => {
  it('refuses every order and every cancel before the adapter is reached', async () => {
    const adapter = makeAdapter();
    const broker = registryOver(adapter, 'read_only');

    for (const order of WRITES) {
      await expect(broker.placeOrder(order)).rejects.toBeInstanceOf(BrokerWritesDisabledError);
    }
    await expect(broker.cancelOrder(RESTING_STOP_ID)).rejects.toBeInstanceOf(
      BrokerWritesDisabledError
    );

    expect(adapter.callsReachingBroker()).toBe(0);
  });

  it.each(['immediate', 'approval'] as const)(
    '%s is not held here: the registry hands out the adapter\'s own broker',
    (mode) => {
      const adapter = makeAdapter();

      expect(registryOver(adapter, mode)).toBe(adapter.broker);
    }
  );
});

describe('read_only refusal', () => {
  it('names what would have been written, in the words the order refusal always used', async () => {
    const broker = registryOver(fakeAdapter(), 'read_only');

    await expect(broker.placeOrder(WRITES[3]!)).rejects.toThrow(
      'read-only deployment: would have placed sell 2 QQQ 707C 2026-06-11'
    );
    await expect(broker.placeOrder(WRITES[0]!)).rejects.toThrow(
      'read-only deployment: would have placed buy 4 AAPL'
    );
    await expect(broker.cancelOrder(RESTING_STOP_ID)).rejects.toThrow(
      `read-only deployment: would have cancelled order ${RESTING_STOP_ID}`
    );
  });

  it('leaves every read working', async () => {
    const fake = makeFakeBroker({ buyingPowerUsd: 2_500, equityMark: 211, optionMark: 0.8 });
    const broker = registryOver({ broker: fake, callsReachingBroker: () => 0 }, 'read_only');

    expect((await broker.getAccount()).buyingPowerUsd).toBe(2_500);
    expect(await broker.getMark(AAPL)).toBe(211);
    expect(await broker.getMark(QQQ_CALL)).toBe(0.8);
    await broker.confirmInstrument(QQQ_CALL);
    expect(await broker.getPositions('option')).toEqual([]);
    expect(await broker.getOrders()).toBeNull();

    expect(fake.confirmInstrument).toHaveBeenCalledWith(QQQ_CALL);
    expect(fake.getPositions).toHaveBeenCalledWith('option');
    expect(fake.getOrders).toHaveBeenCalledOnce();
  });
});

describe('a registry over several adapters', () => {
  const ROBINHOOD_ACCOUNT = fakeAccount('account-robinhood', USER);
  const PAPER_ACCOUNT: AccountRow = {
    id: 'account-paper',
    userId: USER,
    adapter: 'snaptrade',
    institution: 'alpaca-paper',
    externalAccountId: 'snaptrade-account-1',
    label: 'Alpaca Paper',
    isPaper: true,
    needsReconnect: false,
    adapterData: { connectionId: 'connection-1', institutionSlug: 'ALPACA-PAPER', maskedAccountNumber: '1234' },
  };

  function setup(mode: TradeExecutionMode): {
    brokers: ReturnType<typeof createMcpRegistry>;
    behind: Record<BrokerAdapter['id'], FakeBroker>;
    opened: AccountRow[];
  } {
    const behind = { robinhood: makeFakeBroker(), snaptrade: makeFakeBroker() };
    const opened: AccountRow[] = [];
    const adapter = (id: BrokerAdapter['id']): BrokerAdapter => ({
      id,
      quotesOptions: id === 'robinhood',
      open(account) {
        opened.push(account);
        return { session: SESSION, broker: behind[id] };
      },
    });
    return { brokers: createMcpRegistry([adapter('robinhood'), adapter('snaptrade')], mode), behind, opened };
  }

  it('opens each account with the adapter its row names, once, handing it the row', () => {
    const { brokers, behind, opened } = setup('immediate');

    expect(brokers.for(ROBINHOOD_ACCOUNT)).toMatchObject({ broker: behind.robinhood, quotesOptions: true });
    expect(brokers.for(PAPER_ACCOUNT)).toMatchObject({ broker: behind.snaptrade, quotesOptions: false });
    expect(brokers.for(PAPER_ACCOUNT)).toBe(brokers.existing(PAPER_ACCOUNT.id));
    expect(opened).toEqual([ROBINHOOD_ACCOUNT, PAPER_ACCOUNT]);
  });

  it('read_only refuses every write on every adapter\'s broker', async () => {
    const { brokers, behind } = setup('read_only');

    for (const account of [ROBINHOOD_ACCOUNT, PAPER_ACCOUNT]) {
      const { broker } = brokers.for(account);
      for (const order of WRITES) {
        await expect(broker.placeOrder(order)).rejects.toBeInstanceOf(BrokerWritesDisabledError);
      }
      await expect(broker.cancelOrder(RESTING_STOP_ID)).rejects.toBeInstanceOf(BrokerWritesDisabledError);
    }

    for (const fake of Object.values(behind)) {
      expect(fake.placeOrder).not.toHaveBeenCalled();
      expect(fake.cancelOrder).not.toHaveBeenCalled();
    }
  });

  it('an account whose adapter this deployment does not have is unavailable, not opened by another', () => {
    const robinhoodOnly = createMcpRegistry(
      [{ id: 'robinhood', quotesOptions: true, open: () => ({ session: SESSION, broker: makeFakeBroker() }) }],
      'immediate'
    );

    expect(() => robinhoodOnly.for(PAPER_ACCOUNT)).toThrow(BrokerUnavailableError);
    expect(robinhoodOnly.existing(PAPER_ACCOUNT.id)).toBeUndefined();
  });
});

/**
 * The write paths, each run as if its own `immediate` check had passed, over a
 * registry opened read_only: the guard does not depend on any caller's policy.
 */
describe('read_only deployment: the write paths cannot write', () => {
  function setup(lot: { stopOrderId?: string } = {}): {
    db: FakeDb;
    fake: FakeBroker;
    broker: Broker;
    brokers: ReturnType<typeof makeFakeRegistry>;
  } {
    const db = createFakeDb();
    db.seedBrokerTokens(USER, fakeTokens('tok'));
    db.seedSettings(USER, TradeSettingsSchema.parse({ maxLossPct: 50, exitMode: 'ladder' }));
    db.seedMessage({ messageId: LOT_MESSAGE_ID, sentAt: '2026-06-08T14:00:00.000Z' });
    db.seedDecision(USER, filledBuy(lot.stopOrderId));
    // A mark far above every own-target rung, so the ladder wants to sell.
    const fake = makeFakeBroker({ optionMark: ENTRY_PRICE * 10 });
    const brokers = makeFakeRegistry(() => ({ session: SESSION, broker: fake }), 'read_only');
    return { db, fake, broker: brokers.for(fakeAccount(USER)).broker, brokers };
  }

  const expectNoWrite = (fake: FakeBroker): void => {
    expect(fake.placeOrder).not.toHaveBeenCalled();
    expect(fake.cancelOrder).not.toHaveBeenCalled();
  };

  it('submitOrder', async () => {
    const { fake, broker } = setup();

    await expect(submitOrder(filledBuy().order!, broker)).rejects.toBeInstanceOf(
      BrokerWritesDisabledError
    );

    expectNoWrite(fake);
  });

  it('cancelStops: the resting stop is neither cancelled nor forgotten', async () => {
    const { db, fake, broker } = setup({ stopOrderId: RESTING_STOP_ID });

    await expect(cancelStops(db, USER, broker, 'QQQ', CONTRACT)).rejects.toBeInstanceOf(
      BrokerWritesDisabledError
    );

    expectNoWrite(fake);
    const [lot] = await db.listOpenOptionLots(USER);
    expect(lot!.stopOrderId).toBe(RESTING_STOP_ID);
  });

  it('restMissingStops: no stop is rested and none is recorded', async () => {
    const { db, fake, broker } = setup();

    await restMissingStops({ accountId: USER, db, broker, executionMode: 'immediate' });

    expectNoWrite(fake);
    const [lot] = await db.listOpenOptionLots(USER);
    expect(lot!.stopOrderId).toBeNull();
  });

  it('the own-target ladder: no sell is placed and none is recorded', async () => {
    const { db, fake, brokers } = setup();

    const placed = await sweepLadders({
      db,
      brokers,
      events: new TraderEvents(),
      executionMode: 'immediate',
    });

    expect(placed).toBe(0);
    expectNoWrite(fake);
    expect(await db.listDecisions(USER, 10)).toHaveLength(1);
  });
});

function filledBuy(stopOrderId?: string): Decision {
  return {
    at: '2026-06-08T14:00:00.000Z',
    messageId: LOT_MESSAGE_ID,
    kind: 'submitted',
    code: null,
    reason: 'bought',
    ticker: 'QQQ',
    action: 'buy',
    order: {
      symbol: 'QQQ',
      side: 'buy',
      assetType: 'option',
      quantity: 4,
      orderType: 'limit',
      limitPrice: ENTRY_PRICE,
      option: CONTRACT,
      orderId: 'buy-1',
      status: 'filled',
      ...(stopOrderId !== undefined ? { stopOrderId } : {}),
    },
  };
}
