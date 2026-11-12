/**
 * The shared quote source: which connected session prices a contract for the
 * readers that have no account of their own to ask, and how long getMark keeps
 * a price before asking again.
 */
import { describe, expect, it, vi } from 'vitest';

import { BrokerUnavailableError } from '../broker/errors.js';
import { createQuoteSource, MARK_CACHE_MS, type QuoteSessionState } from '../broker/quotes.js';
import { createMcpRegistry } from '../broker/registry.js';
import type { Instrument } from '../broker/types.js';
import type { RobinhoodMcpClient } from '../robinhood/mcpClient.js';
import { createFakeDb, fakeTokens } from './fakeDb.js';
import { makeFakeBroker, makeFakeRegistry, markReads, type FakeBroker } from './harness.js';

const START = new Date('2026-10-20T14:30:00.000Z');
const SPY_CALL: Instrument = {
  kind: 'option',
  symbol: 'SPY',
  optionType: 'call',
  strike: 680,
  expiration: '2026-10-23',
};
const SPY_PUT: Instrument = { ...SPY_CALL, optionType: 'put' };

interface Session {
  readonly session: RobinhoodMcpClient;
  readonly broker: FakeBroker;
}

const readySession = (broker: FakeBroker = makeFakeBroker()): Session => ({
  session: { ensureReady: vi.fn().mockResolvedValue(undefined) } as unknown as RobinhoodMcpClient,
  broker,
});

const sessionNeedingConsent = (): Session => ({
  session: {
    ensureReady: vi.fn().mockRejectedValue(new BrokerUnavailableError('needs consent')),
  } as unknown as RobinhoodMcpClient,
  broker: makeFakeBroker(),
});

function setup(sessions: Record<string, Session>, state?: QuoteSessionState) {
  const db = createFakeDb();
  for (const userId of Object.keys(sessions)) db.seedBrokerTokens(userId, fakeTokens(userId));
  const clock = { now: START };
  const quotes = createQuoteSource(
    { db, brokers: makeFakeRegistry((userId) => sessions[userId]!), now: () => clock.now },
    state
  );
  const advance = (ms: number): void => {
    clock.now = new Date(clock.now.getTime() + ms);
  };
  return { quotes, advance };
}

describe('quote source: getMark', () => {
  it(`keeps a contract's price for ${MARK_CACHE_MS} ms, then asks the broker again`, async () => {
    let mark = 0.8;
    const broker = makeFakeBroker({ optionMark: () => mark });
    const { quotes, advance } = setup({ u1: readySession(broker) });

    expect(await quotes.getMark(SPY_CALL)).toBe(0.8);
    mark = 0.9;
    advance(MARK_CACHE_MS - 1);
    expect(await quotes.getMark({ ...SPY_CALL })).toBe(0.8);
    expect(markReads(broker, 'option')).toHaveLength(1);

    advance(1);
    expect(await quotes.getMark(SPY_CALL)).toBe(0.9);
    expect(markReads(broker, 'option')).toHaveLength(2);
  });

  it('keeps each contract separately', async () => {
    const broker = makeFakeBroker({
      optionMark: (contract) => (contract.optionType === 'call' ? 0.8 : 0.3),
    });
    const { quotes } = setup({ u1: readySession(broker) });

    expect(await quotes.getMark(SPY_CALL)).toBe(0.8);
    expect(await quotes.getMark(SPY_PUT)).toBe(0.3);
    expect(await quotes.getMark(SPY_PUT)).toBe(0.3);
    expect(markReads(broker, 'option')).toEqual([SPY_CALL, SPY_PUT]);
  });

  it('never remembers a missing price or a failed read', async () => {
    const answers: Array<() => number | null> = [
      () => null,
      () => {
        throw new Error('MCP transport closed');
      },
      () => 0.8,
    ];
    const broker = makeFakeBroker({ optionMark: () => answers.shift()!() });
    const { quotes } = setup({ u1: readySession(broker) });

    expect(await quotes.getMark(SPY_CALL)).toBeNull();
    expect(await quotes.getMark(SPY_CALL)).toBeNull();
    expect(await quotes.getMark(SPY_CALL)).toBe(0.8);
    expect(markReads(broker, 'option')).toHaveLength(3);
  });

  it('is null when no connected session is ready', async () => {
    const { quotes } = setup({ u1: sessionNeedingConsent() });

    expect(await quotes.getMark(SPY_CALL)).toBeNull();
  });
});

describe('quote source: which session is asked', () => {
  it('skips a session that needs consent and remembers the one that answered', async () => {
    const dead = sessionNeedingConsent();
    const live = readySession();
    const state: QuoteSessionState = { preferredAccountId: null };
    const { quotes } = setup({ u1: dead, u2: live }, state);

    expect(await quotes.broker()).toBe(live.broker);
    expect(state.preferredAccountId).toBe('u2');

    // The remembered session is tried first: the dead one is not asked again.
    expect(await quotes.broker()).toBe(live.broker);
    expect(dead.session.ensureReady).toHaveBeenCalledOnce();
  });

  it('asks only sessions whose adapter quotes options', async () => {
    const db = createFakeDb();
    db.seedBrokerTokens('u1', fakeTokens('u1'));
    const cannotQuote = readySession();
    const brokers = createMcpRegistry(
      [{ id: 'robinhood', quotesOptions: false, open: () => cannotQuote }],
      'immediate'
    );

    expect(await createQuoteSource({ db, brokers }).broker()).toBeNull();
    expect(cannotQuote.session.ensureReady).not.toHaveBeenCalled();
  });

  it('reads through the picked session are live, not cached', async () => {
    const broker = makeFakeBroker({ optionMark: 0.8 });
    const { quotes } = setup({ u1: readySession(broker) });

    const picked = await quotes.broker();
    await picked!.getMark(SPY_CALL);
    await picked!.getMark(SPY_CALL);

    expect(markReads(broker, 'option')).toHaveLength(2);
  });
});
