/**
 * Pipeline integration tests — from DiscordEnvelope to per-user Decision rows,
 * with a mocked parser, stubbed Robinhood tools and the in-memory db.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  Callout,
  CalloutParser,
  Decision,
  DiscordEnvelope,
  TradeSettings,
} from '../../../shared/types.js';
import { createFakeDb, fakeTokens, type FakeDb } from '../../__tests__/fakeDb.js';
import { TraderEvents } from '../../events.js';
import type { McpRegistry, UserBroker } from '../../rh/mcpRegistry.js';
import { BrokerUnavailableError, type RobinhoodMcpClient } from '../../rh/mcpClient.js';
import { SymbolNotFoundError, type RobinhoodTools } from '../../rh/tools.js';
import { JevCalloutDecider } from '../decide.js';
import { contractsForPortion } from '../execute.js';
import { createMessageProcessor, liveCallerContracts, type PipelineDeps } from '../index.js';
import { ACTIONS, JevError, type Action, type JevVerdict } from '../jev.js';
import {
  AVG_DOWN_SPY_PUT,
  BTO_QQQ_PUT,
  TRIM_QQQ_DOUBLE,
  TRIM_QQQ_FIRST,
  RUNNERS_ONLY_QQQ,
  HYPE_BANG,
  envelopeFromFixture,
} from './fixtures/discordMessages.js';

const USER = 'user-1';
const OTHER_USER = 'user-2';

/**
 * A user set up to actually trade: auto-executing, following everyone, and
 * with the hours/cooldown/options guards relaxed so tests exercise the path
 * under test rather than the calendar.
 */
const TRADING_SETTINGS = {
  executionMode: 'immediate',
  followedCallerIds: null,
  regularHoursOnly: false,
  cooldownSeconds: 0,
  optionsFullPct: 10,
  maxSingleContractPct: 10,
} as const satisfies TradeSettings;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTools(overrides: Partial<RobinhoodTools> = {}): RobinhoodTools {
  return {
    getBuyingPower: vi.fn().mockResolvedValue({ amountUsd: 10_000 }),
    getQuote: vi.fn().mockResolvedValue({ price: 150 }),
    getOptionsMarkPrice: vi.fn().mockResolvedValue({ markPrice: 0.97 }),
    placeOrder: vi.fn().mockResolvedValue({ orderId: 'eq-001', status: 'queued' }),
    placeOptionsOrder: vi.fn().mockResolvedValue({ orderId: 'opt-001', status: 'queued' }),
    getPositions: vi.fn().mockResolvedValue({ positions: [], raw: {} }),
    getOptionPositions: vi.fn().mockResolvedValue({
      positions: [
        { symbol: 'QQQ', optionType: 'call', strike: 707, expiration: '2026-06-11', quantity: 5, raw: {} },
      ],
      raw: {},
    }),
    ...overrides,
  } as unknown as RobinhoodTools;
}

const makeMcp = (): RobinhoodMcpClient =>
  ({ isConnected: vi.fn().mockReturnValue(true) }) as unknown as RobinhoodMcpClient;

function makeRegistry(toolsByUser: Map<string, RobinhoodTools>): McpRegistry {
  const brokers = new Map<string, UserBroker>();
  const forUser = (userId: string): UserBroker => {
    let broker = brokers.get(userId);
    if (!broker) {
      broker = { mcp: makeMcp(), tools: toolsByUser.get(userId) ?? makeTools() };
      brokers.set(userId, broker);
    }
    return broker;
  };
  return { for: forUser, existing: (id) => brokers.get(id), drop: (id) => void brokers.delete(id) };
}

function makeParser(callout: Callout | Error): CalloutParser {
  return {
    parse:
      callout instanceof Error
        ? vi.fn().mockRejectedValue(callout)
        : vi.fn().mockResolvedValue(callout),
  };
}

interface Setup {
  readonly db: FakeDb;
  readonly deps: PipelineDeps;
  readonly tools: RobinhoodTools;
  readonly events: TraderEvents;
}

/** One connected user by default; extra users get their own tools. */
function setup(
  callout: Callout | Error,
  toolsOverrides: Partial<RobinhoodTools> = {},
  users: readonly string[] = [USER]
): Setup {
  const db = createFakeDb();
  const toolsByUser = new Map<string, RobinhoodTools>();
  for (const userId of users) {
    db.seedBrokerTokens(userId, fakeTokens(`token-${userId}`));
    // The schema now defaults to approval mode and following nobody, so the
    // baseline test user has to opt back in to auto-execution explicitly.
    db.seedSettings(userId, { ...TRADING_SETTINGS });
    toolsByUser.set(userId, makeTools(toolsOverrides));
  }

  const events = new TraderEvents();
  const deps: PipelineDeps = {
    parser: makeParser(callout),
    db,
    events,
    brokers: makeRegistry(toolsByUser),
  };
  return { db, deps, tools: toolsByUser.get(users[0]!)!, events };
}

