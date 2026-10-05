/**
 * The Jev path's pattern pass: what the templates and filters read in a
 * message, and the `pattern_match` hint Jev sees. The format cases are the
 * Oct 4 test's own self-checks, so the port reads messages the way the
 * measured hints did.
 */
import { describe, expect, it } from 'vitest';

import type { DiscordEnvelope } from '../../../shared/types.js';
import { patternHint, readExitPortion, readPatterns } from '../parseCallout.js';

const AT = '2026-10-02T14:00:00.000Z';

const envelope = (content: string, timestamp = AT): DiscordEnvelope => ({
  messageId: 'm-1',
  channelId: 'c-1',
  guildId: null,
  authorId: 'a-1',
  authorName: 'Caller',
  authorAvatarUrl: null,
  content,
  timestamp,
});

const read = (content: string) => readPatterns(envelope(content));
const triple = (content: string) => {
  const { read: action, pattern, contractLabel } = read(content);
  return [action, pattern, contractLabel];
};

describe('readPatterns — caller formats', () => {
  it.each([
    ['*Swing Starter*\nSPXC here\n09/11 148C\nAvg. 2.40', ['BUY', 'waxui_entry', 'SPXC 148C 09/11']],
    ['Re-loading\nQQQ here\n09/29 737C\nAvg. 1.20', ['BUY', 'waxui_reload', 'QQQ 737C 09/29']],
    ["I'm Entering\n**Option:** FORM 140 C 10.16\n\n**Entry:** 5.90", ['BUY', 'bishop_entering', 'FORM 140C 10.16']],
    ['Trimming WMT 111 C 10.16\n**Value:** ***@2.80***', ['TRIM', 'bishop_trimming', 'WMT 111C 10.16']],
    ['🟢 BUY — NVDA 230C · Sep 23\nEntered', ['BUY', 'swift_buy_card', 'NVDA 230C Sep 23']],
    ['✂️ TRIM +25% — NVDA 230C · Sep 23\nSold **3 of 15** @ **$1.069**', ['TRIM', 'swift_trim_card', 'NVDA 230C Sep 23']],
    ['🏁 SOLD ALL +38% — SPY 772P · 0DTE', ['SELL', 'swift_sold_all_card', 'SPY 772P 0DTE']],
    ['➕ AVERAGING DOWN — SPY 772P · 0DTE', ['AVERAGE', 'swift_averaging_card', 'SPY 772P 0DTE']],
    [' RENENTERED NVDA 227.5C', ['BUY', 'reentered', 'NVDA 227.5C']],
    ['spy 761 P - .5 ', ['BUY', 'ticker_strike_dash_price', 'spy 761P']],
    ['Lotto 767P @ 20 ', ['BUY', 'contract_at_price', '767P']],
    ['Opened one more swing trade $INTC 140c 10/16 @4.30', ['BUY', 'contract_at_price', 'INTC 140C 10/16']],
  ])('%j', (content, expected) => {
    expect(triple(content)).toEqual(expected);
  });

  it('reads a whole-position Swift trim card as a Sell, per the user rule', () => {
    expect(triple('✂️ TRIM +25% — SPY 773P · 0DTE\nSold **15 of 15** · avg **$0.762** · **position closed**')).toEqual([
      'SELL',
      'swift_trim_closes_position',
      'SPY 773P 0DTE',
    ]);
    expect(read('✂️ TRIM -15% — SPY 774P · 0DTE\nSold **20 of 25** @ **$0.14** · **position closed**.').read).toBe('SELL');
    expect(read('✂️ TRIM +25% — SPY 773P · 0DTE\nSold **4 of 20** @ **$0.906** · **16** still running.').read).toBe('TRIM');
  });

  it('reads Average only from averaging words: Rowdy writes "Added" for new entries', () => {
    expect(read('Added Lotto 765P @ 27 ').read).toBe('BUY');
    expect(read('added 765P @ 28 ').read).toBe('BUY');
    expect(read('**adding into UPS 100C 11/20 @ 2.15**\n**cost avg is now 2.80 x2 cons**').read).toBe('AVERAGE');
    expect(read('Added more SPY 700C @ 1.10').read).toBe('AVERAGE');
  });

  it.each([
    'Added to SPY swing @1.60\nNew Avg. is 1.75.',
    'AAPL 345C @ 4.25 per\n> $100 gain/30%',
    'Lotto 772 @ 35',
    '**Cut U 44C 10/16 @ 1.1**\n**> $70 loss**',
    '> ↪️ replying to **Namrood**: BTO $SBUX 103c 06/12 @0.55\nStill in $SBUX !',
  ])('reads no template in %j', (content) => {
    expect(read(content).read).toBeNull();
  });
});

