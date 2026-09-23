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
    authorAvatarUrl: null,
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

  it('treats invalid schema output as non-callout', async () => {
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

    const result = await parser.parse(makeEnvelope('SPY 755C'));
    expect(result.isCallout).toBe(false);
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
  it('compact option line in multi-idea alert parses first concrete entry', async () => {
    const mockProvider: LlmProvider = {
      callStructured: vi.fn().mockRejectedValue(new Error('LLM should not be called')),
    };
    const parser = new LlmCalloutParser(mockProvider);

    const result = await parser.parse(makeEnvelope([
      '$KEEL shares',
      '$KEEL 6c 8/21 1.15 fill ',
      'Or 2028 JAN 7c super leap for $300',
    ].join('\n'), '2026-07-01T14:35:00.000Z'));

    expect(mockProvider.callStructured).not.toHaveBeenCalled();
    expect(result).toMatchObject<Partial<Callout>>({
      isCallout: true,
      assetType: 'option',
      action: 'buy',
      ticker: 'KEEL',
      orderType: 'limit',
      limitPrice: 1.15,
      option: { optionType: 'call', strike: 6, expiration: '2026-08-21' },
    });
  });
  it('labeled entering option alert parses deterministically', async () => {
    const mockProvider: LlmProvider = {
      callStructured: vi.fn().mockRejectedValue(new Error('LLM should not be called')),
    };
    const parser = new LlmCalloutParser(mockProvider);

    const result = await parser.parse(makeEnvelope([
      "I'm Entering",
      'Option: MRNA 75 C 7/17',
      '',
      'Entry: 3.40',
      '',
      'Notes:',
    ].join('\n'), '2026-07-01T14:35:00.000Z'));

    expect(mockProvider.callStructured).not.toHaveBeenCalled();
    expect(result).toMatchObject<Partial<Callout>>({
      isCallout: true,
      assetType: 'option',
      action: 'buy',
      ticker: 'MRNA',
      orderType: 'limit',
      limitPrice: 3.4,
      option: { optionType: 'call', strike: 75, expiration: '2026-07-17' },
    });
  });
  it('labeled entering option alert with entry range parses deterministically', async () => {
    const mockProvider: LlmProvider = {
      callStructured: vi.fn().mockRejectedValue(new Error('LLM should not be called')),
    };
    const parser = new LlmCalloutParser(mockProvider);

    const result = await parser.parse(makeEnvelope([
      "I'm Entering",
      'Option: HOOD 110 C 7/17',
      '',
      'Entry: 5.55-5.60',
      '',
      'Notes: ​',
    ].join('\n'), '2026-07-01T14:35:00.000Z'));

    expect(mockProvider.callStructured).not.toHaveBeenCalled();
    expect(result).toMatchObject<Partial<Callout>>({
      isCallout: true,
      assetType: 'option',
      action: 'buy',
      ticker: 'HOOD',
      orderType: 'limit',
      limitPrice: 5.6,
      option: { optionType: 'call', strike: 110, expiration: '2026-07-17' },
    });
  });
  it('labeled entering option alert with no entry price parses as a market buy', async () => {
    const mockProvider: LlmProvider = {
      callStructured: vi.fn().mockRejectedValue(new Error('LLM should not be called')),
    };
    const parser = new LlmCalloutParser(mockProvider);

    const result = await parser.parse(makeEnvelope([
      "I'm Entering",
      'Option: GOOGL 380 C 7/24',
    ].join('\n'), '2026-07-01T14:35:00.000Z'));

    expect(mockProvider.callStructured).not.toHaveBeenCalled();
    expect(result).toMatchObject<Partial<Callout>>({
      isCallout: true,
      assetType: 'option',
      action: 'buy',
      ticker: 'GOOGL',
      orderType: 'market',
      limitPrice: null,
      option: { optionType: 'call', strike: 380, expiration: '2026-07-24' },
    });
  });
  it('SPX 7500C - 4.8 - chase parses as a deterministic 0DTE buy', async () => {
    const mockProvider: LlmProvider = {
      callStructured: vi.fn().mockRejectedValue(new Error('LLM should not be called')),
    };
    const parser = new LlmCalloutParser(mockProvider);

    const result = await parser.parse(makeEnvelope('SPX 7500C - 4.8 - chase @Pro'));

    expect(mockProvider.callStructured).not.toHaveBeenCalled();
    expect(result).toMatchObject<Partial<Callout>>({
      isCallout: true,
      assetType: 'option',
      action: 'buy',
      ticker: 'SPX',
      orderType: 'limit',
      limitPrice: 4.8,
      option: { optionType: 'call', strike: 7500, expiration: '2026-06-15' },
    });
  });
  it('Buy To Open with SMALL POSITION tag and trailing headers parses deterministically', async () => {
    // Regression: this exact message surfaced as parser_error when the LLM
    // call failed. Bot entry alerts must never depend on the LLM.
    const mockProvider: LlmProvider = {
      callStructured: vi.fn().mockRejectedValue(new Error('LLM should not be called')),
    };
    const parser = new LlmCalloutParser(mockProvider);

    const result = await parser.parse(makeEnvelope([
      'Buy To Open',
      '',
      'SMALL POSITION',
      '',
      'SPY 743P 0DTE 0.9',
      '',
      '@Namrood - LIVE DASHBOARD',
      '',
      '@Optionality | Monday - 07-20-2026 10:20 AM EST',
    ].join('\n'), '2026-07-20T14:20:00.000Z'));

    expect(mockProvider.callStructured).not.toHaveBeenCalled();
    expect(result).toMatchObject<Partial<Callout>>({
      isCallout: true,
      assetType: 'option',
      action: 'buy',
      ticker: 'SPY',
      orderType: 'limit',
      limitPrice: 0.9,
      positionSize: 'small',
      option: { optionType: 'put', strike: 743, expiration: '2026-07-20' },
    });
  });

  it('Buy To Open below @Optionality header and @Pro mention parses deterministically', async () => {
    const mockProvider: LlmProvider = {
      callStructured: vi.fn().mockRejectedValue(new Error('LLM should not be called')),
    };
    const parser = new LlmCalloutParser(mockProvider);

    const result = await parser.parse(makeEnvelope([
      '@Optionality | Monday - 06-15-2026  09:35 AM EST',
      '@Pro',
      'Buy To Open',
      'SPY 755C 0DTE $0.71',
      '@Namrood - LIVE DASHBOARD',
    ].join('\n')));

    expect(mockProvider.callStructured).not.toHaveBeenCalled();
    expect(result).toMatchObject<Partial<Callout>>({
      isCallout: true,
      action: 'buy',
      ticker: 'SPY',
      orderType: 'limit',
      limitPrice: 0.71,
      option: { optionType: 'call', strike: 755, expiration: '2026-06-15' },
    });
  });

  it('bold **Buy To Open** directive parses deterministically', async () => {
    const mockProvider: LlmProvider = {
      callStructured: vi.fn().mockRejectedValue(new Error('LLM should not be called')),
    };
    const parser = new LlmCalloutParser(mockProvider);

    const result = await parser.parse(makeEnvelope(
      '**Buy To Open**\nSPY 743P 0DTE 0.9',
      '2026-07-20T14:20:00.000Z'
    ));

    expect(mockProvider.callStructured).not.toHaveBeenCalled();
    expect(result).toMatchObject<Partial<Callout>>({
      isCallout: true,
      action: 'buy',
      ticker: 'SPY',
      limitPrice: 0.9,
      option: { optionType: 'put', strike: 743, expiration: '2026-07-20' },
    });
  });

  it('strips Discord ANSI color codes so mTSLA is not parsed as the ticker', async () => {
    const mockProvider: LlmProvider = {
      callStructured: vi.fn().mockRejectedValue(new Error('LLM should not be called')),
    };
    const parser = new LlmCalloutParser(mockProvider);

    const result = await parser.parse(
      makeEnvelope('BTO \u001b[1;32mTSLA 375C 0DTE $1.50', '2026-09-09T14:35:00.000Z')
    );

    expect(mockProvider.callStructured).not.toHaveBeenCalled();
    expect(result).toMatchObject<Partial<Callout>>({
      isCallout: true,
      action: 'buy',
      ticker: 'TSLA',
      option: { optionType: 'call', strike: 375, expiration: '2026-09-09' },
    });
  });

  it('BTO $SPY 755C 0DTE $0.71 parses deterministically without the LLM', async () => {
    const mockProvider: LlmProvider = {
      callStructured: vi.fn().mockRejectedValue(new Error('LLM should not be called')),
    };
    const parser = new LlmCalloutParser(mockProvider);

    const result = await parser.parse(makeEnvelope('BTO $SPY 755C 0DTE $0.71'));

    expect(mockProvider.callStructured).not.toHaveBeenCalled();
    expect(result).toMatchObject<Partial<Callout>>({
      isCallout: true,
      assetType: 'option',
      action: 'buy',
      ticker: 'SPY',
      orderType: 'limit',
      limitPrice: 0.71,
      positionSize: null,
      option: { optionType: 'call', strike: 755, expiration: '2026-06-15' },
    });
  });
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
  it('"Trim some" Close-or-Trim alert parses deterministically without the LLM', async () => {
    // Regression: this exact message surfaced as parser_error when the LLM
    // call failed. Bot exit alerts must never depend on the LLM.
    const mockProvider: LlmProvider = {
      callStructured: vi.fn().mockRejectedValue(new Error('LLM should not be called')),
    };
    const parser = new LlmCalloutParser(mockProvider);

    const result = await parser.parse(makeEnvelope([
      'Close or Trim & Set SL to BE',
      '',
      'Trim some',
      '',
      'SPY 743P 2026-07-20',
      '0.9000  →  1.06   P/L: +17.78% ($16.00)',
      '',
      '@Namrood - LIVE DASHBOARD',
      '',
      '@Optionality | Monday - 07-20-2026 10:21 AM EST',
    ].join('\n'), '2026-07-20T14:21:00.000Z'));

    expect(mockProvider.callStructured).not.toHaveBeenCalled();
    expect(result).toMatchObject<Partial<Callout>>({
      isCallout: true,
      assetType: 'option',
      action: 'sell',
      ticker: 'SPY',
      orderType: 'market',
      limitPrice: null,
      positionSize: 'medium',
      option: { optionType: 'put', strike: 743, expiration: '2026-07-20' },
    });
  });

  it('header-only Close-or-Trim alert (no size line) parses with positionSize null', async () => {
    const mockProvider: LlmProvider = {
      callStructured: vi.fn().mockRejectedValue(new Error('LLM should not be called')),
    };
    const parser = new LlmCalloutParser(mockProvider);

    const result = await parser.parse(makeEnvelope([
      '@Pro',
      'Close or Trim & Set SL to BE',
      'SPY 755C 2026-06-15',
      '0.7100  →  0.9   P/L: +26.76% ($19.00)',
      '@Namrood - LIVE DASHBOARD',
    ].join('\n')));

    expect(mockProvider.callStructured).not.toHaveBeenCalled();
    expect(result).toMatchObject<Partial<Callout>>({
      isCallout: true,
      action: 'sell',
      ticker: 'SPY',
      orderType: 'market',
      limitPrice: null,
      positionSize: null,
      option: { optionType: 'call', strike: 755, expiration: '2026-06-15' },
    });
  });

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

describe('parseCallout — invalid model output repair', () => {
  it('retries once with validation feedback and uses corrected output', async () => {
    const mockProvider: LlmProvider = {
      callStructured: vi.fn()
        .mockResolvedValueOnce({ isCallout: true, assetType: 'option', option: null })
        .mockResolvedValueOnce({
          isCallout: true,
          assetType: 'option',
          action: 'buy',
          ticker: 'KEEL',
          orderType: 'limit',
          limitPrice: 1.15,
          sizeHint: null,
          positionSize: null,
          option: { optionType: 'call', strike: 6, expiration: '2026-08-21' },
          confidence: 0.9,
          rationale: 'KEEL 6C 8/21 at 1.15',
        }),
    };
    const parser = new LlmCalloutParser(mockProvider);

    // Freeform enough to dodge every deterministic template, but every field
    // of the corrected output is grounded in the text (post-validation).
    const result = await parser.parse(
      makeEnvelope('thinking KEEL 6 calls for 8/21, around 1.15', '2026-07-01T14:35:00.000Z')
    );

    expect(mockProvider.callStructured).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject<Partial<Callout>>({
      isCallout: true,
      ticker: 'KEEL',
      option: { optionType: 'call', strike: 6, expiration: '2026-08-21' },
    });
  });
});
describe('parseCallout — pre-LLM chatter gate', () => {
  it('skips the LLM for a bare P/L line (no ticker or verb)', async () => {
    const mockProvider: LlmProvider = {
      callStructured: vi.fn().mockRejectedValue(new Error('LLM should not be called')),
    };
    const parser = new LlmCalloutParser(mockProvider);

    const result = await parser.parse(makeEnvelope('70% 🔥 5.10 to 8.53 🚀'));

    expect(mockProvider.callStructured).not.toHaveBeenCalled();
    expect(result.isCallout).toBe(false);
  });

  it('skips the LLM for lowercase hype with no ticker or verb', async () => {
    const mockProvider: LlmProvider = {
      callStructured: vi.fn().mockRejectedValue(new Error('LLM should not be called')),
    };
    const parser = new LlmCalloutParser(mockProvider);

    const result = await parser.parse(makeEnvelope('lets gooo, dont let it go red @pro'));

    expect(mockProvider.callStructured).not.toHaveBeenCalled();
    expect(result.isCallout).toBe(false);
  });

  it('still calls the LLM when a ticker-like token is present', async () => {
    const mockProvider: LlmProvider = {
      callStructured: vi.fn().mockResolvedValue({
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
        rationale: 'commentary about SBUX',
      }),
    };
    const parser = new LlmCalloutParser(mockProvider);

    await parser.parse(makeEnvelope('thoughts on SBUX here?'));

    expect(mockProvider.callStructured).toHaveBeenCalledTimes(1);
  });

  it('still calls the LLM when a trade verb is present (lowercase)', async () => {
    const mockProvider: LlmProvider = {
      callStructured: vi.fn().mockResolvedValue({
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
        rationale: 'ambiguous buy chatter',
      }),
    };
    const parser = new LlmCalloutParser(mockProvider);

    await parser.parse(makeEnvelope('might buy something soon idk'));

    expect(mockProvider.callStructured).toHaveBeenCalledTimes(1);
  });
});

describe('parseCallout — pre-LLM brag/P/L-update filter', () => {
  const BRAG_MESSAGES = [
    '**130%** 🔥aapl calls 3.38 to 7.70 now!!! 🚀',
    '**100%** 🔥aapl calls 3.38 to 6.76 now!!! 🚀',
    '**45%** 🔥aapl calls',
    '**40%** 🔥aapl calls 4.53 now sniper!!! 🚀',
  ];

  it.each(BRAG_MESSAGES)('classifies "%s" as not_callout without the LLM', async (content) => {
    const mockProvider: LlmProvider = {
      callStructured: vi.fn().mockRejectedValue(new Error('LLM should not be called')),
    };
    const parser = new LlmCalloutParser(mockProvider);

    const result = await parser.parse(makeEnvelope(content));

    expect(mockProvider.callStructured).not.toHaveBeenCalled();
    expect(result.isCallout).toBe(false);
    expect(result.rationale).toMatch(/pre-filter/);
  });

  it('does not filter a real BTO entry (parses deterministically)', async () => {
    const mockProvider: LlmProvider = {
      callStructured: vi.fn().mockRejectedValue(new Error('LLM should not be called')),
    };
    const parser = new LlmCalloutParser(mockProvider);

    const result = await parser.parse(makeEnvelope('BTO $MSFT 397.5c 07/15 @0.85', '2026-07-15T14:35:00.000Z'));

    expect(result).toMatchObject<Partial<Callout>>({
      isCallout: true,
      assetType: 'option',
      ticker: 'MSFT',
      limitPrice: 0.85,
      option: { optionType: 'call', strike: 397.5, expiration: '2026-07-15' },
    });
  });

  it("parses Bishop's bold-labeled entering alert deterministically", async () => {
    const mockProvider: LlmProvider = {
      callStructured: vi.fn().mockRejectedValue(new Error('LLM should not be called')),
    };
    const parser = new LlmCalloutParser(mockProvider);

    const result = await parser.parse(makeEnvelope(
      "I'm Entering\n**Option:** PANW 365 C 7/17\n**Entry:** 4.80-4.90",
      '2026-07-15T14:35:00.000Z'
    ));

    expect(mockProvider.callStructured).not.toHaveBeenCalled();
    expect(result.isCallout).toBe(true);
    expect(result.ticker).toBe('PANW');
    expect(result.limitPrice).toBe(4.9);
  });

  it('parses a lotto callout with a code-blocked contract deterministically', async () => {
    // Backtick fences are stripped like other markdown, so the lotto template
    // owns this shape — it must never depend on the LLM.
    const mockProvider: LlmProvider = {
      callStructured: vi.fn().mockRejectedValue(new Error('LLM should not be called')),
    };
    const parser = new LlmCalloutParser(mockProvider);

    const result = await parser.parse(makeEnvelope('⚠️ Lotto — RISKY\n```\nSPY 745C 0DTE $1.7\n```'));

    expect(mockProvider.callStructured).not.toHaveBeenCalled();
    expect(result).toMatchObject<Partial<Callout>>({
      isCallout: true,
      assetType: 'option',
      action: 'buy',
      ticker: 'SPY',
      orderType: 'limit',
      limitPrice: 1.7,
      positionSize: 'small',
      option: { optionType: 'call', strike: 745, expiration: '2026-06-15' },
    });
  });
});

describe('parseCallout — partial model output coercion', () => {
  it('coerces a chatter response missing assetType/orderType without a repair retry', async () => {
    // Mirrors the production log: the model returned everything except
    // assetType and orderType for a non-callout. Coercion should fill the
    // structural defaults so it validates on the first attempt.
    const mockProvider: LlmProvider = {
      callStructured: vi.fn().mockResolvedValue({
        isCallout: false,
        action: null,
        ticker: null,
        limitPrice: null,
        sizeHint: null,
        positionSize: null,
        option: null,
        confidence: 0.02,
        rationale: 'general chatter, no trade directive',
      }),
    };
    const parser = new LlmCalloutParser(mockProvider);

    const result = await parser.parse(makeEnvelope('anyone else in SPY today?'));

    expect(mockProvider.callStructured).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject<Partial<Callout>>({
      isCallout: false,
      assetType: 'equity',
      orderType: 'market',
    });
  });

  it('infers assetType=option from a present option block when omitted', async () => {
    const mockProvider: LlmProvider = {
      callStructured: vi.fn().mockResolvedValue({
        isCallout: true,
        action: 'buy',
        ticker: 'SPY',
        limitPrice: 0.71,
        sizeHint: null,
        positionSize: null,
        option: { optionType: 'call', strike: 755, expiration: '2026-06-15' },
        confidence: 0.95,
        rationale: 'BTO SPY 755C',
      }),
    };
    const parser = new LlmCalloutParser(mockProvider);

    const result = await parser.parse(makeEnvelope('SPY 755C 0.71'));

    expect(mockProvider.callStructured).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject<Partial<Callout>>({
      isCallout: true,
      assetType: 'option',
      orderType: 'market',
      ticker: 'SPY',
      option: { optionType: 'call', strike: 755, expiration: '2026-06-15' },
    });
  });
});

describe('parseCallout — invalid model output fallback', () => {
  it('treats malformed LLM output for P/L chatter as a non-callout', async () => {
    const parser = parserWithMock({ assetType: 'status_update' });

    const result = await parser.parse(makeEnvelope('70% 🔥5.10 to 8.53 🚀'));

    expect(result).toMatchObject<Partial<Callout>>({
      isCallout: false,
      action: null,
      ticker: null,
      option: null,
    });
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

describe('parseCallout — language pre-filters (no LLM)', () => {
  const PREFILTERED_MESSAGES: readonly [string, string][] = [
    ['P/L-only status', 'SPY 745C 2026-06-12\n1.7000  →  1.8   P/L: +5.88% ($10.00)\n\n@Namrood - LIVE DASHBOARD'],
    ['LETS BANK hype', 'LETS BANK NEXT WEEK! @Pro'],
    ['fill complaint', 'everyone had MUCH better fill than me!! This dropped to .8 @Pro'],
    ['vibes opinion', '$SBUX gives me $CVS vibes full transparency @Pro'],
    ['watchlist mention', 'still watching SBUX here'],
    ['holding update', 'Still in $SBUX ! @Pro'],
  ];

  it.each(PREFILTERED_MESSAGES)('%s → non-callout without the LLM', async (_label, content) => {
    const mockProvider: LlmProvider = {
      callStructured: vi.fn().mockRejectedValue(new Error('LLM should not be called')),
    };
    const parser = new LlmCalloutParser(mockProvider);

    const result = await parser.parse(makeEnvelope(content));

    expect(mockProvider.callStructured).not.toHaveBeenCalled();
    expect(result.isCallout).toBe(false);
    expect(result.rationale).toMatch(/pre-filter/);
  });

  it('a directive verb disarms every language pre-filter', async () => {
    const mockProvider: LlmProvider = {
      callStructured: vi.fn().mockResolvedValue({
        isCallout: false,
        assetType: 'equity',
        action: null,
        ticker: null,
        orderType: 'market',
        limitPrice: null,
        sizeHint: null,
        positionSize: null,
        option: null,
        confidence: 0.2,
        rationale: 'ambiguous — watching but also talking about buying',
      }),
    };
    const parser = new LlmCalloutParser(mockProvider);

    await parser.parse(makeEnvelope('watching SOFI, might buy at 5'));

    expect(mockProvider.callStructured).toHaveBeenCalledTimes(1);
  });

  it('a contract-like token disarms the holding-update pre-filter', async () => {
    const mockProvider: LlmProvider = {
      callStructured: vi.fn().mockResolvedValue({
        isCallout: false,
        assetType: 'equity',
        action: null,
        ticker: null,
        orderType: 'market',
        limitPrice: null,
        sizeHint: null,
        positionSize: null,
        option: null,
        confidence: 0.2,
        rationale: 'holding update mentioning a contract',
      }),
    };
    const parser = new LlmCalloutParser(mockProvider);

    await parser.parse(makeEnvelope('Still in SPY 755C, looking strong'));

    expect(mockProvider.callStructured).toHaveBeenCalledTimes(1);
  });
});

describe('parseCallout — LLM grounding post-validation', () => {
  const llmCallout = (overrides: Partial<Callout>): Record<string, unknown> => ({
    isCallout: true,
    assetType: 'option',
    action: 'buy',
    ticker: 'SPY',
    orderType: 'market',
    limitPrice: null,
    sizeHint: null,
    positionSize: null,
    option: { optionType: 'call', strike: 755, expiration: '2026-06-15' },
    confidence: 0.9,
    rationale: 'model output under test',
    ...overrides,
  });

  it('rejects a ticker that does not appear in the message', async () => {
    const parser = parserWithMock(llmCallout({ ticker: 'NVDA' }));

    const result = await parser.parse(makeEnvelope('grabbing some calls here soon'));

    expect(result.isCallout).toBe(false);
    expect(result.rationale).toMatch(/post-validation/);
  });

  it('rejects a strike that does not appear in the message', async () => {
    const parser = parserWithMock(llmCallout({}));

    const result = await parser.parse(makeEnvelope('adding to my SPY position'));

    expect(result.isCallout).toBe(false);
    expect(result.rationale).toMatch(/strike 755/);
  });

  it('accepts an expiration resolved from a weekday alias in the message', async () => {
    // 2026-07-01 is a Wednesday; "Friday" resolves to 2026-07-03.
    const parser = parserWithMock(llmCallout({
      action: 'buy',
      option: { optionType: 'put', strike: 180, expiration: '2026-07-03' },
      ticker: 'AAPL',
    }));

    const result = await parser.parse(
      makeEnvelope('grabbing AAPL 180 puts Friday', '2026-07-01T14:35:00.000Z')
    );

    expect(result.isCallout).toBe(true);
    expect(result.option?.expiration).toBe('2026-07-03');
  });

  it('rejects an expiration with no supporting date token in the message', async () => {
    const parser = parserWithMock(llmCallout({
      ticker: 'AAPL',
      option: { optionType: 'put', strike: 180, expiration: '2026-09-18' },
    }));

    const result = await parser.parse(
      makeEnvelope('grabbing AAPL 180 puts', '2026-07-01T14:35:00.000Z')
    );

    expect(result.isCallout).toBe(false);
    expect(result.rationale).toMatch(/expiration/);
  });

  it('accepts a same-day expiration even without a 0DTE token (intraday default)', async () => {
    const parser = parserWithMock(llmCallout({
      ticker: 'SPY',
      option: { optionType: 'call', strike: 755, expiration: '2026-06-15' },
    }));

    const result = await parser.parse(makeEnvelope('grabbing SPY 755 calls'));

    expect(result.isCallout).toBe(true);
  });
});

describe('parseCallout — parseTraced', () => {
  it('reports the deterministic path with zero LLM calls', async () => {
    const mockProvider: LlmProvider = {
      callStructured: vi.fn().mockRejectedValue(new Error('LLM should not be called')),
    };
    const parser = new LlmCalloutParser(mockProvider);

    const traced = await parser.parseTraced(makeEnvelope('BTO $SPY 755C 0DTE $0.71'));

    expect(traced.path).toBe('deterministic');
    expect(traced.llmCalls).toBe(0);
    expect(traced.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(traced.callout.isCallout).toBe(true);
  });

  it('reports the language pre-filter path', async () => {
    const mockProvider: LlmProvider = {
      callStructured: vi.fn().mockRejectedValue(new Error('LLM should not be called')),
    };
    const parser = new LlmCalloutParser(mockProvider);

    const traced = await parser.parseTraced(makeEnvelope('Still in $SBUX ! @Pro'));

    expect(traced.path).toBe('prefilter_language');
    expect(traced.llmCalls).toBe(0);
  });

  it('reports the llm path with one call for a leftover message', async () => {
    const mockProvider: LlmProvider = {
      callStructured: vi.fn().mockResolvedValue({
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
        rationale: 'chatter',
      }),
    };
    const parser = new LlmCalloutParser(mockProvider);

    const traced = await parser.parseTraced(makeEnvelope('thoughts on SBUX here?'));

    expect(traced.path).toBe('llm');
    expect(traced.llmCalls).toBe(1);
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

// ---------------------------------------------------------------------------
// 3. Position-lifecycle semantics — expected LLM output (caller-agnostic).
//    These document the prompt contract for status-shaped alerts: adds carry
//    isAddition=true at the added fill price, exit status sells at market.
// ---------------------------------------------------------------------------

describe('parseCallout — position adds and exit status (expected LLM output)', () => {
  it('averaging-down card parses as an isAddition buy at the added fill, not the average', async () => {
    const parser = parserWithMock({
      isCallout: true,
      isAddition: true,
      assetType: 'option',
      action: 'buy',
      ticker: 'SPY',
      orderType: 'limit',
      limitPrice: 0.295,   // "Added 25 @ $0.295" — never the $0.39 average
      sizeHint: null,      // "25 → 50 contracts" is the caller's running total
      positionSize: null,
      option: { optionType: 'put', strike: 772, expiration: '2026-09-22' },
      confidence: 0.9,
      rationale: 'averaging down on existing SPY 772P — add at the new fill',
    });

    const result = await parser.parse(makeEnvelope([
      'SWIFT TRADES · LIVE DESK',
      '➕ AVERAGING DOWN — SPY 772P · 0DTE',
      "Averaging down on **SPY Sep22 '26 772 Put**",
      'Added 25 @ $0.295',
      'Average $0.485 → $0.39 · 25 → 50 contracts',
      'New Avg: `$0.39`',
      'Trim Targets (new avg): 25% $0.488',
    ].join('\n'), '2026-09-22T16:12:00.000Z'));

    expect(result).toMatchObject<Partial<Callout>>({
      isCallout: true,
      isAddition: true,
      action: 'buy',
      limitPrice: 0.295,
      sizeHint: null,
    });
  });

  it('"close or trim" status card parses as a market sell, arrow prices are not limits', async () => {
    const parser = parserWithMock({
      isCallout: true,
      isAddition: false,
      assetType: 'option',
      action: 'sell',
      ticker: 'SPY',
      orderType: 'market',
      limitPrice: null,    // "$0.395 → $0.445" is P/L status, not a limit
      sizeHint: null,
      positionSize: null,
      option: { optionType: 'put', strike: 772, expiration: '2026-09-22' },
      confidence: 0.85,
      rationale: 'close-or-trim exit status — sell at market',
    });

    const result = await parser.parse(makeEnvelope([
      'SWIFT TRADES · LIVE DESK',
      '🚀 +10% — SPY 772P · 0DTE',
      '$0.395 → $0.445 · +12.7% (+$5.00/contract)',
      'Close or trim & set SL to breakeven.',
    ].join('\n'), '2026-09-22T14:55:00.000Z'));

    expect(result).toMatchObject<Partial<Callout>>({
      isCallout: true,
      action: 'sell',
      orderType: 'market',
      limitPrice: null,
    });
  });

  it('normalizes a sell limit to a market order (exits are market by design)', async () => {
    const parser = parserWithMock({
      isCallout: true,
      isAddition: false,
      assetType: 'option',
      action: 'sell',
      ticker: 'NVDA',
      orderType: 'limit',
      limitPrice: 1.069,   // the card's fill price — noise, not a directive
      sizeHint: null,
      positionSize: 'medium',
      option: { optionType: 'call', strike: 230, expiration: '2026-09-23' },
      confidence: 0.9,
      rationale: 'trim exit',
    });

    const result = await parser.parse(makeEnvelope(
      'SWIFT TRADES · LIVE DESK\n✂️ TRIM +25% — NVDA 230C · Sep 23\nSold 3 of 15 @ $1.069 · 12 still running.',
      '2026-09-22T15:02:00.000Z'
    ));

    expect(result).toMatchObject<Partial<Callout>>({
      isCallout: true,
      action: 'sell',
      orderType: 'market',
      limitPrice: null,
    });
  });

  it('LLM output without the isAddition field defaults to false', async () => {
    const parser = parserWithMock({
      isCallout: true,
      assetType: 'option',
      action: 'buy',
      ticker: 'SPY',
      orderType: 'market',
      limitPrice: null,
      sizeHint: null,
      positionSize: null,
      option: { optionType: 'put', strike: 700, expiration: '2026-09-22' },
      confidence: 0.9,
      rationale: 'fresh entry',
    });

    const result = await parser.parse(
      makeEnvelope('Buying SPY 700 puts here', '2026-09-22T14:55:00.000Z')
    );
    expect(result.isAddition).toBe(false);
  });
});

describe('parseCallout — daily recap pre-filter', () => {
  it('recap header blocks the LLM even when directive verbs and contracts appear', async () => {
    const provider: LlmProvider = {
      callStructured: vi.fn().mockRejectedValue(new Error('LLM should not be called')),
    };
    const parser = new LlmCalloutParser(provider);

    const result = await parser.parse(makeEnvelope([
      '📅 **SWIFT DAILY RECAP - 22 September 2026**',
      '📈 **TOP PLAY:  $AAPL - 9/25 345C  |  +121.75%**',
      '**SWIFT CALLS:**',
      '🟩 $AAPL - 9/25 345C @ 1.77 --> 3.92 | +121.75%',
      '🟩 $SPX - 9/22 7765P @ 0.53 --> 1.05 | +100.00%',
      'Closed everything into the bell.',
    ].join('\n'), '2026-09-22T21:12:00.000Z'));

    expect(provider.callStructured).not.toHaveBeenCalled();
    expect(result.isCallout).toBe(false);
    expect(result.rationale).toContain('daily recap');
  });
});
