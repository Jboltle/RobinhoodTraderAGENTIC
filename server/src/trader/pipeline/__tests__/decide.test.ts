import { describe, expect, it, vi } from 'vitest';

import type { DiscordEnvelope } from '../../../shared/types.js';
import { decideCallout, JevCalloutDecider, jevMessage } from '../decide.js';
import { ACTIONS, JevError, type Action, type JevDecisionSource, type JevVerdict } from '../jev.js';
import { readPatterns } from '../parseCallout.js';

const AT = '2026-10-02T14:00:00.000Z';

const envelope = (content: string): DiscordEnvelope => ({
  messageId: 'm-1',
  channelId: 'c-1',
  guildId: null,
  authorId: 'a-1',
  authorName: 'Caller',
  authorAvatarUrl: null,
  content,
  timestamp: AT,
});

const verdict = (choice: Action, probability: number, actingNow = 0.9): JevVerdict => ({
  model: 'jev-1.13.0',
  choice,
  probabilities: Object.fromEntries(
    ACTIONS.map((action) => [action, action === choice ? probability : (1 - probability) / 5])
  ) as Record<Action, number>,
  answerConfidence: probability,
  confidence: null,
  inputTokens: 600,
  actingNow,
});

const decide = (content: string, answer: JevVerdict) => decideCallout(readPatterns(envelope(content)), answer);

const WAXUI_ENTRY = '**LOTTO** SPX here 10/02 7735C Avg. 5.00';
const FREE_FORM_ENTRY = 'Grabbing some NVDA 190C 10/16 here';

describe('decideCallout — what never trades', () => {
  it('never trades an Average, even a confident one', () => {
    const callout = decide('➕ AVERAGING DOWN — SPY 772P · 0DTE\nAdded 10 @ $0.325', verdict('AVERAGE', 1));
    expect(callout.isCallout).toBe(false);
    expect(callout.rationale).toMatch(/averages are never traded/);
  });

  it.each(['INFO', 'NONE'] as const)('treats %s as no trade', (choice) => {
    expect(decide(WAXUI_ENTRY, verdict(choice, 0.95)).isCallout).toBe(false);
  });

  it('ignores anything below 0.6', () => {
    expect(decide(WAXUI_ENTRY, verdict('BUY', 0.55)).isCallout).toBe(false);
  });

  it('skips a Buy whose contract the patterns cannot read', () => {
    const callout = decide('Buying NVDA calls here', verdict('BUY', 0.95));
    expect(callout.isCallout).toBe(false);
    expect(callout.rationale).toMatch(/no complete options contract/);
  });
});

describe('decideCallout — the act-now check', () => {
  it('turns a free-form Buy that is not called now into no trade', () => {
    expect(decide(FREE_FORM_ENTRY, verdict('BUY', 0.95, 0.25)).isCallout).toBe(false);
    expect(decide(FREE_FORM_ENTRY, verdict('BUY', 0.95, 0.35)).isCallout).toBe(true);
  });

  it('skips the check when a fixed entry template matched', () => {
    expect(decide(WAXUI_ENTRY, verdict('BUY', 0.95, 0.1))).toMatchObject({ isCallout: true, action: 'buy' });
  });

  it('never gates exits', () => {
    expect(decide('Trimming NBIS 245 C 10/2\nValue: @2.85', verdict('TRIM', 0.9, 0.05)).isCallout).toBe(true);
  });
});

describe('decideCallout — routing by Jev probability', () => {
  it('trades 0.8 and above without review', () => {
    const callout = decide(WAXUI_ENTRY, verdict('BUY', 0.8));
    expect(callout).toMatchObject({ isCallout: true, engine: 'jev', confidence: 0.8 });
    expect(callout.reviewReason).toBeUndefined();
  });

  it('sends 0.6 up to 0.8 to approval', () => {
    expect(decide(WAXUI_ENTRY, verdict('BUY', 0.75)).reviewReason).toMatch(/Jev BUY 0\.75 \(waxui_entry\) is below 0\.8/);
  });
});

describe('decideCallout — the trade itself', () => {
  it("buys the template's contract at its stated price", () => {
    expect(decide(WAXUI_ENTRY, verdict('BUY', 0.9))).toMatchObject({
      action: 'buy',
      ticker: 'SPX',
      assetType: 'option',
      option: { optionType: 'call', strike: 7735, expiration: '2026-10-02' },
      orderType: 'limit',
      limitPrice: 5,
      isAddition: false,
    });
  });

  it("sells the caller's stated fraction on a Trim, and half when unstated", () => {
    const card = '✂️ TRIM +25% — SPY 773P · 0DTE\nSold **4 of 20** @ **$0.906** · **16** still running.';
    expect(decide(card, verdict('TRIM', 0.95)).exitPortion).toEqual({ kind: 'fraction', value: 0.2 });
    expect(decide('Trimming NBIS 245 C 10/2\nValue: @2.85', verdict('TRIM', 0.95)).exitPortion).toEqual({
      kind: 'fraction',
      value: 0.5,
    });
  });

  it('sells everything on a Sell, but keeps a stated fraction: size is never Jev\u2019s call', () => {
    expect(decide('🏁 SOLD ALL +38% — SPY 772P · 0DTE', verdict('SELL', 0.95)).exitPortion).toEqual({ kind: 'all' });
    expect(decide('Sold 4 of 20 SPY 773P 10/02', verdict('SELL', 0.95)).exitPortion).toEqual({
      kind: 'fraction',
      value: 0.2,
    });
  });

  it('leaves the contract of a contract-less exit to the pipeline', () => {
    expect(decide("Bishop's Ideas\nOut of SKHY for now", verdict('SELL', 0.9))).toMatchObject({
      isCallout: true,
      action: 'sell',
      ticker: 'SKHY',
      option: null,
      exitPortion: { kind: 'all' },
      engine: 'jev',
    });
  });
});

describe('jevMessage', () => {
  it('drops mentions and URLs, keeps link text, and collapses to one line', () => {
    expect(jevMessage('<@&123> hi <@456> <#789>\n[Open →](https://x.y/z) see https://a.b/c?d=1 end')).toBe(
      'hi Open → see end'
    );
  });
});

describe('JevCalloutDecider', () => {
  const source = (answer: JevVerdict | Error): JevDecisionSource & { ask: ReturnType<typeof vi.fn> } => ({
    ask: answer instanceof Error ? vi.fn().mockRejectedValue(answer) : vi.fn().mockResolvedValue(answer),
  });

  it('asks Jev about the cleaned message with the pattern hint as evidence', async () => {
    const jev = source(verdict('BUY', 0.9));
    await new JevCalloutDecider(jev).parse(envelope(`<@&1> ${WAXUI_ENTRY}`));
    expect(jev.ask).toHaveBeenCalledWith({
      message: WAXUI_ENTRY,
      pattern_match: { read: 'BUY', pattern: 'waxui_entry', contract: 'SPX 7735C 10/02' },
    });
  });

  it('surfaces a Jev failure as a typed error, so the message is recorded failed', async () => {
    const jev = source(new JevError('no answer within 1500 ms', 'timeout'));
    await expect(new JevCalloutDecider(jev).parse(envelope(WAXUI_ENTRY))).rejects.toBeInstanceOf(JevError);
  });

  it('does not ask Jev about an empty message', async () => {
    const jev = source(verdict('BUY', 0.9));
    expect((await new JevCalloutDecider(jev).parse(envelope('<@&1>  '))).isCallout).toBe(false);
    expect(jev.ask).not.toHaveBeenCalled();
  });
});
