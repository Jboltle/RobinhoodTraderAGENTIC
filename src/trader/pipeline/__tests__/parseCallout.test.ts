/**
 * parseCallout tests — no live LLM calls.
 *
 * The LlmProvider is mocked so each test controls exactly what the model
 * "returns". This lets us verify:
 *   1. Schema parsing + normalisation (ticker uppercased, Zod validation).
 *   2. What a correctly-behaving LLM should extract from real Discord messages.
 *
 * The second group (labelled "expected LLM output") serves as living
 * documentation: these are the structured objects the system prompt is designed
 * to produce for each message shape seen in the wild.
 */

import { describe, expect, it, vi } from 'vitest';
import { LlmCalloutParser } from '../parseCallout.js';
import type { Callout, DiscordEnvelope, LlmProvider } from '../../../shared/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEnvelope(content: string, timestamp = '2026-06-15T14:35:00.000Z'): DiscordEnvelope {
  return {
    messageId: 'test-msg-id',
    channelId: 'test-channel',
    guildId: 'test-guild',
    authorId: 'test-author',
    authorName: 'Namrood',
    content,
    timestamp,
  };
}

/**
 * Build a parser backed by a mock LLM that returns `response` exactly once.
 * The mock ignores the prompt and returns whatever we tell it to.
 */
function parserWithMock(response: Record<string, unknown>): LlmCalloutParser {
  const mockProvider: LlmProvider = {
    callStructured: vi.fn().mockResolvedValue(response),
  };
  return new LlmCalloutParser(mockProvider);
}

// ---------------------------------------------------------------------------
// 1. Schema normalisation — verify the parser correctly processes LLM output
// ---------------------------------------------------------------------------

