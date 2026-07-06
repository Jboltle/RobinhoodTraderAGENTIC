/**
 * Real Discord message shapes collected from the trading channel.
 * Each fixture documents what the LLM parser should produce — tests mock the
 * LLM to return `expectedCallout` and verify schema acceptance + key fields.
 */

import type { Callout, DiscordEnvelope } from '../../../../shared/types.js';

export type MessageCategory =
  | 'bto_entry'
  | 'trim_exit'
  | 'lotto_risky'
  | 'commentary'
  | 'hype'
  | 'status_update'
  | 'channel_noise';

export interface DiscordMessageFixture {
  readonly id: string;
  readonly category: MessageCategory;
  readonly description: string;
  readonly content: string;
  readonly authorName?: string;
  readonly timestamp?: string;
  /** What a correctly-behaving LLM should return for this message. */
  readonly expectedCallout: Callout;
}

const DEFAULT_TS = '2026-06-11T14:23:00.000Z';

export function envelopeFromFixture(f: DiscordMessageFixture): DiscordEnvelope {
  return {
    messageId: `fixture-${f.id}`,
    channelId: 'test-channel',
    guildId: 'test-guild',
    authorId: 'test-author',
    authorName: f.authorName ?? 'Namrood',
    content: f.content,
    timestamp: f.timestamp ?? DEFAULT_TS,
  };
}

// ---------------------------------------------------------------------------
// Entry signals (BTO / Buy To Open)
// ---------------------------------------------------------------------------

export const BTO_QQQ_PUT: DiscordMessageFixture = {
  id: 'bto-qqq-710p',
  category: 'bto_entry',
  description: 'BTO put with RISKY SIZE tag from Demon Alerts',
  content: 'BTO $QQQ 710p 06/08 0.97\n\nRISKY SIZE APPROPRIATE @Pro',
  authorName: 'Demon Alerts',
  timestamp: '2026-06-09T14:27:00.000Z',
  expectedCallout: {
    isCallout: true,
    assetType: 'option',
    action: 'buy',
    ticker: 'QQQ',
    orderType: 'limit',
    limitPrice: 0.97,
    sizeHint: null,
    positionSize: 'small',
    option: { optionType: 'put', strike: 710, expiration: '2026-06-08' },
    confidence: 0.94,
    rationale: 'BTO QQQ 710 put 06/08 at $0.97, risky size → small',
  },
};

export const BTO_SPY_0DTE: DiscordMessageFixture = {
  id: 'bto-spy-0dte',
  category: 'bto_entry',
  description: 'Buy To Open with full @Optionality header/footer',
  content: [
    '@Optionality | Monday - 06-15-2026  09:35 AM EST',
    '@Pro',
    'Buy To Open',
    'SPY 755C 0DTE $0.71',
    '@Namrood - LIVE DASHBOARD',
  ].join('\n'),
  expectedCallout: {
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
    rationale: 'BTO SPY 755C 0DTE $0.71',
  },
};

export const BTO_SBUX_CALL: DiscordMessageFixture = {
  id: 'bto-sbux-103c',
  category: 'bto_entry',
  description: 'Compact BTO format with @ limit price',
  content: 'BTO $SBUX 103c 06/12 @0.55',
  expectedCallout: {
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
    rationale: 'BTO SBUX 103 call 06/12 at $0.55',
  },
};

// ---------------------------------------------------------------------------
// Exit / management (TRIM, Close or Trim, RUNNERS ONLY)
// ---------------------------------------------------------------------------

export const TRIM_QQQ_FIRST: DiscordMessageFixture = {
  id: 'trim-qqq-707c-first',
  category: 'trim_exit',
  description: 'Namrood TRIM with P/L line — first trim at +10%',
  content: [
    '@Pro',
    'Close or Trim & Set SL to BE',
    'TRIM',
    '',
    'QQQ 707C 2026-06-11',
    '1.5900  →  1.75   P/L: +10.06% ($16.00)',
    '',
    '@Namrood - LIVE DASHBOARD',
    '',
    '@Optionality | Thursday - 06-11-2026  10:23 AM EST',
  ].join('\n'),
  timestamp: '2026-06-11T14:23:00.000Z',
  expectedCallout: {
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
    rationale: 'TRIM QQQ 707C — partial exit, P/L line is status only',
  },
};

