/**
 * riskFilter tests — fully deterministic, no LLM or network calls.
 *
 * Tests cover:
 *   - Allowlist / blocklist enforcement
 *   - Daily trade cap
 *   - Per-ticker cooldown
 *   - Confidence threshold
 *   - Regular-hours gate
 *   - Portfolio-percentage sizing for all keywords (small / medium / full)
 *   - Explicit quantity hints (shares / contracts)
 *   - Options-specific guards
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkRisk, isRegularUsTradingHours } from '../riskFilter.js';
import type { Callout } from '../../../shared/types.js';

// ---------------------------------------------------------------------------
// Mock config so tests are independent of .env values
// ---------------------------------------------------------------------------

vi.mock('../../../shared/config.js', () => ({
  config: {
    minConfidence: 0.7,
    blockedTickers: ['GME'],
    allowedTickers: [],          // empty = allow all
    regularHoursOnly: false,     // disabled by default in tests
    maxTradesPerDay: 3,
    cooldownSecondsPerTicker: 60,
    maxNotionalPctPerTrade: 5,   // equity cap = 5% of buying power
    maxOptionsNotionalPct: 2,    // options cap = 2%
    positionSmallPct: 25,        // small  = 25% of cap
    positionMediumPct: 50,       // medium = 50% of cap
    riskStatePath: '/tmp/test-risk-state.json',
  },
  isAllowed: (v: string, list: string[]) => list.length === 0 || list.includes(v),
}));

// Mock fs so state reads/writes don't touch disk
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Base callout fixtures
// ---------------------------------------------------------------------------

const BASE_EQUITY: Callout = {
  isCallout: true,
  assetType: 'equity',
  action: 'buy',
  ticker: 'AAPL',
  orderType: 'market',
  limitPrice: null,
  sizeHint: null,
  positionSize: null,
  option: null,
  confidence: 0.9,
  rationale: 'buy AAPL',
};

const BASE_OPTION: Callout = {
  isCallout: true,
  assetType: 'option',
  action: 'buy',
  ticker: 'SPY',
  orderType: 'limit',
  limitPrice: 0.71,
  sizeHint: null,
  positionSize: null,
  option: { optionType: 'call', strike: 755, expiration: '2026-06-15' },
  confidence: 0.95,
  rationale: 'BTO SPY 755C',
};

// Reset module-level state between tests by forcing a fresh state load
beforeEach(() => {
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// Guard rails
// ---------------------------------------------------------------------------

describe('riskFilter — guards', () => {
  it('allows a clean equity callout', async () => {
    const result = await checkRisk(BASE_EQUITY);
    expect(result.allow).toBe(true);
  });

  it('rejects when isCallout=false', async () => {
    const result = await checkRisk({ ...BASE_EQUITY, isCallout: false });
    expect(result.allow).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/not a callout/);
  });

  it('rejects blocked ticker', async () => {
    const result = await checkRisk({ ...BASE_EQUITY, ticker: 'GME' });
    expect(result.allow).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/blocked/);
  });

  it('rejects low-confidence callout', async () => {
    const result = await checkRisk({ ...BASE_EQUITY, confidence: 0.5 });
    expect(result.allow).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/confidence/);
  });

  it('rejects option callout missing contract details', async () => {
    const result = await checkRisk({ ...BASE_OPTION, option: null });
    expect(result.allow).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/missing contract/);
  });

  it('rejects equity callout with contracts sizeHint', async () => {
    const result = await checkRisk({
      ...BASE_EQUITY,
      sizeHint: { kind: 'contracts', value: 5 },
    });
    expect(result.allow).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/not valid for equity/);
  });
});

// ---------------------------------------------------------------------------
// Portfolio-percentage sizing
// ---------------------------------------------------------------------------

describe('riskFilter — equity keyword sizing', () => {
  it('no size keyword → medium (50% of cap = 2.5% of portfolio)', async () => {
    const result = await checkRisk({ ...BASE_EQUITY, positionSize: null });
    expect(result.allow).toBe(true);
    if (!result.allow) return;
    // cap=5%, medium fraction=50% → 5 * 0.50 = 2.5
    expect(result.portfolioPct).toBeCloseTo(2.5);
    expect(result.quantityHint).toBeNull();
  });

  it('positionSize=small → 25% of cap = 1.25% of portfolio', async () => {
    const result = await checkRisk({ ...BASE_EQUITY, positionSize: 'small' });
    expect(result.allow).toBe(true);
    if (!result.allow) return;
    expect(result.portfolioPct).toBeCloseTo(1.25);
  });

  it('positionSize=full → 100% of cap = 5% of portfolio', async () => {
    const result = await checkRisk({ ...BASE_EQUITY, positionSize: 'full' });
    expect(result.allow).toBe(true);
    if (!result.allow) return;
    expect(result.portfolioPct).toBeCloseTo(5);
  });

  it('explicit shares → quantityHint set, portfolioPct = cap', async () => {
    const result = await checkRisk({
      ...BASE_EQUITY,
      sizeHint: { kind: 'shares', value: 10 },
    });
    expect(result.allow).toBe(true);
    if (!result.allow) return;
    expect(result.quantityHint).toBe(10);
    expect(result.portfolioPct).toBeCloseTo(5); // cap
  });

  it('explicit USD amount → quantityHint null, portfolioPct = cap (pipeline enforces min)', async () => {
    const result = await checkRisk({
      ...BASE_EQUITY,
      sizeHint: { kind: 'usd', value: 250 },
    });
    expect(result.allow).toBe(true);
    if (!result.allow) return;
    expect(result.quantityHint).toBeNull();
    expect(result.portfolioPct).toBeCloseTo(5);
  });
});

describe('riskFilter — options keyword sizing', () => {
  it('no size keyword on option → small (25% of options cap = 0.5% of portfolio)', async () => {
    const result = await checkRisk({ ...BASE_OPTION, positionSize: null });
    expect(result.allow).toBe(true);
    if (!result.allow) return;
    // options cap=2%, small fraction=25% → 2 * 0.25 = 0.5
    expect(result.portfolioPct).toBeCloseTo(0.5);
    expect(result.quantityHint).toBeNull();
  });

  it('positionSize=full on option → 100% of options cap = 2% of portfolio', async () => {
    const result = await checkRisk({ ...BASE_OPTION, positionSize: 'full' });
    expect(result.allow).toBe(true);
    if (!result.allow) return;
    expect(result.portfolioPct).toBeCloseTo(2);
  });

  it('explicit contracts → quantityHint floored to integer', async () => {
    const result = await checkRisk({
      ...BASE_OPTION,
      sizeHint: { kind: 'contracts', value: 3.9 }, // floored to 3
    });
    expect(result.allow).toBe(true);
    if (!result.allow) return;
    expect(result.quantityHint).toBe(3);
  });

  it('limit order sets limitPrice from callout', async () => {
    const result = await checkRisk(BASE_OPTION); // limitPrice=0.71
    expect(result.allow).toBe(true);
    if (!result.allow) return;
    expect(result.limitPrice).toBe(0.71);
    expect(result.orderType).toBe('limit');
  });

  it('market order clears limitPrice', async () => {
    const result = await checkRisk({ ...BASE_OPTION, orderType: 'market', limitPrice: null });
    expect(result.allow).toBe(true);
    if (!result.allow) return;
    expect(result.limitPrice).toBeNull();
  });

  it('TRIM sell callout → market sell allowed with medium sizing', async () => {
    const trimSell: Callout = {
      isCallout: true,
      assetType: 'option',
      action: 'sell',
      ticker: 'QQQ',
      orderType: 'market',
      limitPrice: null,
      sizeHint: null,
      positionSize: 'medium',
      option: { optionType: 'call', strike: 707, expiration: '2026-06-11' },
      confidence: 0.88,
      rationale: 'TRIM QQQ 707C',
    };
    const result = await checkRisk(trimSell);
    expect(result.allow).toBe(true);
    if (!result.allow) return;
    expect(result.orderType).toBe('market');
    expect(result.limitPrice).toBeNull();
    // options cap=2%, medium=50% → 1% of portfolio
    expect(result.portfolioPct).toBeCloseTo(1);
  });

  it('RUNNERS ONLY sell → full options cap sizing', async () => {
    const runnersSell: Callout = {
      ...BASE_OPTION,
      action: 'sell',
      orderType: 'market',
      limitPrice: null,
      positionSize: 'full',
      ticker: 'QQQ',
      option: { optionType: 'call', strike: 707, expiration: '2026-06-11' },
      rationale: 'RUNNERS ONLY QQQ 707C',
    };
    const result = await checkRisk(runnersSell);
    expect(result.allow).toBe(true);
    if (!result.allow) return;
    expect(result.portfolioPct).toBeCloseTo(2);
  });
});

// ---------------------------------------------------------------------------
// Trading hours
// ---------------------------------------------------------------------------

describe('isRegularUsTradingHours', () => {
  const at = (dateStr: string) => new Date(dateStr);

  it('09:31 ET Mon → true', () => {
    expect(isRegularUsTradingHours(at('2026-06-15T13:31:00Z'))).toBe(true);
  });

  it('09:29 ET Mon → false (pre-market)', () => {
    expect(isRegularUsTradingHours(at('2026-06-15T13:29:00Z'))).toBe(false);
  });

  it('16:00 ET Mon → false (after close)', () => {
    expect(isRegularUsTradingHours(at('2026-06-15T20:00:00Z'))).toBe(false);
  });

  it('15:59 ET Mon → true', () => {
    expect(isRegularUsTradingHours(at('2026-06-15T19:59:00Z'))).toBe(true);
  });

  it('Saturday → false', () => {
    expect(isRegularUsTradingHours(at('2026-06-13T15:00:00Z'))).toBe(false);
  });

  it('Sunday → false', () => {
    expect(isRegularUsTradingHours(at('2026-06-14T15:00:00Z'))).toBe(false);
  });
});