/** Run one message through the fan-out and return the first user's outcome. */
async function runWith(
  envelope: DiscordEnvelope,
  callout: Callout | Error,
  toolsOverrides: Partial<RobinhoodTools> = {}
): Promise<{ decision: Decision; tools: RobinhoodTools; db: FakeDb }> {
  const { db, deps, tools } = setup(callout, toolsOverrides);
  await createMessageProcessor(deps).process(envelope);
  const decisions = await db.listDecisions(USER, 10);
  return { decision: decisions[0]!, tools, db };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fan-out — non-callouts', () => {
  it('records channel chatter on the shared row only, with no per-user work', async () => {
    const { db, deps } = setup(HYPE_BANG.expectedCallout, {}, [USER, OTHER_USER]);

    await createMessageProcessor(deps).process(envelopeFromFixture(HYPE_BANG));

    const stored = db.getMessage(envelopeFromFixture(HYPE_BANG).messageId);
    expect(stored?.disposition).toBe('not_callout');
    // The messages table constraint keeps `parse` for real Callouts only, and
    // nothing downstream reads a non-callout parse.
    expect(stored?.parse).toBeNull();

    // No trade rows for a message nobody can act on.
    expect(await db.listDecisions(USER, 10)).toEqual([]);
    expect(await db.listDecisions(OTHER_USER, 10)).toEqual([]);
  });

  it('clears the in-flight banner for every user when the parse is chatter', async () => {
    const { deps, events } = setup(HYPE_BANG.expectedCallout);
    const stages: string[] = [];
    events.subscribe(USER, { onStage: (event) => stages.push(event.stage) });

    await createMessageProcessor(deps).process(envelopeFromFixture(HYPE_BANG));

    expect(stages).toEqual(['received', 'done']);
  });
});

describe('fan-out — BTO entry', () => {
  it('submits a limit buy for BTO $QQQ 710p', async () => {
    const { decision, tools } = await runWith(
      envelopeFromFixture(BTO_QQQ_PUT),
      BTO_QQQ_PUT.expectedCallout
    );

    expect(decision.kind).toBe('submitted');
    expect(decision.order).toMatchObject({
      symbol: 'QQQ',
      side: 'buy',
      assetType: 'option',
      orderType: 'limit',
      limitPrice: 0.97,
    });
    expect(tools.placeOptionsOrder).toHaveBeenCalledOnce();
  });

  it('records the callout verdict and its parse on the messages row', async () => {
    const { db } = await runWith(envelopeFromFixture(BTO_QQQ_PUT), BTO_QQQ_PUT.expectedCallout);
    const stored = db.getMessage(envelopeFromFixture(BTO_QQQ_PUT).messageId);
    expect(stored?.disposition).toBe('callout');
    expect(stored?.parse).toMatchObject({ ticker: 'QQQ', assetType: 'option' });
  });
});

describe('fan-out — TRIM exit', () => {
  it('submits a market sell for TRIM QQQ 707C', async () => {
    const { decision, tools } = await runWith(
      envelopeFromFixture(TRIM_QQQ_FIRST),
      TRIM_QQQ_FIRST.expectedCallout
    );

    expect(decision.kind).toBe('submitted');
    expect(decision.order).toMatchObject({
      symbol: 'QQQ',
      side: 'sell',
      assetType: 'option',
      orderType: 'market',
    });
    const call = (tools.placeOptionsOrder as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.side).toBe('sell');
    expect(call.strike).toBe(707);
    expect(call.contracts).toBe(1);
    expect(tools.getBuyingPower).not.toHaveBeenCalled();
  });

  it('sells most and leaves one contract for TRIM TRIM / heavy exits', async () => {
    const { decision } = await runWith(
      envelopeFromFixture(TRIM_QQQ_DOUBLE),
      TRIM_QQQ_DOUBLE.expectedCallout
    );
    expect(decision.order?.quantity).toBe(4);
  });

  it('caps heavy exits to one contract when only one is held', async () => {
    const { decision } = await runWith(
      envelopeFromFixture(RUNNERS_ONLY_QQQ),
      RUNNERS_ONLY_QQQ.expectedCallout,
      {
        getOptionPositions: vi.fn().mockResolvedValue({
          positions: [
            { symbol: 'QQQ', optionType: 'call', strike: 707, expiration: '2026-06-11', quantity: 1, raw: {} },
          ],
          raw: {},
        }),
      }
    );
    expect(decision.order?.quantity).toBe(1);
  });

  it('rejects option exits when the matching position is not open', async () => {
    const { decision, tools } = await runWith(
      envelopeFromFixture(TRIM_QQQ_FIRST),
      TRIM_QQQ_FIRST.expectedCallout,
      { getOptionPositions: vi.fn().mockResolvedValue({ positions: [], raw: {} }) }
    );

    expect(decision.kind).toBe('risk_rejected');
    expect(decision.reason).toMatch(/no open QQQ 707C 2026-06-11 position/);
    expect(tools.placeOptionsOrder).not.toHaveBeenCalled();
  });
});