export const TRIM_QQQ_DOUBLE: DiscordMessageFixture = {
  id: 'trim-qqq-707c-double',
  category: 'trim_exit',
  description: 'Repeated TRIM TRIM directive at +27%',
  content: [
    '@Pro',
    'Close or Trim & Set SL to BE',
    'TRIM TRIM',
    '',
    'QQQ 707C 2026-06-11',
    '1.5900  →  2.03   P/L: +27.67% ($44.00)',
    '',
    '@Namrood - LIVE DASHBOARD',
    '',
    '@Optionality | Thursday - 06-11-2026  10:24 AM EST',
  ].join('\n'),
  timestamp: '2026-06-11T14:24:00.000Z',
  expectedCallout: {
    isCallout: true,
    assetType: 'option',
    action: 'sell',
    ticker: 'QQQ',
    orderType: 'market',
    limitPrice: null,
    sizeHint: null,
    positionSize: 'full',
    option: { optionType: 'call', strike: 707, expiration: '2026-06-11' },
    confidence: 0.89,
    rationale: 'TRIM TRIM QQQ 707C — heavy trim, sell most and keep a runner',
  },
};

export const RUNNERS_ONLY_QQQ: DiscordMessageFixture = {
  id: 'runners-only-qqq-707c',
  category: 'trim_exit',
  description: 'RUNNERS ONLY — keep small remainder, sell most',
  content: [
    '@Pro',
    'Close or Trim & Set SL to BE',
    'RUNNERS ONLY',
    '',
    'QQQ 707C 2026-06-11',
    '1.5900  →  2.14   P/L: +34.59% ($55.00)',
    '',
    '@Namrood - LIVE DASHBOARD',
    '',
    '@Optionality | Thursday - 06-11-2026  10:25 AM EST',
  ].join('\n'),
  timestamp: '2026-06-11T14:25:00.000Z',
  expectedCallout: {
    isCallout: true,
    assetType: 'option',
    action: 'sell',
    ticker: 'QQQ',
    orderType: 'market',
    limitPrice: null,
    sizeHint: null,
    positionSize: 'full',
    option: { optionType: 'call', strike: 707, expiration: '2026-06-11' },
    confidence: 0.87,
    rationale: 'RUNNERS ONLY — sell most, keep runners; P/L line is status',
  },
};

export const TRIM_GOOGLE_MOST: DiscordMessageFixture = {
  id: 'trim-goog-most',
  category: 'trim_exit',
  description: '"Trimming most" with Close or Trim header',
  content: [
    'Trimming most',
    '',
    'Close or Trim & Set SL to BE',
    'GOOGL 370C 2026-06-18',
    '2.7500  →  5.1   P/L: +85.45% ($235.00)',
  ].join('\n'),
  expectedCallout: {
    isCallout: true,
    assetType: 'option',
    action: 'sell',
    ticker: 'GOOGL',
    orderType: 'market',
    limitPrice: null,
    sizeHint: null,
    positionSize: 'full',
    option: { optionType: 'call', strike: 370, expiration: '2026-06-18' },
    confidence: 0.85,
    rationale: 'Trimming most of GOOGL 370C',
  },
};

// ---------------------------------------------------------------------------
// Lotto / risky sizing
// ---------------------------------------------------------------------------

export const LOTTO_SPY_RISKY: DiscordMessageFixture = {
  id: 'lotto-spy-risky',
  category: 'lotto_risky',
  description: 'Lotto trade with sizing warning and @Pro noise',
  content: [
    '@Optionality | Friday - 06-12-2026  11:24 AM EST',
    '@Pro',
    '⚠️ Lotto Trade — RISKY',
    'SPY 745C 0DTE $1.7',
    '⚠️ Size for what you can afford to lose --- 1% of your account balance.',
    'Manage your risk!',
    '@Namrood - LIVE DASHBOARD',
  ].join('\n'),
  expectedCallout: {
    isCallout: true,
    assetType: 'option',
    action: 'buy',
    ticker: 'SPY',
    orderType: 'limit',
    limitPrice: 1.7,
    sizeHint: null,
    positionSize: 'small',
    option: { optionType: 'call', strike: 745, expiration: '2026-06-12' },
    confidence: 0.88,
    rationale: 'Lotto/risky → small position size',
  },
};

