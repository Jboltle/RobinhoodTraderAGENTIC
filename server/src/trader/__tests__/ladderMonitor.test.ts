/**
 * The own-target ladder under `immediate`: what it sells when a level's target
 * is reached, and that a stop resting on the lot is cancelled before the sell.
 * The read_only case lives in readOnly.test.ts.
 */
import { describe, expect, it } from 'vitest';

import {
  TradeSettingsSchema,
  type Decision,
  type OptionContract,
} from '../../shared/types.js';
import type { Instrument } from '../broker/types.js';
import { TraderEvents } from '../events.js';
import { sweepLadders, type LadderDeps } from '../ladderMonitor.js';
import type { RobinhoodMcpClient } from '../robinhood/mcpClient.js';
import { createFakeDb, fakeTokens, type FakeDb } from './fakeDb.js';
import { makeFakeBroker, makeFakeRegistry, type FakeBroker } from './harness.js';

const USER = 'user-1';
const CONTRACT: OptionContract = { optionType: 'call', strike: 707, expiration: '2026-06-11' };
const QQQ_CALL: Instrument = { kind: 'option', symbol: 'QQQ', ...CONTRACT };
const LOT_MESSAGE_ID = 'buy-QQQ';
const LOT_CONTRACTS = 4;
const ENTRY_PRICE = 1;
const RESTING_STOP_ID = 'stop-1';

/** Half the lot at +50%, the other half at +100%. */
const TRIM_LEVELS = [
  { gainPct: 50, portionPct: 50 },
  { gainPct: 100, portionPct: 50 },
];
const FIRST_TARGET = 1.5;
const FIRST_LEVEL_CONTRACTS = 2;
/** Past the first target, short of the second. */
const MARK = 1.6;

const SESSION = { ensureReady: async () => undefined } as unknown as RobinhoodMcpClient;

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
      quantity: LOT_CONTRACTS,
      orderType: 'limit',
      limitPrice: ENTRY_PRICE,
      option: CONTRACT,
      orderId: 'buy-1',
      status: 'filled',
      ...(stopOrderId !== undefined ? { stopOrderId } : {}),
    },
  };
}

function setup(lot: { stopOrderId?: string } = {}): { db: FakeDb; fake: FakeBroker; deps: LadderDeps } {
  const db = createFakeDb();
  db.seedBrokerTokens(USER, fakeTokens('tok'));
  db.seedSettings(USER, TradeSettingsSchema.parse({ exitMode: 'ladder', trimLevels: TRIM_LEVELS }));
  db.seedMessage({ messageId: LOT_MESSAGE_ID, sentAt: '2026-06-08T14:00:00.000Z' });
  db.seedDecision(USER, filledBuy(lot.stopOrderId));
  const fake = makeFakeBroker({ optionMark: MARK });
  const brokers = makeFakeRegistry(() => ({ session: SESSION, broker: fake }));
  return { db, fake, deps: { db, brokers, events: new TraderEvents(), executionMode: 'immediate' } };
}

describe('the own-target ladder under immediate', () => {
  it("a target hit places a limit sell at the target price for that level's contracts", async () => {
    const { db, fake, deps } = setup();

    expect(await sweepLadders(deps)).toBe(1);

    expect(fake.placeOrder.mock.calls).toEqual([
      [
        {
          instrument: QQQ_CALL,
          side: 'sell',
          quantity: FIRST_LEVEL_CONTRACTS,
          type: 'limit',
          limitPrice: FIRST_TARGET,
        },
      ],
    ]);
    expect(fake.cancelOrder).not.toHaveBeenCalled();
    const [decision] = await db.listDecisions(USER, 10);
    expect(decision).toMatchObject({
      messageId: `ladder:${LOT_MESSAGE_ID}:50`,
      kind: 'submitted',
      action: 'sell',
      order: {
        quantity: FIRST_LEVEL_CONTRACTS,
        orderType: 'limit',
        limitPrice: FIRST_TARGET,
        orderId: 'opt-001',
        lots: [{ lotId: LOT_MESSAGE_ID, quantity: FIRST_LEVEL_CONTRACTS, gainPct: 50 }],
      },
    });
  });

  it("cancels the lot's resting stop, then places the sell", async () => {
    const { db, fake, deps } = setup({ stopOrderId: RESTING_STOP_ID });

    expect(await sweepLadders(deps)).toBe(1);

    expect(fake.cancelOrder.mock.calls).toEqual([[RESTING_STOP_ID]]);
    expect(fake.placeOrder).toHaveBeenCalledOnce();
    expect(fake.cancelOrder.mock.invocationCallOrder[0]!).toBeLessThan(
      fake.placeOrder.mock.invocationCallOrder[0]!
    );
    const [lot] = await db.listOpenOptionLots(USER);
    expect(lot!.stopOrderId).toBeNull();
  });
});