describe('fan-out — ticker-only exits ("out of QQQ")', () => {
  const EXIT_AT = '2026-09-30T13:35:00.000Z';

  const exitFrom = (authorId: string): DiscordEnvelope => ({
    messageId: 'exit-001',
    channelId: 'chan-001',
    guildId: null,
    authorId,
    authorName: 'Bishop',
    authorAvatarUrl: null,
    content: "Bishop's Ideas\nLmao okay, out of QQQ",
    timestamp: EXIT_AT,
  });

  const TICKER_ONLY_EXIT: Callout = {
    isCallout: true,
    assetType: 'option',
    action: 'sell',
    isAddition: false,
    tickerOnlyExit: true,
    ticker: 'QQQ',
    orderType: 'market',
    limitPrice: null,
    sizeHint: null,
    positionSize: null,
    option: null,
    confidence: 0.9,
    rationale: 'caller is out of QQQ',
  };

  const entry = (strike: number, expiration = '2026-10-02'): Callout => ({
    ...TICKER_ONLY_EXIT,
    action: 'buy',
    tickerOnlyExit: false,
    orderType: 'limit',
    limitPrice: 1.2,
    option: { optionType: 'call', strike, expiration },
    rationale: `BTO QQQ ${strike}C`,
  });

  const seedEntry = (
    db: FakeDb,
    messageId: string,
    authorId: string,
    callout: Callout,
    sentAt = '2026-09-30T13:34:00.000Z'
  ): void =>
    db.seedMessage({ messageId, sentAt, authorId, disposition: 'callout', parse: callout, processedAt: sentAt });

  const holdsBothStrikes = {
    getOptionPositions: vi.fn().mockResolvedValue({
      positions: [
        { symbol: 'QQQ', optionType: 'call', strike: 234, expiration: '2026-10-02', quantity: 3, raw: {} },
        { symbol: 'QQQ', optionType: 'call', strike: 255, expiration: '2026-10-02', quantity: 2, raw: {} },
      ],
      raw: {},
    }),
  };

  it("sells the whole position in the Caller's own contract, never another Caller's", async () => {
    const { db, deps, tools } = setup(TICKER_ONLY_EXIT, holdsBothStrikes);
    seedEntry(db, 'entry-a', 'caller-a', entry(234));
    seedEntry(db, 'entry-b', 'caller-b', entry(255), '2026-09-30T13:34:30.000Z');

    await createMessageProcessor(deps).process(exitFrom('caller-a'));

    const [decision] = await db.listDecisions(USER, 10);
    expect(decision?.kind).toBe('submitted');
    const call = (tools.placeOptionsOrder as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call).toMatchObject({ side: 'sell', strike: 234, contracts: 3 });
    expect(db.getMessage('exit-001')?.parse?.option).toEqual({
      optionType: 'call',
      strike: 234,
      expiration: '2026-10-02',
    });
  });

  it('rejects instead of guessing when the Caller has no open entry in the ticker', async () => {
    const { db, deps, tools } = setup(TICKER_ONLY_EXIT, holdsBothStrikes);
    seedEntry(db, 'entry-b', 'caller-b', entry(255));

    await createMessageProcessor(deps).process(exitFrom('caller-a'));

    const [decision] = await db.listDecisions(USER, 10);
    expect(decision).toMatchObject({ kind: 'risk_rejected', code: 'missing_contract' });
    expect(tools.placeOptionsOrder).not.toHaveBeenCalled();
  });

  it('lists the live entries newest first, each contract once', () => {
    const newestFirst = [entry(240, '2026-09-29'), entry(236), entry(234), entry(236)];
    expect(liveCallerContracts(newestFirst, EXIT_AT).map((option) => option.strike)).toEqual([236, 234]);
  });

  it('treats a contract expiring on the exit day as still live', () => {
    expect(liveCallerContracts([entry(234, '2026-09-30')], EXIT_AT).map((option) => option.strike)).toEqual([234]);
  });

  it('matches nothing when only expired or equity entries remain', () => {
    const equity: Callout = { ...entry(1), assetType: 'equity', option: null };
    expect(liveCallerContracts([equity, entry(234, '2026-09-29')], EXIT_AT)).toEqual([]);
  });

  it("counts only the Caller's Jev entries once there are any, and never an add", () => {
    const parserWatchlist = entry(250);
    const jevEntry: Callout = { ...entry(245), engine: 'jev' };
    expect(liveCallerContracts([parserWatchlist, jevEntry], EXIT_AT).map((option) => option.strike)).toEqual([245]);
    const add: Callout = { ...entry(240), isAddition: true };
    expect(liveCallerContracts([add, entry(236)], EXIT_AT).map((option) => option.strike)).toEqual([236]);
  });
});

describe('fan-out — averaging-down adds', () => {
  // Real incident (2026-09-22): a desk's "AVERAGING DOWN" status card parsed
  // as a fresh entry and submitted 20 naked 0DTE puts for users who never
  // held the position. Adds must require an existing position.
  it('rejects an add when the user holds no matching position', async () => {
    const { decision, tools } = await runWith(
      envelopeFromFixture(AVG_DOWN_SPY_PUT),
      AVG_DOWN_SPY_PUT.expectedCallout
      // default tools hold only QQQ 707C — no SPY 772P position
    );

    expect(decision.kind).toBe('risk_rejected');
    expect(decision.reason).toMatch(/no open SPY 772P 2026-09-22 position to add to/);
    expect(tools.placeOptionsOrder).not.toHaveBeenCalled();
  });

  it('executes the add for a user who holds the position', async () => {
    const { decision, tools } = await runWith(
      envelopeFromFixture(AVG_DOWN_SPY_PUT),
      AVG_DOWN_SPY_PUT.expectedCallout,
      {
        getOptionPositions: vi.fn().mockResolvedValue({
          positions: [
            { symbol: 'SPY', optionType: 'put', strike: 772, expiration: '2026-09-22', quantity: 25, raw: {} },
          ],
          raw: {},
        }),
      }
    );

    expect(decision.kind).toBe('submitted');
    const call = (tools.placeOptionsOrder as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.side).toBe('buy');
    expect(call.strike).toBe(772);
    expect(call.limitPremium).toBe(0.295);
  });
});

