/**
 * Fixture-driven parseCallout tests — one test per real Discord message shape.
 * The LLM is mocked; each fixture's `expectedCallout` is what a correctly-behaving
 * model should return for that message.
 */

import { describe, expect, it, vi } from 'vitest';
import { LlmCalloutParser } from '../parseCallout.js';
import type { Callout, DiscordEnvelope, LlmProvider } from '../../../shared/types.js';
import {
  ALL_FIXTURES,
  ENTRY_FIXTURES,
  EXIT_FIXTURES,
  NON_CALLOUT_FIXTURES,
  envelopeFromFixture,
  type DiscordMessageFixture,
} from './fixtures/discordMessages.js';

function parserWithMock(response: Record<string, unknown>): LlmCalloutParser {
  const mockProvider: LlmProvider = {
    callStructured: vi.fn().mockResolvedValue(response),
  };
  return new LlmCalloutParser(mockProvider);
}

async function parseFixture(f: DiscordMessageFixture): Promise<Callout> {
  const parser = parserWithMock(f.expectedCallout);
  return parser.parse(envelopeFromFixture(f));
}

describe('message fixtures — entry signals (BTO / lotto)', () => {
  it.each(ENTRY_FIXTURES.map((f) => [f.id, f] as const))('%s → isCallout true, action buy', async (_id, fixture) => {
    const result = await parseFixture(fixture);
    expect(result.isCallout).toBe(true);
    expect(result.action).toBe('buy');
    expect(result.assetType).toBe('option');
    expect(result.ticker).toBe(fixture.expectedCallout.ticker);
    if (fixture.expectedCallout.limitPrice !== null) {
      expect(result.limitPrice).toBe(fixture.expectedCallout.limitPrice);
    }
    expect(result.option).toEqual(fixture.expectedCallout.option);
  });
});

describe('message fixtures — exit / management (TRIM / RUNNERS ONLY)', () => {
  it.each(EXIT_FIXTURES.map((f) => [f.id, f] as const))('%s → isCallout true, action sell', async (_id, fixture) => {
    const result = await parseFixture(fixture);
    expect(result.isCallout).toBe(true);
    expect(result.action).toBe('sell');
    expect(result.ticker).toBe(fixture.expectedCallout.ticker);
    expect(result.option).toEqual(fixture.expectedCallout.option);
    // P/L arrow lines must never become limit prices on exit signals
    expect(result.limitPrice).toBeNull();
    expect(result.orderType).toBe('market');
  });

  it('TRIM sequence: first trim → medium, double trim → medium, runners only → full', async () => {
    const trimFirst = await parseFixture(EXIT_FIXTURES.find((f) => f.id === 'trim-qqq-707c-first')!);
    const trimDouble = await parseFixture(EXIT_FIXTURES.find((f) => f.id === 'trim-qqq-707c-double')!);
    const runners = await parseFixture(EXIT_FIXTURES.find((f) => f.id === 'runners-only-qqq-707c')!);

    expect(trimFirst.positionSize).toBe('medium');
    expect(trimDouble.positionSize).toBe('medium');
    expect(runners.positionSize).toBe('full');
  });
});

describe('message fixtures — non-callouts (hype / commentary / status)', () => {
  it.each(NON_CALLOUT_FIXTURES.map((f) => [f.id, f] as const))('%s → isCallout false', async (_id, fixture) => {
    const result = await parseFixture(fixture);
    expect(result.isCallout).toBe(false);
    expect(result.action).toBeNull();
  });
});

describe('message fixtures — full catalog schema acceptance', () => {
  it.each(ALL_FIXTURES.map((f) => [f.id, f] as const))('%s accepted by CalloutSchema', async (_id, fixture) => {
    const result = await parseFixture(fixture);
    expect(result).toMatchObject<Partial<Callout>>({
      isCallout: fixture.expectedCallout.isCallout,
      assetType: fixture.expectedCallout.assetType,
      action: fixture.expectedCallout.action,
    });
  });
});

describe('message fixtures — prompt includes message content', () => {
  it('passes envelope content and timestamp to the LLM provider', async () => {
    const fixture = ALL_FIXTURES[0]!;
    const mockCall = vi.fn().mockResolvedValue(fixture.expectedCallout);
    const parser = new LlmCalloutParser({ callStructured: mockCall });
    const envelope = envelopeFromFixture(fixture);

    await parser.parse(envelope);

    expect(mockCall).toHaveBeenCalledOnce();
    const call = mockCall.mock.calls[0]![0] as { user: string; system: string };
    expect(call.user).toContain(envelope.content);
    expect(call.user).toContain(envelope.timestamp);
    expect(call.user).toContain(envelope.authorName);
    expect(call.system).toContain('TRIM');
    expect(call.system).toContain('RUNNERS ONLY');
    expect(call.system).toContain('BANG!');
  });
});

describe('message fixtures — Demon Alerts author variants', () => {
  it('BTO from Demon Alerts with risky tag sizes small', async () => {
    const fixture = ALL_FIXTURES.find((f) => f.id === 'bto-qqq-710p')!;
    const result = await parseFixture(fixture);
    expect(fixture.authorName).toBe('Demon Alerts');
    expect(result.positionSize).toBe('small');
  });

  it('image URL appended to BTO message does not break parsing', async () => {
    const result = await parseFixture(ALL_FIXTURES.find((f) => f.id === 'bto-with-image-url')!);
    expect(result.isCallout).toBe(true);
    expect(result.ticker).toBe('QQQ');
  });
});

// Silence unused import lint — envelope type used implicitly via envelopeFromFixture
void (null as unknown as DiscordEnvelope);
