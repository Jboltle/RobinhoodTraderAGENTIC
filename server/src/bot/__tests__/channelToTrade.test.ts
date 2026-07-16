/**
 * Allow-listed channel -> trade execution integration test.
 *
 * Wires the two halves of the system together in-process:
 *   bot: classifyMessage (channel allow-list) -> buildEnvelope
 *   trader: runPipeline -> mocked Robinhood order + receipt
 *
 * Proves a message from an allow-listed channel drives an order and a receipt
 * back to the source channel, and that a message from a non-listed channel
 * never reaches the pipeline.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Message } from 'discord.js';

import type {
  Callout,
  CalloutParser,
  Decision,
  PostReceipt,
} from '../../shared/types.js';
import type { RobinhoodTools } from '../../trader/rh/tools.js';
import { buildEnvelope } from '../messageAssembly.js';
import { classifyMessage, type MessageFilterConfig } from '../messageFilter.js';
import { BTO_QQQ_PUT } from '../../trader/pipeline/__tests__/fixtures/discordMessages.js';

// ---------------------------------------------------------------------------
// Config + fs mocks (pipeline reads config sizing + persists risk/decision state)
// isAllowed keeps its real semantics so channel/author gating is exercised.
// ---------------------------------------------------------------------------

vi.mock('../../shared/config.js', () => ({
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
    riskStatePath: '/tmp/test-channel-to-trade-risk.json',
    tradeExecutionMode: 'immediate',
  },
  isAllowed: (v: string, allowlist: readonly string[]): boolean =>
    allowlist.length === 0 || allowlist.includes(v),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  appendFile: vi.fn().mockResolvedValue(undefined),
}));

const { runPipeline } = await import('../../trader/pipeline/index.js');
const { DecisionLog } = await import('../../trader/decisionLog.js');

// ---------------------------------------------------------------------------
// Fixtures / mocks
// ---------------------------------------------------------------------------

const ALLOWED_CHANNEL_ID = '1490028729521410189';
const UNLISTED_CHANNEL_ID = '000000000000000000';

const FILTER_CFG: MessageFilterConfig = {
  discordAllowedChannelIds: [ALLOWED_CHANNEL_ID],
  discordAllowedAuthorIds: [],
};

function mockMessage(channelId: string): Message {
  return {
    id: 'discord-msg-777',
    channelId,
    guildId: 'guild-001',
    createdTimestamp: Date.parse('2026-06-09T14:27:00.000Z'),
    system: false,
    webhookId: null,
    author: { id: 'author-001', username: 'Demon Alerts', bot: false },
    member: { displayName: 'Demon Alerts' },
    channel: { parentId: null },
  } as unknown as Message;
}

function makeTools(overrides: Partial<RobinhoodTools> = {}): RobinhoodTools {
  return {
    getBuyingPower: vi.fn().mockResolvedValue({ amountUsd: 10_000 }),
    getQuote: vi.fn().mockResolvedValue({ price: 150 }),
    getOptionsMarkPrice: vi.fn().mockResolvedValue({ markPrice: 0.97 }),
    placeOrder: vi.fn().mockResolvedValue({ orderId: 'eq-001', status: 'queued' }),
    placeOptionsOrder: vi.fn().mockResolvedValue({ orderId: 'opt-001', status: 'queued' }),
    getPositions: vi.fn().mockResolvedValue([]),
    getOptionPositions: vi.fn().mockResolvedValue({ positions: [], raw: {} }),
    ...overrides,
  } as unknown as RobinhoodTools;
}

function makeParser(callout: Callout): CalloutParser {
  return { parse: vi.fn().mockResolvedValue(callout) };
}

/**
 * Emulates the bot handler: only messages that pass the channel/author filter
 * are turned into envelopes and handed to the trader pipeline.
 */
async function simulateChannelToTrade(
  message: Message,
  content: string
): Promise<{ forwarded: boolean; decision: Decision | null; tools: RobinhoodTools; postReceipt: PostReceipt }> {
  const tools = makeTools();
  const postReceipt = vi.fn().mockResolvedValue(undefined);

  const classification = classifyMessage(message, FILTER_CFG);
  if (!classification.forward) {
    return { forwarded: false, decision: null, tools, postReceipt };
  }

  const envelope = buildEnvelope(message, content);
  const parser = makeParser(BTO_QQQ_PUT.expectedCallout);
  const decisions = new DecisionLog('/tmp/test-channel-to-trade-decisions.jsonl');

  const decision = await runPipeline(envelope, { parser, tools, decisions, postReceipt });
  return { forwarded: true, decision, tools, postReceipt };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('allow-listed channel drives a trade', () => {
  it('forwards a callout from an allow-listed channel and submits an order', async () => {
    const message = mockMessage(ALLOWED_CHANNEL_ID);
    const { forwarded, decision, tools } = await simulateChannelToTrade(message, BTO_QQQ_PUT.content);

    expect(forwarded).toBe(true);
    expect(decision?.kind).toBe('submitted');
    expect(tools.placeOptionsOrder).toHaveBeenCalledOnce();
  });

  it('posts the receipt back to the original allow-listed channel id', async () => {
    const message = mockMessage(ALLOWED_CHANNEL_ID);
    const { decision, postReceipt } = await simulateChannelToTrade(message, BTO_QQQ_PUT.content);

    expect(postReceipt).toHaveBeenCalledOnce();
    const [receiptChannelId] = (postReceipt as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(receiptChannelId).toBe(ALLOWED_CHANNEL_ID);
    expect(decision?.envelope.channelId).toBe(ALLOWED_CHANNEL_ID);
  });
});

describe('non-listed channel never trades', () => {
  it('does not forward or place an order for a message in an unlisted channel', async () => {
    const message = mockMessage(UNLISTED_CHANNEL_ID);
    const { forwarded, decision, tools, postReceipt } = await simulateChannelToTrade(
      message,
      BTO_QQQ_PUT.content
    );

    expect(classifyMessage(message, FILTER_CFG)).toEqual({
      forward: false,
      reason: 'channel_not_allowed',
    });
    expect(forwarded).toBe(false);
    expect(decision).toBeNull();
    expect(tools.placeOptionsOrder).not.toHaveBeenCalled();
    expect(tools.placeOrder).not.toHaveBeenCalled();
    expect(postReceipt).not.toHaveBeenCalled();
  });
});
