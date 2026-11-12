/**
 * roundPremiumToTick — snapping callout premiums onto Robinhood's price grid.
 *
 * The prices under test are real rejections from prod (Sep 22, 2026): the
 * Swift desk relays IBKR half-cent premiums (0.195, 0.165, 0.085) and
 * Robinhood answered 400 "Price does not satisfy the min tick value".
 */
import { describe, expect, it } from 'vitest';

import { roundPremiumToTick } from '../tools.js';
import type { OptionMinTicks } from '../types.js';

// SPY/QQQ-style penny-program instrument: $0.01 everywhere.
const PENNY_GRID: OptionMinTicks = { aboveTick: 0.01, belowTick: 0.01, cutoffPrice: 3 };

describe('roundPremiumToTick', () => {
  it('rounds half-cent buys up to the next cent (default grid)', () => {
    expect(roundPremiumToTick(0.195, 'buy', null)).toBe(0.2);
    expect(roundPremiumToTick(0.165, 'buy', null)).toBe(0.17);
    expect(roundPremiumToTick(0.085, 'buy', null)).toBe(0.09);
  });

  it('rounds half-cent sells down to the previous cent', () => {
    expect(roundPremiumToTick(0.195, 'sell', null)).toBe(0.19);
    expect(roundPremiumToTick(0.165, 'sell', null)).toBe(0.16);
  });

  it('leaves on-grid prices untouched despite float noise', () => {
    expect(roundPremiumToTick(0.39, 'buy', null)).toBe(0.39);
    expect(roundPremiumToTick(0.29, 'buy', null)).toBe(0.29);
    expect(roundPremiumToTick(3.4, 'sell', null)).toBe(3.4);
  });

  it('uses the nickel grid at and above the cutoff on the default grid', () => {
    expect(roundPremiumToTick(3.38, 'buy', null)).toBe(3.4);
    expect(roundPremiumToTick(3.38, 'sell', null)).toBe(3.35);
  });

  it('respects the instrument grid when provided', () => {
    expect(roundPremiumToTick(3.38, 'buy', PENNY_GRID)).toBe(3.38);
    expect(roundPremiumToTick(3.381, 'sell', PENNY_GRID)).toBe(3.38);
  });

  it('never rounds a sell below one tick', () => {
    expect(roundPremiumToTick(0.004, 'sell', null)).toBe(0.01);
  });
});