describe('fan-out — parse consistency guardrails', () => {
  // Real incident (2026-07-15): profit brag parsed by the LLM as an equity
  // buy with the current option premium as the limit price.
  const INCIDENT_ENVELOPE: DiscordEnvelope = {
    messageId: 'incident-aapl-brag',
    channelId: 'test-channel',
    guildId: 'test-guild',
    authorId: 'test-author',
    authorName: 'Natalie Options Alert',
    authorAvatarUrl: null,
    content: '**130%** 🔥aapl calls 3.38 to 7.70 now!!! 🚀',
    timestamp: '2026-07-15T15:36:00.000Z',
  };

  const BAD_EQUITY_PARSE: Callout = {
    isCallout: true,
    isAddition: false,
    assetType: 'equity',
    action: 'buy',
    ticker: 'AAPL',
    orderType: 'limit',
    limitPrice: 7.7,
    sizeHint: null,
    positionSize: null,
    option: null,
    confidence: 0.95,
    rationale: 'buy AAPL at 7.70',
  };

  it('rejects an equity parse of an options-language message (the AAPL incident)', async () => {
    const { decision, tools } = await runWith(INCIDENT_ENVELOPE, BAD_EQUITY_PARSE);

    expect(decision.kind).toBe('risk_rejected');
    expect(decision.code).toBe('parse_inconsistent');
    expect(decision.order).toBeNull();
    expect(tools.placeOrder).not.toHaveBeenCalled();
  });

  it('rejects an equity limit buy wildly below the live quote', async () => {
    const envelope: DiscordEnvelope = {
      ...INCIDENT_ENVELOPE,
      messageId: 'incident-cheap-limit',
      content: 'grabbing some AAPL here 7.70', // no options language — passes the text check
    };

    const { decision, tools } = await runWith(envelope, BAD_EQUITY_PARSE, {
      getQuote: vi.fn().mockResolvedValue({ price: 211 }),
    });

    expect(decision.kind).toBe('risk_rejected');
    expect(decision.code).toBe('parse_inconsistent');
    expect(decision.reason).toMatch(/option premium misread/);
    expect(tools.placeOrder).not.toHaveBeenCalled();
  });

  it('still submits a plausible equity limit buy', async () => {
    const envelope: DiscordEnvelope = {
      ...INCIDENT_ENVELOPE,
      messageId: 'plausible-equity-buy',
      content: 'grabbing some AAPL here, 145 limit',
    };
    const { decision, tools } = await runWith(envelope, { ...BAD_EQUITY_PARSE, limitPrice: 145 });

    expect(decision.kind).toBe('submitted');
    expect(decision.order).toMatchObject({ symbol: 'AAPL', assetType: 'equity', limitPrice: 145 });
    expect(tools.placeOrder).toHaveBeenCalledOnce();
  });
});

describe('fan-out — approval mode', () => {
  it("a user's own 'approval' setting parks the trade without submitting", async () => {
    const { db, deps, tools } = setup(BTO_QQQ_PUT.expectedCallout);
    db.seedSettings(USER, { ...TRADING_SETTINGS, executionMode: 'approval' });

    await createMessageProcessor(deps).process(envelopeFromFixture(BTO_QQQ_PUT));

    const [decision] = await db.listDecisions(USER, 10);
    expect(decision!.kind).toBe('pending_approval');
    expect(tools.placeOptionsOrder).not.toHaveBeenCalled();
  });

  // Sizing happens before the approval gate so the dashboard can show what is
  // being approved, and so the approve endpoint has an order to submit.
  it('parks a fully sized order, not a bare intent', async () => {
    const { db, deps } = setup(BTO_QQQ_PUT.expectedCallout);
    db.seedSettings(USER, { ...TRADING_SETTINGS, executionMode: 'approval' });

    await createMessageProcessor(deps).process(envelopeFromFixture(BTO_QQQ_PUT));

    const [decision] = await db.listDecisions(USER, 10);
    expect(decision!.order).toMatchObject({
      symbol: 'QQQ',
      assetType: 'option',
      orderId: null,
      status: null,
    });
    expect(decision!.order!.quantity).toBeGreaterThan(0);
    expect(decision!.reason).toContain(`${decision!.order!.quantity}x QQQ`);
  });
});