// ---------------------------------------------------------------------------
// Non-callouts: hype, commentary, status
// ---------------------------------------------------------------------------

export const HYPE_BANG: DiscordMessageFixture = {
  id: 'hype-bang',
  category: 'hype',
  description: 'Standalone "BANG!" with @Pro — no trade directive',
  content: 'BANG! @Pro',
  authorName: 'Demon Alerts',
  timestamp: '2026-06-09T14:27:00.000Z',
  expectedCallout: {
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
    rationale: 'hype exclamation, no trade directive',
  },
};

export const HYPE_BANGGGGG: DiscordMessageFixture = {
  id: 'hype-banggggg',
  category: 'hype',
  description: 'Extended BANGGGGG hype after a trade',
  content: 'BANGGGGG @Pro',
  authorName: 'Demon Alerts',
  timestamp: '2026-06-09T14:45:00.000Z',
  expectedCallout: {
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
    rationale: 'hype text, no actionable directive',
  },
};

export const HYPE_BANGERERRRRR: DiscordMessageFixture = {
  id: 'hype-bangererrrrr',
  category: 'hype',
  description: 'Motivational follow-up after entry',
  content: 'BANGERERRRRR! DONT LET IT GO RED @Pro',
  expectedCallout: {
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
    rationale: 'motivational hype, not a trade directive',
  },
};

export const COMMENTARY_BTFDD: DiscordMessageFixture = {
  id: 'commentary-btfdd',
  category: 'commentary',
  description: 'Meme commentary BTFDD — no ticker or action',
  content: 'BTFDD STONKS ONLY GO UP 🚀🚀 @Pro',
  authorName: 'Demon Alerts',
  timestamp: '2026-06-05T18:52:00.000Z',
  expectedCallout: {
    isCallout: false,
    assetType: 'equity',
    action: null,
    ticker: null,
    orderType: 'market',
    limitPrice: null,
    sizeHint: null,
    positionSize: null,
    option: null,
    confidence: 0.01,
    rationale: 'meme commentary, no trade directive',
  },
};

export const COMMENTARY_PORTFOLIO_RECAP: DiscordMessageFixture = {
  id: 'commentary-portfolio-recap',
  category: 'commentary',
  description: 'Past-tense portfolio recap mentioning tickers',
  content: [
    'Boys chasing moves like this won\'t often work thats why I did not do puts.',
    '',
    'Still we made 100% on both $AAPL and $CVS calls.. on a day where qqq goes near -5%',
    '',
    'I am loading the long term portfolio thanks for the discount 🚀❤️',
  ].join('\n'),
  authorName: 'Demon Alerts',
  timestamp: '2026-06-05T19:57:00.000Z',
  expectedCallout: {
    isCallout: false,
    assetType: 'equity',
    action: null,
    ticker: null,
    orderType: 'market',
    limitPrice: null,
    sizeHint: null,
    positionSize: null,
    option: null,
    confidence: 0.04,
    rationale: 'past-tense recap, no forward-looking buy/sell',
  },
};

export const COMMENTARY_FILL_COMPLAINT: DiscordMessageFixture = {
  id: 'commentary-fill-complaint',
  category: 'commentary',
  description: 'Fill price complaint — not a new order',
  content: 'everyone had MUCH better fill than me!! This dropped to .8 @Pro',
  expectedCallout: {
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
    rationale: 'fill complaint, not a trade directive',
  },
};

export const COMMENTARY_BANK_NEXT_WEEK: DiscordMessageFixture = {
  id: 'commentary-bank-next-week',
  category: 'commentary',
  description: 'Celebration text after trim sequence',
  content: 'LETS BANK NEXT WEEK! @Pro',
  expectedCallout: {
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
    rationale: 'celebration chatter, no trade directive',
  },
};

export const STATUS_STILL_IN: DiscordMessageFixture = {
  id: 'status-still-in',
  category: 'status_update',
  description: 'Holding update — not a new entry',
  content: 'Still in $SBUX ! @Pro',
  expectedCallout: {
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
    rationale: 'holding status, not a new trade',
  },
};

