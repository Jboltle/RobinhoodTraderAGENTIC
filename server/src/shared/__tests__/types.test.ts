/**
 * TradeSettingsSchema parse shapes for Following
 * (docs/specs/0001-caller-following.md): the three semantics the spec pins.
 */
import { describe, expect, it } from 'vitest';

import { TradeSettingsSchema } from '../types.js';

describe('TradeSettingsSchema — followedCallerIds', () => {
  it('defaults to an empty list: follow no one until Callers are picked', () => {
    expect(TradeSettingsSchema.parse({}).followedCallerIds).toEqual([]);
  });

  it('keeps an empty list: follow no one', () => {
    expect(TradeSettingsSchema.parse({ followedCallerIds: [] }).followedCallerIds).toEqual([]);
  });

  it('keeps an explicit null: legacy rows still follow every Caller', () => {
    expect(TradeSettingsSchema.parse({ followedCallerIds: null }).followedCallerIds).toBeNull();
  });

  it('keeps an explicit list: follow exactly those author ids', () => {
    expect(
      TradeSettingsSchema.parse({ followedCallerIds: ['author-1', 'author-2'] }).followedCallerIds
    ).toEqual(['author-1', 'author-2']);
  });
});

describe('TradeSettingsSchema — max loss', () => {
  it('defaults both thresholds to off', () => {
    const settings = TradeSettingsSchema.parse({});
    expect(settings.maxLossPct).toBeNull();
    expect(settings.maxLossUsd).toBeNull();
  });

  it('accepts 0 (the trip function treats it as off)', () => {
    expect(TradeSettingsSchema.parse({ maxLossPct: 0, maxLossUsd: 0 })).toMatchObject({
      maxLossPct: 0,
      maxLossUsd: 0,
    });
  });

  it('keeps an explicit percent and dollar cap', () => {
    expect(TradeSettingsSchema.parse({ maxLossPct: 50, maxLossUsd: 150 })).toMatchObject({
      maxLossPct: 50,
      maxLossUsd: 150,
    });
  });
});