describe('fan-out — error paths', () => {
  it('records parser_error when the LLM throws', async () => {
    const { decision, db } = await runWith(
      envelopeFromFixture(BTO_QQQ_PUT),
      new Error('LLM rate limited')
    );

    expect(decision.kind).toBe('parser_error');
    expect(decision.code).toBe('parse_failed');
    expect(db.getMessage(envelopeFromFixture(BTO_QQQ_PUT).messageId)?.disposition).toBe('failed');
  });

  it('records risk_rejected for a low-confidence callout', async () => {
    const lowConf: Callout = { ...BTO_QQQ_PUT.expectedCallout, confidence: 0.3 };
    const { decision, tools } = await runWith(envelopeFromFixture(BTO_QQQ_PUT), lowConf);

    expect(decision.kind).toBe('risk_rejected');
    expect(decision.code).toBe('low_confidence');
    expect(tools.placeOptionsOrder).not.toHaveBeenCalled();
  });

  it('records risk_rejected when buying power is zero', async () => {
    const { decision } = await runWith(
      envelopeFromFixture(BTO_QQQ_PUT),
      BTO_QQQ_PUT.expectedCallout,
      { getBuyingPower: vi.fn().mockResolvedValue({ amountUsd: 0 }) }
    );

    expect(decision.kind).toBe('risk_rejected');
    expect(decision.code).toBe('insufficient_capital');
    expect(decision.reason).toMatch(/zero/i);
  });

  it('rejects before placing when the broker has no quote for the ticker', async () => {
    const mtsla: Callout = { ...BTO_QQQ_PUT.expectedCallout, ticker: 'MTSLA' };
    const { decision, tools } = await runWith(
      envelopeFromFixture(BTO_QQQ_PUT),
      mtsla,
      { getQuote: vi.fn().mockRejectedValue(new SymbolNotFoundError('no quote price')) }
    );

    expect(decision.kind).toBe('risk_rejected');
    expect(decision.code).toBe('ticker_invalid');
    expect(decision.reason).toMatch(/MTSLA/);
    expect(tools.placeOptionsOrder).not.toHaveBeenCalled();
    expect(tools.getOptionsMarkPrice).not.toHaveBeenCalled();
    expect(tools.getBuyingPower).not.toHaveBeenCalled();
  });

  it('records broker_unavailable, not ticker_invalid, when the Robinhood session is down', async () => {
    const { decision, tools } = await runWith(
      envelopeFromFixture(BTO_QQQ_PUT),
      BTO_QQQ_PUT.expectedCallout,
      {
        getQuote: vi
          .fn()
          .mockRejectedValue(new BrokerUnavailableError('Robinhood authorization required')),
      }
    );

    expect(decision.kind).toBe('execution_failed');
    expect(decision.code).toBe('broker_unavailable');
    expect(decision.reason).toMatch(/authorization required/);
    expect(tools.placeOptionsOrder).not.toHaveBeenCalled();
  });

  it('records execution_error, not ticker_invalid, when the quote call fails in transit', async () => {
    const { decision } = await runWith(
      envelopeFromFixture(BTO_QQQ_PUT),
      BTO_QQQ_PUT.expectedCallout,
      { getQuote: vi.fn().mockRejectedValue(new Error('fetch failed')) }
    );

    expect(decision.kind).toBe('execution_failed');
    expect(decision.code).toBe('execution_error');
  });

  it('records execution_failed when placeOptionsOrder throws', async () => {
    const { decision } = await runWith(
      envelopeFromFixture(BTO_QQQ_PUT),
      BTO_QQQ_PUT.expectedCallout,
      { placeOptionsOrder: vi.fn().mockRejectedValue(new Error('broker rejected')) }
    );

    expect(decision.kind).toBe('execution_failed');
    expect(decision.code).toBe('execution_error');
  });

  it('records risk_rejected when a single contract exceeds maxSingleContractPct', async () => {
    const expensive: Callout = { ...BTO_QQQ_PUT.expectedCallout, limitPrice: 50 };
    const { decision } = await runWith(envelopeFromFixture(BTO_QQQ_PUT), expensive);

    expect(decision.kind).toBe('risk_rejected');
    expect(decision.code).toBe('insufficient_capital');
    expect(decision.reason).toMatch(/MAX_SINGLE_CONTRACT_PCT/);
  });
});

describe('fan-out — several users', () => {
  beforeEach(() => vi.clearAllMocks());

  it('parses once and records one decision per connected user', async () => {
    const { db, deps } = setup(BTO_QQQ_PUT.expectedCallout, {}, [USER, OTHER_USER]);

    await createMessageProcessor(deps).process(envelopeFromFixture(BTO_QQQ_PUT));

    expect(deps.parser.parse).toHaveBeenCalledOnce();
    expect((await db.listDecisions(USER, 10))[0]!.kind).toBe('submitted');
    expect((await db.listDecisions(OTHER_USER, 10))[0]!.kind).toBe('submitted');
  });

  it('applies each user\u2019s own settings to the same callout', async () => {
    const { db, deps } = setup(BTO_QQQ_PUT.expectedCallout, {}, [USER, OTHER_USER]);
    db.seedSettings(OTHER_USER, { ...TRADING_SETTINGS, blockedTickers: ['QQQ'] });

    await createMessageProcessor(deps).process(envelopeFromFixture(BTO_QQQ_PUT));

    expect((await db.listDecisions(USER, 10))[0]!.kind).toBe('submitted');
    const other = (await db.listDecisions(OTHER_USER, 10))[0]!;
    expect(other.kind).toBe('risk_rejected');
    expect(other.code).toBe('ticker_blocked');
  });

  it("one user's broker failure does not stop the others", async () => {
    const db = createFakeDb();
    const toolsByUser = new Map<string, RobinhoodTools>([
      [USER, makeTools({ getBuyingPower: vi.fn().mockRejectedValue(new Error('MCP transport closed')) })],
      [OTHER_USER, makeTools()],
    ]);
    for (const userId of [USER, OTHER_USER]) {
      db.seedBrokerTokens(userId, fakeTokens(`token-${userId}`));
      db.seedSettings(userId, { ...TRADING_SETTINGS });
    }

    await createMessageProcessor({
      parser: makeParser(BTO_QQQ_PUT.expectedCallout),
      db,
      events: new TraderEvents(),
      brokers: makeRegistry(toolsByUser),
    }).process(envelopeFromFixture(BTO_QQQ_PUT));

    expect((await db.listDecisions(USER, 10))[0]!.kind).toBe('execution_failed');
    expect((await db.listDecisions(OTHER_USER, 10))[0]!.kind).toBe('submitted');
    expect(toolsByUser.get(OTHER_USER)!.placeOptionsOrder).toHaveBeenCalledOnce();
  });
});