export const STATUS_PL_ONLY: DiscordMessageFixture = {
  id: 'status-pl-only',
  category: 'status_update',
  description: 'P/L update line without buy/sell verb',
  content: [
    'SPY 745C 2026-06-12',
    '1.7000  →  1.8   P/L: +5.88% ($10.00)',
    '',
    '@Namrood - LIVE DASHBOARD',
  ].join('\n'),
  expectedCallout: {
    isCallout: false,
    assetType: 'equity',
    action: null,
    ticker: null,
    orderType: 'market',
    limitPrice: null,
    sizeHint: null,
    positionSize: null,
    option: null,
    confidence: 0.08,
    rationale: 'P/L status only, no directive',
  },
};

export const STATUS_VIBES: DiscordMessageFixture = {
  id: 'status-vibes',
  category: 'commentary',
  description: 'Ticker comparison opinion',
  content: '$SBUX gives me $CVS vibes full transparency @Pro',
  expectedCallout: {
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
    rationale: 'opinion, no actionable directive',
  },
};

export const REPLY_STILL_IN_AFTER_BTO: DiscordMessageFixture = {
  id: 'reply-still-in-after-bto',
  category: 'status_update',
  description: 'Reply-thread follow-up after a BTO',
  content: '> ↪️ replying to **Namrood**: BTO $SBUX 103c 06/12 @0.55\nStill in $SBUX ! @Pro',
  expectedCallout: {
    isCallout: false,
    assetType: 'equity',
    action: null,
    ticker: null,
    orderType: 'market',
    limitPrice: null,
    sizeHint: null,
    positionSize: null,
    option: null,
    confidence: 0.08,
    rationale: 'reply follow-up holding update, not new entry',
  },
};

export const MESSAGE_WITH_ATTACHMENT_URL: DiscordMessageFixture = {
  id: 'bto-with-image-url',
  category: 'channel_noise',
  description: 'BTO signal with appended image URL from bot assembly',
  content: [
    'BTO $QQQ 710p 06/08 0.97',
    '',
    'RISKY SIZE APPROPRIATE @Pro',
    'https://cdn.discordapp.com/attachments/123456/chart.png',
  ].join('\n'),
  authorName: 'Demon Alerts',
  expectedCallout: {
    isCallout: true,
    assetType: 'option',
    action: 'buy',
    ticker: 'QQQ',
    orderType: 'limit',
    limitPrice: 0.97,
    sizeHint: null,
    positionSize: 'small',
    option: { optionType: 'put', strike: 710, expiration: '2026-06-08' },
    confidence: 0.93,
    rationale: 'BTO with image URL appended — signal still valid',
  },
};

/** All fixtures grouped for parameterized tests. */
export const ALL_FIXTURES: readonly DiscordMessageFixture[] = [
  BTO_QQQ_PUT,
  BTO_SPY_0DTE,
  BTO_SBUX_CALL,
  TRIM_QQQ_FIRST,
  TRIM_QQQ_DOUBLE,
  RUNNERS_ONLY_QQQ,
  TRIM_GOOGLE_MOST,
  LOTTO_SPY_RISKY,
  HYPE_BANG,
  HYPE_BANGGGGG,
  HYPE_BANGERERRRRR,
  COMMENTARY_BTFDD,
  COMMENTARY_PORTFOLIO_RECAP,
  COMMENTARY_FILL_COMPLAINT,
  COMMENTARY_BANK_NEXT_WEEK,
  STATUS_STILL_IN,
  STATUS_PL_ONLY,
  STATUS_VIBES,
  REPLY_STILL_IN_AFTER_BTO,
  MESSAGE_WITH_ATTACHMENT_URL,
];

export const ENTRY_FIXTURES = ALL_FIXTURES.filter((f) => f.category === 'bto_entry' || f.category === 'lotto_risky');
export const EXIT_FIXTURES = ALL_FIXTURES.filter((f) => f.category === 'trim_exit');
export const NON_CALLOUT_FIXTURES = ALL_FIXTURES.filter(
  (f) => f.category === 'commentary' || f.category === 'hype' || f.category === 'status_update'
);