describe('parseCallout — schema normalisation', () => {
  it('uppercases ticker from LLM response', async () => {
    const parser = parserWithMock({
      isCallout: true,
      assetType: 'option',
      action: 'buy',
      ticker: 'spy',            // lowercase — parser should normalise
      orderType: 'limit',
      limitPrice: 0.71,
      sizeHint: null,
      positionSize: null,
      option: { optionType: 'call', strike: 755, expiration: '2026-06-15' },
      confidence: 0.95,
      rationale: 'BTO SPY 755C 0DTE $0.71',
    });

    const result = await parser.parse(makeEnvelope('Buy To Open\nSPY 755C 0DTE $0.71'));
    expect(result.ticker).toBe('SPY');
  });

  it('passes through isCallout=false without throwing', async () => {
    const parser = parserWithMock({
      isCallout: false,
      assetType: 'equity',
      action: null,
      ticker: null,
      orderType: 'market',
      limitPrice: null,
      sizeHint: null,
      positionSize: null,
      option: null,
      confidence: 0.1,
      rationale: 'commentary, not a trade',
    });

    const result = await parser.parse(makeEnvelope('Still in $SBUX!'));
    expect(result.isCallout).toBe(false);
  });

  it('throws on invalid schema (bad expiration format)', async () => {
    const parser = parserWithMock({
      isCallout: true,
      assetType: 'option',
      action: 'buy',
      ticker: 'SPY',
      orderType: 'market',
      limitPrice: null,
      sizeHint: null,
      positionSize: null,
      option: { optionType: 'call', strike: 755, expiration: '06/15/2026' }, // wrong format
      confidence: 0.9,
      rationale: 'bad date format from LLM',
    });

    await expect(parser.parse(makeEnvelope('SPY 755C'))).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. Expected LLM output for real Discord message shapes
//
//    Each test describes what the LLM *should* return for a given message.
//    Mock returns exactly that object — we verify schema acceptance and the
//    key fields that drive downstream execution.
// ---------------------------------------------------------------------------

describe('parseCallout — BTO / entry signals', () => {
  it('BTO SPY 755C 0DTE $0.71 → buy call limit 0.71, today expiry', async () => {
    const parser = parserWithMock({
      isCallout: true,
      assetType: 'option',
      action: 'buy',
      ticker: 'SPY',
      orderType: 'limit',
      limitPrice: 0.71,
      sizeHint: null,
      positionSize: null,
      option: { optionType: 'call', strike: 755, expiration: '2026-06-15' },
      confidence: 0.97,
      rationale: 'Buy To Open SPY 755C 0DTE at $0.71 limit',
    });

    const result = await parser.parse(makeEnvelope(
      'Buy To Open\nSPY 755C 0DTE $0.71\n\n@Namrood - LIVE DASHBOARD'
    ));

    expect(result).toMatchObject<Partial<Callout>>({
      isCallout: true,
      assetType: 'option',
      action: 'buy',
      ticker: 'SPY',
      orderType: 'limit',
      limitPrice: 0.71,
      option: { optionType: 'call', strike: 755, expiration: '2026-06-15' },
    });
  });

  it('BTO $SBUX 103c 06/12 @0.55 → buy call limit 0.55', async () => {
    const parser = parserWithMock({
      isCallout: true,
      assetType: 'option',
      action: 'buy',
      ticker: 'SBUX',
      orderType: 'limit',
      limitPrice: 0.55,
      sizeHint: null,
      positionSize: null,
      option: { optionType: 'call', strike: 103, expiration: '2026-06-12' },
      confidence: 0.96,
      rationale: 'BTO SBUX 103 call expiring 06/12 at $0.55 limit',
    });

    const result = await parser.parse(makeEnvelope('BTO $SBUX 103c 06/12 @0.55'));

    expect(result).toMatchObject<Partial<Callout>>({
      isCallout: true,
      assetType: 'option',
      action: 'buy',
      ticker: 'SBUX',
      orderType: 'limit',
      limitPrice: 0.55,
      option: { optionType: 'call', strike: 103, expiration: '2026-06-12' },
    });
  });

  it('BTO $QQQ 710p 06/08 0.97 → buy put limit 0.97', async () => {
    const parser = parserWithMock({
      isCallout: true,
      assetType: 'option',
      action: 'buy',
      ticker: 'QQQ',
      orderType: 'limit',
      limitPrice: 0.97,
      sizeHint: null,
      positionSize: null,
      option: { optionType: 'put', strike: 710, expiration: '2026-06-08' },
      confidence: 0.96,
      rationale: 'BTO QQQ 710 put 06/08 at $0.97',
    });

    const result = await parser.parse(makeEnvelope('BTO $QQQ 710p 06/08 0.97\n\nRISKY SIZE APPROPRIATE'));

    expect(result).toMatchObject<Partial<Callout>>({
      isCallout: true,
      action: 'buy',
      ticker: 'QQQ',
      option: { optionType: 'put', strike: 710, expiration: '2026-06-08' },
      limitPrice: 0.97,
    });
  });
});

describe('parseCallout — Lotto / risky trades (positionSize)', () => {
  it('⚠️ Lotto Trade SPY 745C 0DTE $1.7 → positionSize small', async () => {
    const parser = parserWithMock({
      isCallout: true,
      assetType: 'option',
      action: 'buy',
      ticker: 'SPY',
      orderType: 'limit',
      limitPrice: 1.7,
      sizeHint: null,
      positionSize: 'small',   // "1% of your account" / "risky" → small
      option: { optionType: 'call', strike: 745, expiration: '2026-06-15' },
      confidence: 0.88,
      rationale: 'Lotto/risky flag and sizing-warning map to small position size',
    });

    const result = await parser.parse(makeEnvelope(
      '⚠️ Lotto Trade — RISKY\nSPY 745C 0DTE $1.7\n\n⚠️ Size for what you can afford to lose --- 1% of your account balance.'
    ));

    expect(result.isCallout).toBe(true);
    expect(result.positionSize).toBe('small');
    expect(result.option?.strike).toBe(745);
    expect(result.limitPrice).toBe(1.7);
  });

  it('RISKY SIZE APPROPRIATE tag on QQQ put → positionSize small', async () => {
    const parser = parserWithMock({
      isCallout: true,
      assetType: 'option',
      action: 'buy',
      ticker: 'QQQ',
      orderType: 'limit',
      limitPrice: 0.97,
      sizeHint: null,
      positionSize: 'small',
      option: { optionType: 'put', strike: 710, expiration: '2026-06-08' },
      confidence: 0.91,
      rationale: 'RISKY SIZE APPROPRIATE maps to small',
    });

    const result = await parser.parse(makeEnvelope(
      'BTO $QQQ 710p 06/08 0.97\n\nRISKY SIZE APPROPRIATE @Pro'
    ));

    expect(result.positionSize).toBe('small');
  });
});

describe('parseCallout — exit / management signals', () => {
  it('Close or Trim & Set SL to BE → sell / action=sell', async () => {
    const parser = parserWithMock({
      isCallout: true,
      assetType: 'option',
      action: 'sell',
      ticker: 'SPY',
      orderType: 'market',
      limitPrice: null,
      sizeHint: null,
      positionSize: null,
      option: { optionType: 'call', strike: 755, expiration: '2026-06-15' },
      confidence: 0.85,
      rationale: 'Close or Trim directive on SPY 755C — sell / manage position',
    });

    const result = await parser.parse(makeEnvelope(
      'Close or Trim & Set SL to BE\nSPY 755C 2026-06-15\n0.7100  →  0.9   P/L: +26.76% ($19.00)'
    ));

    expect(result.isCallout).toBe(true);
    expect(result.action).toBe('sell');
    expect(result.ticker).toBe('SPY');
    expect(result.option?.strike).toBe(755);
  });

  it('"Trimming most" → sell, medium/full size', async () => {
    const parser = parserWithMock({
      isCallout: true,
      assetType: 'option',
      action: 'sell',
      ticker: 'GOOGL',
      orderType: 'market',
      limitPrice: null,
      sizeHint: null,
      positionSize: 'full',   // "trimming most" ≈ most of position
      option: { optionType: 'call', strike: 370, expiration: '2026-06-18' },
      confidence: 0.83,
      rationale: 'Trimming most of GOOGL 370C — sell, large portion',
    });

    const result = await parser.parse(makeEnvelope(
      'Trimming most\n\nClose or Trim & Set SL to BE\nGOOGL 370C 2026-06-18\n2.7500  →  5.1   P/L: +85.45% ($235.00)'
    ));

    expect(result.action).toBe('sell');
    expect(result.ticker).toBe('GOOGL');
    expect(result.option?.expiration).toBe('2026-06-18');
  });
});

describe('parseCallout — non-callouts (should be rejected)', () => {
  it('"Still in $SBUX!" commentary → isCallout false', async () => {
    const parser = parserWithMock({
      isCallout: false,
      assetType: 'equity',
      action: null,
      ticker: null,
      orderType: 'market',
      limitPrice: null,
      sizeHint: null,
      positionSize: null,
      option: null,
      confidence: 0.05,
      rationale: 'status update, no buy/sell directive',
    });

    const result = await parser.parse(makeEnvelope('Still in $SBUX ! @Pro'));
    expect(result.isCallout).toBe(false);
  });

  it('"$SBUX gives me $CVS vibes" → isCallout false', async () => {
    const parser = parserWithMock({
      isCallout: false,
      assetType: 'equity',
      action: null,
      ticker: null,
      orderType: 'market',
      limitPrice: null,
      sizeHint: null,
      positionSize: null,
      option: null,
      confidence: 0.02,
      rationale: 'opinion/comparison, no actionable directive',
    });

    const result = await parser.parse(makeEnvelope('$SBUX gives me $CVS vibes full transparency @Pro'));
    expect(result.isCallout).toBe(false);
  });

  it('"BANGERERRRRR! DONT LET IT GO RED" hype text → isCallout false', async () => {
    const parser = parserWithMock({
      isCallout: false,
      assetType: 'equity',
      action: null,
      ticker: null,
      orderType: 'market',
      limitPrice: null,
      sizeHint: null,
      positionSize: null,
      option: null,
      confidence: 0.03,
      rationale: 'hype/motivational text, not a trade directive',
    });

    const result = await parser.parse(makeEnvelope('BANGERERRRRR! DONT LET IT GO RED @Pro'));
    expect(result.isCallout).toBe(false);
  });

  it('P/L update line without BTO/BTC verb → isCallout false', async () => {
    const parser = parserWithMock({
      isCallout: false,
      assetType: 'equity',   // no contract extracted → default equity
      action: null,
      ticker: null,
      orderType: 'market',
      limitPrice: null,
      sizeHint: null,
      positionSize: null,
      option: null,
      confidence: 0.1,
      rationale: 'P/L status line only, no new trade directive',
    });

    const result = await parser.parse(makeEnvelope(
      'SPY 745C 2026-06-12\n1.7000  →  1.8   P/L: +5.88% ($10.00)\n\n@Namrood - LIVE DASHBOARD'
    ));
    expect(result.isCallout).toBe(false);
  });
});

describe('parseCallout — full channel format with @Pro / header noise', () => {
  it('BTO with @Optionality header and @Pro and @Namrood footer → clean buy signal', async () => {
    const parser = parserWithMock({
      isCallout: true,
      assetType: 'option',
      action: 'buy',
      ticker: 'SPY',
      orderType: 'limit',
      limitPrice: 0.71,
      sizeHint: null,
      positionSize: null,
      option: { optionType: 'call', strike: 755, expiration: '2026-06-15' },
      confidence: 0.96,
      rationale: 'BTO SPY 755C 0DTE $0.71 — role mentions ignored',
    });

    const fullMessage = [
      '@Optionality | Monday - 06-15-2026  09:35 AM EST',
      '@Pro',
      'Buy To Open',
      'SPY 755C 0DTE $0.71',
      '@Namrood - LIVE DASHBOARD',
    ].join('\n');

    const result = await parser.parse(makeEnvelope(fullMessage));
    expect(result.isCallout).toBe(true);
    expect(result.ticker).toBe('SPY');
    expect(result.limitPrice).toBe(0.71);
  });

  it('Lotto trade with @Pro noise → positionSize small', async () => {
    const parser = parserWithMock({
      isCallout: true,
      assetType: 'option',
      action: 'buy',
      ticker: 'SPY',
      orderType: 'limit',
      limitPrice: 1.7,
      sizeHint: null,
      positionSize: 'small',
      option: { optionType: 'call', strike: 745, expiration: '2026-06-15' },
      confidence: 0.88,
      rationale: 'Lotto/risky flag with role mentions stripped',
    });

    const fullMessage = [
      '@Optionality | Friday - 06-12-2026  11:24 AM EST',
      '@Pro',
      '⚠️ Lotto Trade — RISKY',
      'SPY 745C 0DTE $1.7',
      '⚠️ Size for what you can afford to lose --- 1% of your account balance.',
      'Manage your risk!',
      '@Namrood - LIVE DASHBOARD',
    ].join('\n');

    const result = await parser.parse(makeEnvelope(fullMessage));
    expect(result.positionSize).toBe('small');
    expect(result.option?.strike).toBe(745);
  });

  it('Close/Trim with P&L status line → sell, P/L arrow is not a limit price', async () => {
    const parser = parserWithMock({
      isCallout: true,
      assetType: 'option',
      action: 'sell',
      ticker: 'SPY',
      orderType: 'market',
      limitPrice: null,   // 0.71 → 0.9 is P/L info, not a limit order price
      sizeHint: null,
      positionSize: null,
      option: { optionType: 'call', strike: 755, expiration: '2026-06-15' },
      confidence: 0.85,
      rationale: 'Close/Trim directive — P/L arrow line is status, not a limit price',
    });

    const fullMessage = [
      '@Pro',
      'Close or Trim & Set SL to BE',
      'SPY 755C 2026-06-15',
      '0.7100  →  0.9   P/L: +26.76% ($19.00)',
      '@Namrood - LIVE DASHBOARD',
    ].join('\n');

    const result = await parser.parse(makeEnvelope(fullMessage));
    expect(result.action).toBe('sell');
    expect(result.limitPrice).toBeNull();  // P/L line must NOT be parsed as a limit price
  });
});

describe('parseCallout — multi-message thread context', () => {
  it('follow-up "Still in" after BTO is not a new entry', async () => {
    const parser = parserWithMock({
      isCallout: false,
      assetType: 'equity',   // no contract context in a holding update
      action: null,
      ticker: null,
      orderType: 'market',
      limitPrice: null,
      sizeHint: null,
      positionSize: null,
      option: null,
      confidence: 0.08,
      rationale: 'holding update, not a new trade directive',
    });

    const result = await parser.parse(makeEnvelope(
      '> ↪️ replying to **Namrood**: BTO $SBUX 103c 06/12 @0.55\nStill in $SBUX ! @Pro'
    ));
    expect(result.isCallout).toBe(false);
  });
});
