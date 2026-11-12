import { describe, expect, it } from 'vitest';

import { occSymbol, parseOccSymbol, type OptionContractFields } from '../instrument.js';

const OCC_LENGTH = 21;
const SPY_CALL: OptionContractFields = { symbol: 'spy', expiration: '2026-11-20', strike: 600, optionType: 'call' };

describe('occSymbol', () => {
  it("builds SnapTrade's own example from the SDK's MlegTradingInstrument doc", () => {
    expect(occSymbol({ symbol: 'AAPL', expiration: '2025-11-14', strike: 240, optionType: 'call' })).toBe(
      'AAPL  251114C00240000'
    );
  });

  it('pads the root to six, upper-cases it, and writes the strike in thousandths', () => {
    expect(occSymbol(SPY_CALL)).toBe('SPY   261120C00600000');
    expect(occSymbol({ ...SPY_CALL, strike: 397.5, optionType: 'put' })).toBe('SPY   261120P00397500');
    expect(occSymbol({ ...SPY_CALL, symbol: 'GOOGL', strike: 0.5 })).toBe('GOOGL 261120C00000500');
    expect(occSymbol(SPY_CALL)).toHaveLength(OCC_LENGTH);
  });

  it('refuses a contract the format cannot hold', () => {
    expect(() => occSymbol({ ...SPY_CALL, expiration: '2026-02-30' })).toThrow(/real date/);
    expect(() => occSymbol({ ...SPY_CALL, expiration: '11/20/2026' })).toThrow(/real date/);
    expect(() => occSymbol({ ...SPY_CALL, expiration: '2126-11-20' })).toThrow(/real date/);
    expect(() => occSymbol({ ...SPY_CALL, strike: 600.1234 })).toThrow(/at most 3 decimals/);
    expect(() => occSymbol({ ...SPY_CALL, strike: 100_000 })).toThrow(/at most 3 decimals/);
    expect(() => occSymbol({ ...SPY_CALL, strike: 0 })).toThrow(/positive/);
    expect(() => occSymbol({ ...SPY_CALL, symbol: 'TOOLONG' })).toThrow(/option root/);
    expect(() => occSymbol({ ...SPY_CALL, symbol: 'BRK.B' })).toThrow(/option root/);
  });
});

describe('parseOccSymbol', () => {
  it('reads back what occSymbol wrote', () => {
    expect(parseOccSymbol(occSymbol(SPY_CALL))).toStrictEqual({
      kind: 'option',
      symbol: 'SPY',
      optionType: 'call',
      strike: 600,
      expiration: '2026-11-20',
    });
    expect(parseOccSymbol('GOOGL 261120P00000500')).toStrictEqual({
      kind: 'option',
      symbol: 'GOOGL',
      optionType: 'put',
      strike: 0.5,
      expiration: '2026-11-20',
    });
  });

  it('reads a symbol a broker returned without the root padding', () => {
    expect(parseOccSymbol('SPY261120C00600000')).toStrictEqual(parseOccSymbol('SPY   261120C00600000'));
  });

  it('keeps the OCC root, which is not always the underlying ticker', () => {
    expect(parseOccSymbol('SPXW  261120C06000000')?.symbol).toBe('SPXW');
  });

  it('is null for anything that is not an OCC symbol', () => {
    expect(parseOccSymbol('AAPL')).toBeNull();
    expect(parseOccSymbol('')).toBeNull();
    expect(parseOccSymbol('SPY   261120X00600000')).toBeNull();
    expect(parseOccSymbol('SPY   260230C00600000')).toBeNull();
    expect(parseOccSymbol('SPY   261120C00000000')).toBeNull();
  });
});
