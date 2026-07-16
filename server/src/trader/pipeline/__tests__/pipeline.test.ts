/**
 * Pipeline integration tests — end-to-end from DiscordEnvelope to Decision,
 * with mocked parser, Robinhood tools, decision log, and receipt poster.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runPipeline } from '../index.js';
import type {
  Callout,
  CalloutParser,
  Decision,
  DiscordEnvelope,
  PostReceipt,
} from '../../../shared/types.js';
import type { RobinhoodTools } from '../../rh/tools.js';
import { DecisionLog } from '../../decisionLog.js';
import { BTO_QQQ_PUT, TRIM_QQQ_DOUBLE, TRIM_QQQ_FIRST, RUNNERS_ONLY_QQQ, HYPE_BANG, envelopeFromFixture } from './fixtures/discordMessages.js';

// ---------------------------------------------------------------------------
// Config mock — pipeline reads maxSingleContractPct / maxOptionsNotionalPct
// ---------------------------------------------------------------------------

vi.mock('../../../shared/config.js', () => ({
  config: {
    minConfidence: 0.7,
    blockedTickers: [],
    allowedTickers: [],
    regularHoursOnly: false,
    maxTradesPerDay: 10,
    cooldownSecondsPerTicker: 0,
    maxNotionalPctPerTrade: 5,
    maxOptionsNotionalPct: 10,
    maxSingleContractPct: 10,
    positionSmallPct: 25,
    positionMediumPct: 50,
    riskStatePath: '/tmp/test-pipeline-risk.json',
    tradeExecutionMode: 'immediate',
  },
  isAllowed: () => true,
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  appendFile: vi.fn().mockResolvedValue(undefined),
}));

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
    getPositions: vi.fn().mockResolvedValue([]),
    getOptionPositions: vi.fn().mockResolvedValue({
      positions: [
        {
          symbol: 'QQQ',
          optionType: 'call',
          strike: 707,
          expiration: '2026-06-11',
          quantity: 5,
          raw: {},
        },
      ],
      raw: {},
    }),
    ...overrides,
  } as unknown as RobinhoodTools;
}

function makeParser(callout: Callout | Error): CalloutParser {
  return {
    parse: callout instanceof Error
      ? vi.fn().mockRejectedValue(callout)
      : vi.fn().mockResolvedValue(callout),
  };
}

async function runWith(
  envelope: DiscordEnvelope,
  callout: Callout | Error,
  toolsOverrides: Partial<RobinhoodTools> = {}
): Promise<{ decision: Decision; postReceipt: PostReceipt; tools: RobinhoodTools }> {
  const parser = makeParser(callout);
  const tools = makeTools(toolsOverrides);
  const decisions = new DecisionLog('/tmp/test-decisions.jsonl');
  const postReceipt = vi.fn().mockResolvedValue(undefined);

  const decision = await runPipeline(envelope, { parser, tools, decisions, postReceipt });

  return { decision, postReceipt, tools };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runPipeline — non-callouts', () => {
  it('returns not_callout for hype messages (BANG!)', async () => {
    const { decision, postReceipt } = await runWith(
      envelopeFromFixture(HYPE_BANG),
      HYPE_BANG.expectedCallout
    );

    expect(decision.kind).toBe('not_callout');
    expect(decision.order).toBeNull();
    expect(postReceipt).not.toHaveBeenCalled();
  });
});

describe('runPipeline — BTO entry', () => {
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
});

describe('runPipeline — TRIM exit', () => {
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
    expect(tools.placeOptionsOrder).toHaveBeenCalledOnce();
    const call = (tools.placeOptionsOrder as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.side).toBe('sell');
    expect(call.strike).toBe(707);
    expect(call.optionType).toBe('call');
    expect(call.contracts).toBe(1);
    expect(tools.getBuyingPower).not.toHaveBeenCalled();
    expect(tools.getOptionPositions).toHaveBeenCalledOnce();
  });

  it('sells most and leaves one contract for TRIM TRIM / heavy exits', async () => {
    const { decision, tools } = await runWith(
      envelopeFromFixture(TRIM_QQQ_DOUBLE),
      TRIM_QQQ_DOUBLE.expectedCallout
    );

    expect(decision.kind).toBe('submitted');
    expect(decision.order?.quantity).toBe(4);
    const call = (tools.placeOptionsOrder as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.contracts).toBe(4);
  });

  it('caps heavy exits to one contract when only one is held', async () => {
    const { decision, tools } = await runWith(
      envelopeFromFixture(RUNNERS_ONLY_QQQ),
      RUNNERS_ONLY_QQQ.expectedCallout,
      {
        getOptionPositions: vi.fn().mockResolvedValue({
          positions: [
            {
              symbol: 'QQQ',
              optionType: 'call',
              strike: 707,
              expiration: '2026-06-11',
              quantity: 1,
              raw: {},
            },
          ],
          raw: {},
        }),
      }
    );

    expect(decision.kind).toBe('submitted');
    expect(decision.order?.quantity).toBe(1);
    const call = (tools.placeOptionsOrder as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.contracts).toBe(1);
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

describe('runPipeline — approval mode', () => {
  it('records pending_approval and does not submit when approval mode is enabled', async () => {
    const { config } = await import('../../../shared/config.js');
    const original = config.tradeExecutionMode;
    (config as { tradeExecutionMode: 'immediate' | 'approval' }).tradeExecutionMode = 'approval';

    try {
      const { decision, tools, postReceipt } = await runWith(
        envelopeFromFixture(BTO_QQQ_PUT),
        BTO_QQQ_PUT.expectedCallout
      );

      expect(decision.kind).toBe('pending_approval');
      expect(decision.reason).toMatch(/Approval required/);
      expect(decision.order).toBeNull();
      expect(tools.placeOptionsOrder).not.toHaveBeenCalled();
      expect(tools.getBuyingPower).not.toHaveBeenCalled();
      expect(postReceipt).toHaveBeenCalledOnce();
    } finally {
      (config as { tradeExecutionMode: 'immediate' | 'approval' }).tradeExecutionMode = original;
    }
  });
});

describe('runPipeline — error paths', () => {
  it('returns parser_error when LLM throws', async () => {
    const { decision } = await runWith(
      envelopeFromFixture(BTO_QQQ_PUT),
      new Error('LLM rate limited')
    );

    expect(decision.kind).toBe('parser_error');
    expect(decision.callout).toBeNull();
  });

  it('returns risk_rejected for low-confidence callout', async () => {
    const lowConf: Callout = { ...BTO_QQQ_PUT.expectedCallout, confidence: 0.3 };
    const { decision, tools } = await runWith(envelopeFromFixture(BTO_QQQ_PUT), lowConf);

    expect(decision.kind).toBe('risk_rejected');
    expect(tools.placeOptionsOrder).not.toHaveBeenCalled();
  });

  it('returns risk_rejected when buying power is zero', async () => {
    const { decision } = await runWith(
      envelopeFromFixture(BTO_QQQ_PUT),
      BTO_QQQ_PUT.expectedCallout,
      { getBuyingPower: vi.fn().mockResolvedValue({ amountUsd: 0 }) }
    );

    expect(decision.kind).toBe('risk_rejected');
    expect(decision.reason).toMatch(/zero/i);
  });

  it('returns execution_failed when placeOptionsOrder throws', async () => {
    const { decision, postReceipt } = await runWith(
      envelopeFromFixture(BTO_QQQ_PUT),
      BTO_QQQ_PUT.expectedCallout,
      { placeOptionsOrder: vi.fn().mockRejectedValue(new Error('broker rejected')) }
    );

    expect(decision.kind).toBe('execution_failed');
    expect(postReceipt).toHaveBeenCalledOnce();
  });

  it('returns risk_rejected when single contract exceeds maxSingleContractPct', async () => {
    const expensiveCallout: Callout = {
      ...BTO_QQQ_PUT.expectedCallout,
      limitPrice: 50, // $5000 per contract on $10k account = 50%
    };

    const { decision } = await runWith(
      envelopeFromFixture(BTO_QQQ_PUT),
      expensiveCallout
    );

    expect(decision.kind).toBe('risk_rejected');
    expect(decision.reason).toMatch(/MAX_SINGLE_CONTRACT_PCT/);
  });
});

describe('runPipeline — decision log', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('appends every decision to the log', async () => {
    const parser = makeParser(HYPE_BANG.expectedCallout);
    const tools = makeTools();
    const decisions = new DecisionLog('/tmp/test-decisions.jsonl');
    const appendSpy = vi.spyOn(decisions, 'append');
    const postReceipt = vi.fn().mockResolvedValue(undefined);

    await runPipeline(envelopeFromFixture(HYPE_BANG), { parser, tools, decisions, postReceipt });

    expect(appendSpy).toHaveBeenCalledOnce();
    expect(appendSpy.mock.calls[0]![0].kind).toBe('not_callout');
  });
});
