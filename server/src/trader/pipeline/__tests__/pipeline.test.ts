/**
 * Pipeline integration tests — from DiscordEnvelope to per-user Decision rows,
 * with a mocked parser, stubbed Robinhood tools and the in-memory db.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../shared/config.js', () => ({
  config: { tradeExecutionMode: 'immediate' },
  isAllowed: (v: string, allowlist: readonly string[]): boolean =>
    allowlist.length === 0 || allowlist.includes(v),
}));

import type {
  Callout,
  CalloutParser,
  Decision,
  DiscordEnvelope,
  PostReceipt,
} from '../../../shared/types.js';
import { createFakeDb, fakeTokens, type FakeDb } from '../../__tests__/fakeDb.js';
import { TraderEvents } from '../../events.js';
import type { McpRegistry, UserBroker } from '../../rh/mcpRegistry.js';
import type { RobinhoodMcpClient } from '../../rh/mcpClient.js';
import type { RobinhoodTools } from '../../rh/tools.js';
import { createMessageProcessor, type PipelineDeps } from '../index.js';
import {
  BTO_QQQ_PUT,
  TRIM_QQQ_DOUBLE,
  TRIM_QQQ_FIRST,
  RUNNERS_ONLY_QQQ,
  HYPE_BANG,
  envelopeFromFixture,
} from './fixtures/discordMessages.js';

const USER = 'user-1';
const OTHER_USER = 'user-2';

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
  readonly postReceipt: PostReceipt;
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
    db.seedSettings(userId, { regularHoursOnly: false, cooldownSeconds: 0, maxOptionsNotionalPct: 10, maxSingleContractPct: 10 });
    toolsByUser.set(userId, makeTools(toolsOverrides));
  }

  const events = new TraderEvents();
  const postReceipt = vi.fn().mockResolvedValue(undefined);
  const deps: PipelineDeps = {
    parser: makeParser(callout),
    db,
    events,
    brokers: makeRegistry(toolsByUser),
    postReceipt,
  };
  return { db, deps, postReceipt, tools: toolsByUser.get(users[0]!)!, events };
}

/** Run one message through the fan-out and return the first user's outcome. */
async function runWith(
  envelope: DiscordEnvelope,
  callout: Callout | Error,
  toolsOverrides: Partial<RobinhoodTools> = {}
): Promise<{ decision: Decision; postReceipt: PostReceipt; tools: RobinhoodTools; db: FakeDb }> {
  const { db, deps, postReceipt, tools } = setup(callout, toolsOverrides);
  await createMessageProcessor(deps).process(envelope);
  const decisions = await db.listDecisions(USER, 10);
  return { decision: decisions[0]!, postReceipt, tools, db };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fan-out — non-callouts', () => {
  it('records channel chatter on the shared row only, with no per-user work', async () => {
    const { db, deps, postReceipt } = setup(HYPE_BANG.expectedCallout, {}, [USER, OTHER_USER]);

    await createMessageProcessor(deps).process(envelopeFromFixture(HYPE_BANG));

    const stored = await db.getCallout(envelopeFromFixture(HYPE_BANG).messageId);
    expect(stored?.parseStatus).toBe('not_callout');
    // The callouts table constraint keeps `parse` for real callouts only, and
    // nothing downstream reads a non-callout parse.
    expect(stored?.parse).toBeNull();

    // No trade rows and no Discord noise for a message nobody can act on.
    expect(await db.listDecisions(USER, 10)).toEqual([]);
    expect(await db.listDecisions(OTHER_USER, 10)).toEqual([]);
    expect(postReceipt).not.toHaveBeenCalled();
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
    const { decision, tools, postReceipt } = await runWith(
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
    expect(postReceipt).toHaveBeenCalledOnce();
  });

  it('caches the parse on the callouts row', async () => {
    const { db } = await runWith(envelopeFromFixture(BTO_QQQ_PUT), BTO_QQQ_PUT.expectedCallout);
    const stored = await db.getCallout(envelopeFromFixture(BTO_QQQ_PUT).messageId);
    expect(stored?.parseStatus).toBe('parsed');
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

describe('fan-out — parse consistency guardrails', () => {
  // Real incident (2026-07-15): profit brag parsed by the LLM as an equity
  // buy with the current option premium as the limit price.
  const INCIDENT_ENVELOPE: DiscordEnvelope = {
    messageId: 'incident-aapl-brag',
    channelId: 'test-channel',
    guildId: 'test-guild',
    authorId: 'test-author',
    authorName: 'Natalie Options Alert',
    content: '**130%** 🔥aapl calls 3.38 to 7.70 now!!! 🚀',
    timestamp: '2026-07-15T15:36:00.000Z',
  };

  const BAD_EQUITY_PARSE: Callout = {
    isCallout: true,
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
    const { decision, tools, postReceipt } = await runWith(INCIDENT_ENVELOPE, BAD_EQUITY_PARSE);

    expect(decision.kind).toBe('risk_rejected');
    expect(decision.code).toBe('parse_inconsistent');
    expect(decision.order).toBeNull();
    expect(tools.placeOrder).not.toHaveBeenCalled();
    expect(postReceipt).toHaveBeenCalledOnce();
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
    const { db, deps, postReceipt } = setup(BTO_QQQ_PUT.expectedCallout);
    db.seedSettings(USER, { executionMode: 'approval', regularHoursOnly: false });

    await createMessageProcessor(deps).process(envelopeFromFixture(BTO_QQQ_PUT));

    const [decision] = await db.listDecisions(USER, 10);
    expect(decision!.kind).toBe('pending_approval');
    expect(decision!.order).toBeNull();
    expect(postReceipt).toHaveBeenCalledOnce();
  });

  it("ignores a user's 'immediate' setting when the trader booted in approval mode", async () => {
    const { config } = await import('../../../shared/config.js');
    const original = config.tradeExecutionMode;
    (config as { tradeExecutionMode: 'immediate' | 'approval' }).tradeExecutionMode = 'approval';

    try {
      const { decision, tools } = await runWith(
        envelopeFromFixture(BTO_QQQ_PUT),
        BTO_QQQ_PUT.expectedCallout
      );
      expect(decision.kind).toBe('pending_approval');
      expect(tools.placeOptionsOrder).not.toHaveBeenCalled();
    } finally {
      (config as { tradeExecutionMode: 'immediate' | 'approval' }).tradeExecutionMode = original;
    }
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
    expect((await db.getCallout(envelopeFromFixture(BTO_QQQ_PUT).messageId))?.parseStatus).toBe('failed');
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
    db.seedSettings(OTHER_USER, { blockedTickers: ['QQQ'], regularHoursOnly: false });

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
      db.seedSettings(userId, { regularHoursOnly: false, maxOptionsNotionalPct: 10, maxSingleContractPct: 10 });
    }

    await createMessageProcessor({
      parser: makeParser(BTO_QQQ_PUT.expectedCallout),
      db,
      events: new TraderEvents(),
      brokers: makeRegistry(toolsByUser),
      postReceipt: vi.fn().mockResolvedValue(undefined),
    }).process(envelopeFromFixture(BTO_QQQ_PUT));

    expect((await db.listDecisions(USER, 10))[0]!.kind).toBe('execution_failed');
    expect((await db.listDecisions(OTHER_USER, 10))[0]!.kind).toBe('submitted');
    expect(toolsByUser.get(OTHER_USER)!.placeOptionsOrder).toHaveBeenCalledOnce();
  });

  it('posts a single aggregate receipt rather than one per account', async () => {
    const { deps, postReceipt } = setup(BTO_QQQ_PUT.expectedCallout, {}, [USER, OTHER_USER]);

    await createMessageProcessor(deps).process(envelopeFromFixture(BTO_QQQ_PUT));

    expect(postReceipt).toHaveBeenCalledOnce();
    const [, text] = (postReceipt as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(text).toContain('2 submitted');
    expect(text).toContain('2 accounts');
    // No per-account detail: the source channel is shared.
    expect(text).not.toContain(USER);
    expect(text).not.toContain(OTHER_USER);
  });

  it('reuses the cached parse on a second delivery of the same message', async () => {
    const { db, deps } = setup(BTO_QQQ_PUT.expectedCallout);
    const processor = createMessageProcessor(deps);

    await processor.process(envelopeFromFixture(BTO_QQQ_PUT));
    await processor.process(envelopeFromFixture(BTO_QQQ_PUT));

    expect(deps.parser.parse).toHaveBeenCalledOnce();
    expect(await db.listDecisions(USER, 10)).toHaveLength(2);
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

describe('fan-out — missed callouts', () => {
  it('records missed without touching the broker or the LLM', async () => {
    const { db, deps, tools } = setup(BTO_QQQ_PUT.expectedCallout);

    await createMessageProcessor(deps).process(envelopeFromFixture(BTO_QQQ_PUT), { missed: true });

    const [decision] = await db.listDecisions(USER, 10);
    expect(decision!.kind).toBe('missed');
    expect(decision!.reason).toMatch(/stale/);
    expect(deps.parser.parse).not.toHaveBeenCalled();
    expect(tools.placeOptionsOrder).not.toHaveBeenCalled();
    expect((await db.getCallout(envelopeFromFixture(BTO_QQQ_PUT).messageId))?.parseStatus).toBe('skipped');
  });
});