describe('fan-out — Following', () => {
  // envelopeFromFixture always posts as authorId 'test-author'.

  it('legacy null Following trades on every Caller', async () => {
    const { decision } = await runWith(
      envelopeFromFixture(BTO_QQQ_PUT),
      BTO_QQQ_PUT.expectedCallout
    );
    expect(decision.kind).toBe('submitted');
  });

  // The reason a fresh account cannot copy nineteen strangers on day one.
  it('the default follows no one, so a brand-new account trades nothing', async () => {
    const { db, deps, tools } = setup(BTO_QQQ_PUT.expectedCallout);
    db.seedSettings(USER, {});

    await createMessageProcessor(deps).process(envelopeFromFixture(BTO_QQQ_PUT));

    expect(await db.listDecisions(USER, 10)).toEqual([]);
    expect(tools.placeOptionsOrder).not.toHaveBeenCalled();
  });

  it('an explicit list including the author trades normally', async () => {
    const { db, deps } = setup(BTO_QQQ_PUT.expectedCallout);
    db.seedSettings(USER, { ...TRADING_SETTINGS, followedCallerIds: ['test-author'] });

    await createMessageProcessor(deps).process(envelopeFromFixture(BTO_QQQ_PUT));

    expect((await db.listDecisions(USER, 10))[0]!.kind).toBe('submitted');
  });

  it('an explicit list excluding the author skips silently — no trade, no record', async () => {
    const { db, deps, tools } = setup(BTO_QQQ_PUT.expectedCallout);
    db.seedSettings(USER, { ...TRADING_SETTINGS, followedCallerIds: ['someone-else'] });

    await createMessageProcessor(deps).process(envelopeFromFixture(BTO_QQQ_PUT));

    expect(await db.listDecisions(USER, 10)).toEqual([]);
    expect(tools.placeOptionsOrder).not.toHaveBeenCalled();
  });

  it('an empty list follows no one', async () => {
    const { db, deps, tools } = setup(BTO_QQQ_PUT.expectedCallout);
    db.seedSettings(USER, { ...TRADING_SETTINGS, followedCallerIds: [] });

    await createMessageProcessor(deps).process(envelopeFromFixture(BTO_QQQ_PUT));

    expect(await db.listDecisions(USER, 10)).toEqual([]);
    expect(tools.placeOptionsOrder).not.toHaveBeenCalled();
  });

  it('Following is per user: one user skips while the other trades', async () => {
    const { db, deps } = setup(BTO_QQQ_PUT.expectedCallout, {}, [USER, OTHER_USER]);
    db.seedSettings(OTHER_USER, { ...TRADING_SETTINGS, followedCallerIds: [] });

    await createMessageProcessor(deps).process(envelopeFromFixture(BTO_QQQ_PUT));

    expect((await db.listDecisions(USER, 10))[0]!.kind).toBe('submitted');
    expect(await db.listDecisions(OTHER_USER, 10)).toEqual([]);
  });

  it('ingest upserts the callers row: insert on first sight, update on the next', async () => {
    const { db, deps } = setup(BTO_QQQ_PUT.expectedCallout);
    const processor = createMessageProcessor(deps);
    const envelope = {
      ...envelopeFromFixture(BTO_QQQ_PUT),
      authorAvatarUrl: 'https://cdn.discordapp.com/avatars/test-author/a1.png',
    };

    await processor.process(envelope);
    expect(await db.listCallers()).toEqual([
      {
        authorId: 'test-author',
        displayName: 'Demon Alerts',
        avatarUrl: 'https://cdn.discordapp.com/avatars/test-author/a1.png',
        lastSeenAt: envelope.timestamp,
      },
    ]);

    await processor.process({
      ...envelope,
      messageId: 'fixture-bto-qqq-710p-later',
      authorName: 'Demon Renamed',
      authorAvatarUrl: 'https://cdn.discordapp.com/avatars/test-author/a2.png',
      timestamp: '2026-06-09T15:00:00.000Z',
    });
    expect(await db.listCallers()).toEqual([
      {
        authorId: 'test-author',
        displayName: 'Demon Renamed',
        avatarUrl: 'https://cdn.discordapp.com/avatars/test-author/a2.png',
        lastSeenAt: '2026-06-09T15:00:00.000Z',
      },
    ]);

    // Old-bot envelopes carry no avatar; that must not clobber the stored one.
    await processor.process({
      ...envelope,
      messageId: 'fixture-bto-qqq-710p-latest',
      authorAvatarUrl: null,
      timestamp: '2026-06-09T16:00:00.000Z',
    });
    expect((await db.listCallers())[0]!.avatarUrl).toBe(
      'https://cdn.discordapp.com/avatars/test-author/a2.png'
    );
  });
});

describe('fan-out — lifecycle stage events', () => {
  it('emits received → risk_check → executing → done for a submitted trade', async () => {
    const { deps, events } = setup(BTO_QQQ_PUT.expectedCallout);
    const stages: string[] = [];
    events.subscribe(USER, { onStage: (event) => stages.push(event.stage) });

    await createMessageProcessor(deps).process(envelopeFromFixture(BTO_QQQ_PUT));

    expect(stages).toEqual(['received', 'risk_check', 'executing', 'done']);
  });

  it('skips executing and still emits done for a risk rejection', async () => {
    const lowConf: Callout = { ...BTO_QQQ_PUT.expectedCallout, confidence: 0.3 };
    const { deps, events } = setup(lowConf);
    const stages: string[] = [];
    events.subscribe(USER, { onStage: (event) => stages.push(event.stage) });

    await createMessageProcessor(deps).process(envelopeFromFixture(BTO_QQQ_PUT));

    expect(stages).toEqual(['received', 'risk_check', 'done']);
  });
});