describe('readPatterns — the tradable contract', () => {
  it("takes Waxui's contract, date and Avg. entry price", () => {
    expect(read('**LOTTO** SPX here 10/02 7735C Avg. 5.00')).toMatchObject({
      ticker: 'SPX',
      option: { optionType: 'call', strike: 7735, expiration: '2026-10-02' },
      limitPrice: 5,
      positionSize: 'small',
    });
  });

  it("reads Bishop's OUST entry through the repo's labeled template", () => {
    const oust = read("I'm Entering\n**Option:** OUST 45 C 10/16\n**Entry:** 2.55");
    expect(oust).toMatchObject({
      read: 'BUY',
      pattern: 'repo_labeled_or_compact_entry',
      contractLabel: 'OUST 45C 2026-10-16',
      option: { optionType: 'call', strike: 45, expiration: '2026-10-16' },
      limitPrice: 2.55,
    });
  });

  it("dates Champsp's dateless line same-day and a Rowdy line from its one date token", () => {
    expect(read('spy 761 P - .5').option).toEqual({ optionType: 'put', strike: 761, expiration: '2026-10-02' });
    expect(read('Added Day / Swing Lotto 10/09 $SPY 782C @ 52')).toMatchObject({
      ticker: 'SPY',
      option: { optionType: 'call', strike: 782, expiration: '2026-10-09' },
      // "@ 52" is cents: ambiguous, so the order goes out at market.
      limitPrice: null,
    });
  });

  it('reads no tradable contract without a ticker or a date', () => {
    expect(read('Lotto 767P @ 20').option).toBeNull();
    expect(read('RENENTERED NVDA 227.5C')).toMatchObject({ ticker: 'NVDA', option: null });
  });

  it('completes a generic contract from the one date in the message, and refuses two contracts', () => {
    expect(read('Closing SPY 772C Oct 5 here').option).toEqual({
      optionType: 'call',
      strike: 772,
      expiration: '2026-10-05',
    });
    expect(read('Taking SPY 700C 10/16 and QQQ 600P 10/16').option).toBeNull();
  });

  it('keeps the ticker of a ticker-only exit and sells everything', () => {
    expect(read("Bishop's Ideas\nOut of SKHY for now")).toMatchObject({
      read: 'SELL',
      pattern: 'repo_out_of_ticker',
      ticker: 'SKHY',
      option: null,
      exitPortion: { kind: 'all' },
    });
  });
});

describe('readExitPortion', () => {
  it.each([
    ['Sold 4 of 20 @ $0.906 · 16 still running', { kind: 'fraction', value: 0.2 }],
    ['Sold 20 of 20', { kind: 'all' }],
    ['Sold 20 of 25 · position closed', { kind: 'all' }],
    ['SOLD ALL +38% — SPY 772P', { kind: 'all' }],
    ['Runners only from here', { kind: 'all_but_one' }],
    ['TRIM TRIM', { kind: 'all_but_one' }],
  ])('%j', (text, portion) => {
    expect(readExitPortion(text)).toEqual(portion);
  });

  it('never reads a profit figure as a fraction', () => {
    expect(readExitPortion('✂️ TRIM +25% — NVDA 230C · Sep 23')).toBeNull();
  });
});

describe('patternHint', () => {
  it('carries the read, the pattern and the contract, never a confidence', () => {
    expect(patternHint(read('🏁 SOLD ALL +38% — SPY 772P · 0DTE'))).toEqual({
      read: 'SELL',
      pattern: 'swift_sold_all_card',
      contract: 'SPY 772P 0DTE',
    });
  });

  it("flags Bishop's watchlist posts", () => {
    expect(patternHint(read("I'm looking at NBIS 250 C 10/16"))).toEqual({
      read: null,
      pattern: null,
      flags: ['watchlist'],
    });
  });

  it('flags a profit brag the parser would skip', () => {
    expect(patternHint(read('**130%** 🔥aapl calls 3.38 to 7.70 now!!!'))?.flags).toEqual(['profit_brag']);
  });

  it('is null when no template or filter fired', () => {
    expect(patternHint(read('NVDA looking strong into the close'))).toBeNull();
  });
});