describe('fan-out — envelope contract', () => {
  // The producer-agnostic guarantee: an envelope carrying its callout only in
  // raw embed JSON (what a replacement forwarder may send) is flattened once
  // at the pipeline entry, so the parser and the stored feed row see the text.
  it('flattens an embed-only envelope before parsing and storing', async () => {
    const card = { title: 'Buy To Open', description: 'BTO $QQQ 710p 06/08 0.97' };
    const embedOnly: DiscordEnvelope = {
      messageId: 'embed-only-1',
      channelId: 'test-channel',
      guildId: 'test-guild',
      authorId: 'test-author',
      authorName: 'Demon Alerts',
      authorAvatarUrl: null,
      content: '',
      timestamp: '2026-06-09T14:27:00.000Z',
      embeds: [card],
    };
    const { db, deps } = setup(BTO_QQQ_PUT.expectedCallout);

    await createMessageProcessor(deps).process(embedOnly);

    const parsedEnvelope = (deps.parser.parse as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as DiscordEnvelope;
    expect(parsedEnvelope.content).toBe('Buy To Open\nBTO $QQQ 710p 06/08 0.97');

    // The verdict lands on the messages row; content stays raw there (the feed
    // flattens at read — covered by the fakeDb/listCallouts parity in
    // server.test.ts) and the parse is retained for the real callout.
    const stored = db.getMessage('embed-only-1');
    expect(stored?.disposition).toBe('callout');
    expect(stored?.parse).toMatchObject({ ticker: 'QQQ' });

    expect((await db.listDecisions(USER, 10))[0]!.kind).toBe('submitted');
  });
});

describe('fan-out — missed callouts', () => {
  it('records missed without touching the broker or the LLM', async () => {
    const { db, deps, tools } = setup(BTO_QQQ_PUT.expectedCallout);

    await createMessageProcessor(deps).process(envelopeFromFixture(BTO_QQQ_PUT), { missed: true });

    const [decision] = await db.listDecisions(USER, 10);
    expect(decision!.kind).toBe('missed');
    expect(decision!.reason).toMatch(/stale/);
    expect(deps.parser.parse).not.toHaveBeenCalled();
    expect(tools.placeOptionsOrder).not.toHaveBeenCalled();
    expect(db.getMessage(envelopeFromFixture(BTO_QQQ_PUT).messageId)?.disposition).toBe('missed');
  });
});

describe('Jev engine — decider through the fan-out, with a mocked Jev', () => {
  const AT = '2026-06-10T14:00:00.000Z';
  const CALLER = 'caller-a';

  const verdict = (choice: Action, probability: number, actingNow = 0.9): JevVerdict => ({
    model: 'jev-1.13.0',
    choice,
    probabilities: Object.fromEntries(
      ACTIONS.map((action) => [action, action === choice ? probability : (1 - probability) / 5])
    ) as Record<Action, number>,
    answerConfidence: probability,
    confidence: null,
    inputTokens: 600,
    actingNow,
  });

  const message = (content: string, extra: Partial<DiscordEnvelope> = {}): DiscordEnvelope => ({
    messageId: 'jev-msg-1',
    channelId: 'chan-001',
    guildId: null,
    authorId: CALLER,
    authorName: 'Bishop',
    authorAvatarUrl: null,
    content,
    timestamp: AT,
    ...extra,
  });

  /** setup() with the real decider in front of a Jev that answers `answer`. */
  function setupJev(
    answer: JevVerdict | Error,
    toolsOverrides: Partial<RobinhoodTools> = {},
    settings: TradeSettings = {}
  ): Setup {
    const base = setup(BTO_QQQ_PUT.expectedCallout, toolsOverrides);
    if (Object.keys(settings).length > 0) base.db.seedSettings(USER, { ...TRADING_SETTINGS, ...settings });
    const jev = {
      ask: answer instanceof Error ? vi.fn().mockRejectedValue(answer) : vi.fn().mockResolvedValue(answer),
    };
    return { ...base, deps: { ...base.deps, parser: new JevCalloutDecider(jev) } };
  }

  const holding = (strike: number, quantity: number, expiration = '2026-06-11') => ({
    getOptionPositions: vi.fn().mockResolvedValue({
      positions: [{ symbol: 'QQQ', optionType: 'call', strike, expiration, quantity, raw: {} }],
      raw: {},
    }),
  });

  const ENTRY = "I'm Entering\n**Option:** QQQ 707 C 6/11\n**Entry:** 0.97";

  it('trades a confident Buy at the template price, and parks a 0.6-0.8 one even in immediate mode', async () => {
    const confident = setupJev(verdict('BUY', 0.9));
    await createMessageProcessor(confident.deps).process(message(ENTRY));
    expect((await confident.db.listDecisions(USER, 10))[0]).toMatchObject({
      kind: 'submitted',
      order: { symbol: 'QQQ', side: 'buy', orderType: 'limit', limitPrice: 0.97 },
    });

    const unsure = setupJev(verdict('BUY', 0.75));
    await createMessageProcessor(unsure.deps).process(message(ENTRY));
    const [parked] = await unsure.db.listDecisions(USER, 10);
    expect(parked).toMatchObject({ kind: 'pending_approval' });
    expect(parked!.reason).toMatch(/^Jev BUY 0\.75 .* is below 0\.8\. Approval required: BUY/);
    expect(unsure.tools.placeOptionsOrder).not.toHaveBeenCalled();
  });

  it("uses Jev's cutoffs instead of the user's minConfidence", async () => {
    const { db, deps } = setupJev(verdict('BUY', 0.85), {}, { minConfidence: 0.9 });
    await createMessageProcessor(deps).process(message(ENTRY));
    expect((await db.listDecisions(USER, 10))[0]!.kind).toBe('submitted');
  });

  it('never trades an Average and writes no trade rows', async () => {
    const { db, deps, tools } = setupJev(verdict('AVERAGE', 1));
    await createMessageProcessor(deps).process(message('➕ AVERAGING DOWN — QQQ 707C · Jun 11\nAdded 10 @ $0.325'));
    expect(db.getMessage('jev-msg-1')?.disposition).toBe('not_callout');
    expect(await db.listDecisions(USER, 10)).toEqual([]);
    expect(tools.placeOptionsOrder).not.toHaveBeenCalled();
  });

  it("sells the caller's stated fraction of the held position, rounding down", async () => {
    const card = '✂️ TRIM +25% — QQQ 707C · Jun 11\nSold **4 of 20** @ **$0.906** · **16** still running.';
    const { db, deps, tools } = setupJev(verdict('TRIM', 0.95), holding(707, 12));
    await createMessageProcessor(deps).process(message(card));
    expect((await db.listDecisions(USER, 10))[0]!.kind).toBe('submitted');
    const call = (tools.placeOptionsOrder as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call).toMatchObject({ side: 'sell', strike: 707, contracts: 2 });
  });

  it("takes a contract-less exit's contract from the Caller's card it replies to", async () => {
    const { db, deps, tools } = setupJev(verdict('TRIM', 0.9), holding(707, 5));
    db.seedMessage({
      messageId: 'card-1',
      sentAt: '2026-06-10T13:00:00.000Z',
      authorId: CALLER,
      disposition: 'callout',
      parse: { ...BTO_QQQ_PUT.expectedCallout, ticker: 'QQQ', option: { optionType: 'call', strike: 707, expiration: '2026-06-11' } },
      processedAt: '2026-06-10T13:00:00.000Z',
    });
    await createMessageProcessor(deps).process(message('Trimming here', { replyToMessageId: 'card-1' }));
    const call = (tools.placeOptionsOrder as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call).toMatchObject({ side: 'sell', strike: 707, contracts: 2 });
  });

  it('ignores a card from another Caller, and skips quietly when nothing matches', async () => {
    const { db, deps, tools } = setupJev(verdict('SELL', 0.95), holding(707, 5));
    db.seedMessage({
      messageId: 'card-b',
      sentAt: '2026-06-10T13:00:00.000Z',
      authorId: 'caller-b',
      disposition: 'callout',
      parse: { ...BTO_QQQ_PUT.expectedCallout, ticker: 'QQQ', option: { optionType: 'call', strike: 707, expiration: '2026-06-11' } },
      processedAt: '2026-06-10T13:00:00.000Z',
    });
    await createMessageProcessor(deps).process(message('Out of QQQ', { replyToMessageId: 'card-b' }));
    expect(db.getMessage('jev-msg-1')?.disposition).toBe('not_callout');
    expect(await db.listDecisions(USER, 10)).toEqual([]);
    expect(tools.placeOptionsOrder).not.toHaveBeenCalled();
  });

  it("sends an exit to approval when the Caller has several live entries in the ticker", async () => {
    const { db, deps, tools } = setupJev(verdict('SELL', 0.95), holding(710, 3));
    const entryAt = (strike: number, sentAt: string) =>
      db.seedMessage({
        messageId: `entry-${strike}`,
        sentAt,
        authorId: CALLER,
        disposition: 'callout',
        parse: {
          ...BTO_QQQ_PUT.expectedCallout,
          ticker: 'QQQ',
          option: { optionType: 'call', strike, expiration: '2026-06-11' },
          engine: 'jev',
        },
        processedAt: sentAt,
      });
    entryAt(707, '2026-06-10T13:00:00.000Z');
    entryAt(710, '2026-06-10T13:30:00.000Z');

    await createMessageProcessor(deps).process(message('Out of QQQ'));

    const [decision] = await db.listDecisions(USER, 10);
    expect(decision).toMatchObject({ kind: 'pending_approval', order: { option: { strike: 710 }, quantity: 3 } });
    expect(decision!.reason).toMatch(/Bishop has 2 open QQQ entries; picked the newest, 710C 2026-06-11/);
    expect(tools.placeOptionsOrder).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: 'all' } as const, 5, 5],
    [{ kind: 'all_but_one' } as const, 5, 4],
    [{ kind: 'all_but_one' } as const, 1, 0],
    [{ kind: 'fraction', value: 0.5 } as const, 1, 0],
    [{ kind: 'fraction', value: 1 / 3 } as const, 3, 1],
    [{ kind: 'fraction', value: 0.2 } as const, 12, 2],
  ])('sizes %j of %i held contracts as %i, rounding down', (portion, held, sold) => {
    expect(contractsForPortion(portion, held)).toBe(sold);
  });

  it('records failed and a parse_failed row per user when Jev does not answer', async () => {
    const { db, deps, tools } = setupJev(new JevError('no answer within 1500 ms', 'timeout'));
    await createMessageProcessor(deps).process(message(ENTRY));
    expect(db.getMessage('jev-msg-1')?.disposition).toBe('failed');
    expect((await db.listDecisions(USER, 10))[0]).toMatchObject({ kind: 'parser_error', code: 'parse_failed' });
    expect(tools.placeOptionsOrder).not.toHaveBeenCalled();
  });
});

