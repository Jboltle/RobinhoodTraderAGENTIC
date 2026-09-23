import { pattern, regex } from 'regex';
import { z } from 'zod';

import { createLlmProvider } from '../../shared/llm.js';
import { createLogger } from '../../shared/logger.js';
import {
  CalloutSchema,
  type Callout,
  type CalloutParser,
  type DiscordEnvelope,
  type LlmProvider,
  type OptionType,
  type PositionSize,
  type ToolJsonSchema,
} from '../../shared/types.js';

const log = createLogger('trader:parser');

// =============================================================================
// Tool contract (shared by every LLM provider)
// =============================================================================

const TOOL_NAME = 'report_callout';
const TOOL_DESCRIPTION =
  'Report the structured trading callout extracted from this Discord message.';

const TOOL_SCHEMA: ToolJsonSchema = {
  type: 'object',
  properties: {
    isCallout: { type: 'boolean' },
    assetType: { type: 'string', enum: ['equity', 'option'] },
    action: { type: ['string', 'null'], enum: ['buy', 'sell', null] },
    isAddition: {
      type: 'boolean',
      description:
        'True when this buy adds to a position the caller already holds (averaging down) rather than opening a fresh one.',
    },
    ticker: { type: ['string', 'null'] },
    orderType: { type: 'string', enum: ['market', 'limit'] },
    limitPrice: { type: ['number', 'null'] },
    sizeHint: {
      type: ['object', 'null'],
      properties: {
        kind: { type: 'string', enum: ['shares', 'usd', 'contracts'] },
        value: { type: 'number' },
      },
      required: ['kind', 'value'],
      additionalProperties: false,
    },
    positionSize: {
      type: ['string', 'null'],
      enum: ['small', 'medium', 'full', null],
    },
    option: {
      type: ['object', 'null'],
      properties: {
        optionType: { type: 'string', enum: ['call', 'put'] },
        strike: { type: 'number' },
        expiration: {
          type: 'string',
          description: 'ISO date YYYY-MM-DD resolved against the reference timestamp.',
        },
      },
      required: ['optionType', 'strike', 'expiration'],
      additionalProperties: false,
    },
    confidence: { type: 'number' },
    rationale: { type: 'string' },
  },
  required: [
    'isCallout',
    'assetType',
    'action',
    'isAddition',
    'ticker',
    'orderType',
    'limitPrice',
    'sizeHint',
    'positionSize',
    'option',
    'confidence',
    'rationale',
  ],
  additionalProperties: false,
};

// Residual prompt: the deterministic templates, pre-filters and Discord-noise
// stripping own every known message shape, so the model only sees leftovers.
// Everything the old 200-line prompt taught by example now lives in code.
const SYSTEM_PROMPT = `You classify Discord messages from a trading channel and extract one structured trading callout when — and only when — the message contains one. Machine-formatted alerts are parsed upstream; you only see the leftovers, which are mostly chatter.

A callout is an explicit, forward-looking directive to BUY or SELL a US equity or a single-leg US-listed option. Entry language ("buying", "entering", "I'm in", "adding", "grabbing") is a buy; exit language ("selling", "trimming", "closing", "taking profit", "fully out", "sold all", "stopped out") is a sell. Adding to an existing position ("averaging down", "added 10 more @ 0.30", "doubling down") is a buy with isAddition=true, priced at the newly added fill — never the resulting average. An already-expired contract is never a callout. Past-tense recaps, holding updates ("still in"), watchlists, hype, fill complaints and P/L status lines are NOT callouts.

A "Candidates" section may follow the message: contracts, prices and dates extracted deterministically from the message text. Prefer them. NEVER invent a ticker, strike, expiration or price that is not grounded in the message; when a required field cannot be grounded, set isCallout=false.

Rules:
- ticker: 1-6 uppercase letters. assetType is 'option' only for single-leg contracts; multi-leg spreads are NOT callouts.
- orderType is 'limit' only when an explicit price is stated. For options limitPrice is the per-contract PREMIUM — never the strike, and never a P/L arrow value ("1.59 -> 1.75" is status).
- option.expiration: ISO YYYY-MM-DD resolved against the Reference timestamp ("now"). If you cannot confidently resolve a future date, set isCallout=false.
- isAddition: true only when the buy extends a position the caller already says they hold; fresh entries use false.
- A caller reporting their own single-position exit ("fully out", "sold all +38%", "stopped out") IS a sell callout when the contract is identifiable — followers may still hold it. Multi-trade performance recaps are not.
- sizeHint only for explicit counts: shares ("100 shares"), usd ("$500 of AAPL"), contracts ("10 calls", "5x"). Never take sizeHint from the caller's own running totals ("10 → 20 contracts").
- positionSize from qualitative size words: small ("small", "light", "scalp", "starter", "lotto"), medium ("half", "partial"), full ("full size", "max", "load up", "all in"). Null when absent; ignore when sizeHint is present.
- confidence: 0.0 - 1.0. rationale: <=200 char summary (or why rejected).
- Always call the report_callout tool exactly once.`;

// =============================================================================
// Option-line grammar (Regex+)
//
// One set of named fragments composed into every matcher. Regex+ compiles to
// native RegExp with always-on flag v (strict escaping) and flag n (named
// groups only), plus free spacing so a contract line reads as a grammar
// instead of a 150-character blob. match.groups feeds OptionLineCaptureSchema.
// =============================================================================

const TICKER = pattern`\$? (?<ticker> [A-Z]{1,6} )`;
const STRIKE = pattern`(?<strike> \d+ (?: \. \d+ )? )`;
const CP = pattern`(?<cp> [CP] )`;
const EXPIRATION = pattern`
  (?<expiration>
      0DTE | TODAY
    | \d{4}-\d{2}-\d{2}
    | \d{1,2} / \d{1,2} (?: / \d{2,4} )?
  )
`;
const PREMIUM = pattern`(?: @ | \$ )? \s* (?<limit> \d+ (?: \. \d+ )? )`;

// "BTO SPY 755C 0DTE $0.71" / "BUY TO OPEN ... SPY 743P 0DTE 0.9" — run
// against whitespace-collapsed content starting at the BTO directive line.
const BTO_OPTION = regex('i')`
  ^ (?: BTO | BUY \s+ TO \s+ OPEN ) \b .*?
  ${TICKER} \s+ ${STRIKE} ${CP} \b \s+ ${EXPIRATION} \s+ ${PREMIUM}
`;

// "SPX 7500C - 4.8 - chase" — same-day scalp with an explicit premium and a
// risk keyword; expiration is implicitly 0DTE.
const CHASE_OPTION = regex('i')`
  ^ ${TICKER} \s+ ${STRIKE} ${CP} \b \s* [\-–—] \s* ${PREMIUM} \b
  .* \b (?: chase | starter | small | lotto | risk ) \b
`;

// One full contract on a single line: "KEEL 6c 8/21 1.15 fill".
const COMPACT_OPTION_LINE = regex('i')`
  ^ ${TICKER} \s+ ${STRIKE} ${CP} \b \s+ ${EXPIRATION} \s+ ${PREMIUM} (?: \b | \s )
`;

// "Option: GOOGL 380 C 7/24" inside an "I'm Entering" alert.
const LABELED_OPTION_LINE = regex('im')`
  ^ \s* Option \s* : \s* ${TICKER} \s+ ${STRIKE} \s*
  (?<cp> [CP] | calls? | puts? ) \s+ ${EXPIRATION} \s* $
`;

// "Entry: @1.20" / "Entry: 5.55-5.60" (a range fills at the top of the range).
const LABELED_ENTRY_LINE = regex('im')`
  ^ \s* Entry \s* : \s* (?: @ | \$ )? \s* (?<limit> \d+ (?: \. \d+ )? )
  (?: \s* [\-–—] \s* (?: @ | \$ )? \s* (?<limitHigh> \d+ (?: \. \d+ )? ) )?
  \s* $
`;

// Contract line inside a "Close or Trim" exit alert: "SPY 743P 2026-07-20".
// Deliberately case-sensitive — these lines are machine-generated uppercase.
const TRIM_EXIT_CONTRACT_LINE = regex`
  ^ ${TICKER} \s+ ${STRIKE} ${CP} \b \s+ ${EXPIRATION} \s* $
`;

// Loose contract shape used for LLM candidates and pre-filter guards. Accepts
// word forms ("180 puts") and makes expiration/premium optional. Built via a
// helper because one source pattern is compiled with and without /g.
const contractPattern = (flags: string): RegExp => regex(flags)`
  ${TICKER} \s+ ${STRIKE} \s* (?<cpWord> [CP] \b | calls? \b | puts? \b )
  (?: \s+ ${EXPIRATION} )? (?: \s+ ${PREMIUM} )?
`;
const CONTRACT_SCAN = contractPattern('gi');
const CONTRACT_TEST = contractPattern('i');

// Every expiration token the deterministic resolver understands, for grounding
// the LLM's resolved date against the message text.
const EXPIRATION_TOKEN_SCAN = regex('gi')`
  \b (?<token>
      0DTE | TODAY
    | NEXT \s+ FRIDAY | FRIDAY
    | WEEKLIES | WEEKLY | MONTHLY | EOY | LEAPS?
    | \d{4}-\d{2}-\d{2}
    | \d{1,2} / \d{1,2} (?: / \d{2,4} )?
    | (?: JAN | FEB | MAR | APR | MAY | JUN | JUL | AUG | SEP | OCT | NOV | DEC )
      [A-Za-z]* \.? \s? \d{1,2} (?! \s* / ) (?: \s* ,? \s* '? \d{2,4} )?
  ) \b
`;

// =============================================================================
// Capture assembly (Zod)
//
// Regex+ finds tokens; Zod turns named groups into typed contract fields and
// rejects anything malformed. CalloutSchema stays the single output seam.
// =============================================================================

/** Drop non-participating groups so optional schema fields stay `undefined`. */
const compactGroups = (
  groups: Record<string, string | undefined>
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(groups).filter(([, value]) => value !== undefined)
  ) as Record<string, string>;

const OptionLineCaptureSchema = z
  .object({
    ticker: z.string().min(1),
    strike: z.string().regex(/^\d+(?:\.\d+)?$/),
    cp: z.string().min(1),
    expiration: z.string().min(1).optional(),
    limit: z.string().regex(/^\d+(?:\.\d+)?$/).optional(),
  })
  .transform((capture) => {
    const cpLetter = capture.cp[0]!.toUpperCase();
    return {
      ticker: capture.ticker.toUpperCase(),
      strike: Number(capture.strike),
      optionType: cpLetter === 'C' ? ('call' as const) : ('put' as const),
      expirationRaw: capture.expiration ?? null,
      limitRaw: capture.limit ?? null,
      limitPrice: capture.limit === undefined ? null : Number(capture.limit),
      contractLabel: `${capture.strike}${cpLetter}`,
    };
  });

type OptionLineCapture = z.output<typeof OptionLineCaptureSchema>;

/**
 * Fill the structural fields a strict `CalloutSchema` requires when the model
 * omits them. Models frequently return a partial object for plain chatter
 * (e.g. missing `assetType`/`orderType`); filling the shape lets a non-callout
 * validate on the first attempt instead of forcing a repair retry and then
 * dropping the message. Invalid enum *values* are left untouched so the schema
 * still rejects genuinely malformed output.
 */
const LlmCalloutInputSchema = z.preprocess((raw) => {
  if (typeof raw !== 'object' || raw === null) return raw;
  const r = raw as Record<string, unknown>;
  const hasOption = typeof r.option === 'object' && r.option !== null;
  return {
    isCallout: typeof r.isCallout === 'boolean' ? r.isCallout : false,
    assetType: r.assetType ?? (hasOption ? 'option' : 'equity'),
    action: r.action ?? null,
    isAddition: typeof r.isAddition === 'boolean' ? r.isAddition : false,
    ticker: r.ticker ?? null,
    orderType: r.orderType ?? 'market',
    limitPrice: r.limitPrice ?? null,
    sizeHint: r.sizeHint ?? null,
    positionSize: r.positionSize ?? null,
    option: r.option ?? null,
    confidence: typeof r.confidence === 'number' ? r.confidence : 0,
    rationale: typeof r.rationale === 'string' ? r.rationale : '',
  };
}, CalloutSchema);

const NON_CALLOUT_DEFAULTS = {
  isCallout: false,
  assetType: 'equity',
  action: null,
  ticker: null,
  orderType: 'market',
  limitPrice: null,
  sizeHint: null,
  positionSize: null,
  option: null,
  confidence: 0,
} as const;

function buildNonCallout(rationale: string): Callout {
  return CalloutSchema.parse({ ...NON_CALLOUT_DEFAULTS, rationale });
}

// =============================================================================
// Shared language helpers
// =============================================================================

// Mention/header noise lines the bot channels prepend or append to alerts:
// "@Pro", "@Namrood - LIVE DASHBOARD", "@Optionality | Monday - ...".
// Deliberately narrow: a line that mixes a mention with real signal
// ("@Pro BTO SPY ...") is kept.
const NOISE_LINE = /^(?:@\S+|@.+\bLIVE DASHBOARD\b.*|@\S+\s*\|.+)$/i;

// The buy directive, anchored to the start of its own line — alerts may carry
// author names, role mentions, or headers above it.
const BTO_DIRECTIVE_LINE = /^\s*(?:BTO|BUY\s+TO\s+OPEN)\b/i;

// Qualitative size language, one list shared by templates, exits and the LLM
// candidates block. Order matters: heavy-exit phrasing ("TRIM TRIM") must win
// over its partial substring ("trim").
const SIZE_FULL =
  /\bfull(?:\s+(?:size|send))?\b|\bmax\b|\bheavy\b|\bload(?:ing)?\s+up\b|\ball\s+in\b|\btrim\s+trim\b|\btrim(?:ming)?\s+most\b|\brunners?\s+only\b|\bclos(?:e|ing)\s+(?:all|full|it\s+all|everything)\b/i;
const SIZE_MEDIUM = /\bmedium\b|\bhalf(?:\s+size)?\b|\bpartial\b|\btrim\b/i;
const SIZE_SMALL =
  /\bsmall\b|\blight\b|\bquick\b|\bscalp\b|\btiny\b|\bstarter\b|\brisky\b|\blotto\b/i;

function classifyPositionSize(text: string): PositionSize | null {
  if (SIZE_FULL.test(text)) return 'full';
  if (SIZE_MEDIUM.test(text)) return 'medium';
  if (SIZE_SMALL.test(text)) return 'small';
  return null;
}

/**
 * Split content into lines with reply quotes, mention/header noise and
 * markdown emphasis removed — the author's own words, nothing else. Shared by
 * the deterministic templates and the language pre-filters.
 */
function stripNoiseLines(content: string): string[] {
  return content
    .replace(/\r\n?/g, '\n')
    .split('\n')
    // Markdown emphasis ("**Buy To Open**") must not hide a directive.
    .map((line) => line.replace(/\*\*|__|`/g, ''))
    .filter((line) => !line.trimStart().startsWith('>'))
    .filter((line) => !NOISE_LINE.test(line.trim()));
}

/**
 * The message as the LLM should see it: mention/header noise removed, but
 * reply quotes and markdown kept — they are context the model can use.
 */
function stripNoiseLinesForLlm(content: string): string {
  return content
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => !NOISE_LINE.test(line.trim()))
    .join('\n')
    .trim();
}

// =============================================================================
// Deterministic templates
// =============================================================================

function tryParseDeterministicCallout(envelope: DiscordEnvelope): Callout | null {
  const contentLines = stripNoiseLines(envelope.content);
  const ownContent = contentLines.join('\n');
  const collapse = (text: string): string =>
    text.replace(/[\u2192\u21d2]/g, ' -> ').replace(/\s+/g, ' ').trim();
  const normalized = collapse(ownContent);

  const btoLineIndex = contentLines.findIndex((line) => BTO_DIRECTIVE_LINE.test(line));
  const btoContent =
    btoLineIndex === -1 ? normalized : collapse(contentLines.slice(btoLineIndex).join('\n'));

  return (
    parseBtoOption(btoContent, envelope.timestamp) ??
    parseChaseOption(normalized, envelope.timestamp) ??
    parseCompactOptionLine(ownContent, envelope.timestamp) ??
    parseLabeledEntryOption(ownContent, envelope.timestamp) ??
    parseLottoOption(ownContent, envelope.timestamp) ??
    parseTrimExitOption(ownContent, envelope.timestamp)
  );
}

function parseBtoOption(content: string, timestamp: string): Callout | null {
  const match = content.match(BTO_OPTION);
  if (!match?.groups) return null;
  return buildDeterministicOptionCallout({
    groups: match.groups,
    timestamp,
    content,
    rationalePrefix: 'BTO',
  });
}

function parseChaseOption(content: string, timestamp: string): Callout | null {
  const match = content.match(CHASE_OPTION);
  if (!match?.groups) return null;
  return buildDeterministicOptionCallout({
    groups: { ...match.groups, expiration: '0DTE' },
    timestamp,
    content,
    rationalePrefix: 'CHASE',
  });
}

function parseCompactOptionLine(content: string, timestamp: string): Callout | null {
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (!/\b(?:fill|entry)\b/i.test(line)) continue;
    const match = line.match(COMPACT_OPTION_LINE);
    if (!match?.groups) continue;
    return buildDeterministicOptionCallout({
      groups: match.groups,
      timestamp,
      content: line,
      rationalePrefix: 'ENTRY',
    });
  }
  return null;
}

function parseLabeledEntryOption(content: string, timestamp: string): Callout | null {
  if (!/\b(?:entering|entry)\b/i.test(content)) return null;

  const optionMatch = content.match(LABELED_OPTION_LINE);
  if (!optionMatch?.groups) return null;

  // Entry price is optional: "Entry: @1.20" -> limit order; absent -> market
  // order (execution sizes off the live mark price). A range fills at the top.
  const entryMatch = content.match(LABELED_ENTRY_LINE);
  const limitRaw = entryMatch?.groups
    ? (entryMatch.groups.limitHigh ?? entryMatch.groups.limit)
    : undefined;

  return buildDeterministicOptionCallout({
    groups: {
      ...optionMatch.groups,
      ...(limitRaw !== undefined ? { limit: limitRaw } : {}),
    },
    timestamp,
    content,
    rationalePrefix: 'ENTRY',
  });
}

// Lotto/risky alerts carry a bare contract line with a premium but no BTO
// verb: "⚠️ Lotto Trade — RISKY" / "SPY 745C 0DTE $1.7". Bot-templated, so
// depending on the LLM for them is pure downside.
const LOTTO_KEYWORD = /\b(?:lotto|risky)\b/i;

function parseLottoOption(content: string, timestamp: string): Callout | null {
  if (!LOTTO_KEYWORD.test(content)) return null;

  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const match = line.match(COMPACT_OPTION_LINE);
    if (!match?.groups) continue;
    return buildDeterministicOptionCallout({
      groups: match.groups,
      timestamp,
      content,
      rationalePrefix: 'LOTTO',
    });
  }
  return null;
}

// Bot-generated exit alerts always carry this fixed header line.
const TRIM_EXIT_HEADER = /^\s*Close\s+or\s+Trim\b/im;

/**
 * Deterministic parser for the bot's "Close or Trim & Set SL to BE" exit
 * alerts. These are machine-generated with a fixed shape, so relying on the
 * LLM for them is pure downside: a provider outage turns a routine trim into
 * a parser_error and the exit is missed. The P/L arrow line ("0.90 → 1.06")
 * is status only and must never become a limit price — exits go out as
 * market orders.
 */
function parseTrimExitOption(content: string, timestamp: string): Callout | null {
  if (!TRIM_EXIT_HEADER.test(content)) return null;

  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const contractMatch = lines
    .map((line) => line.match(TRIM_EXIT_CONTRACT_LINE))
    .find((match) => match !== null);
  if (!contractMatch?.groups) return null;

  const capture = OptionLineCaptureSchema.safeParse(compactGroups(contractMatch.groups));
  if (!capture.success) return null;
  const contract = capture.data;
  if (contract.expirationRaw === null) return null;

  const expiration = resolveDeterministicExpiration(contract.expirationRaw, timestamp);
  if (!expiration) return null;

  // Size keywords live on their own directive line ("TRIM TRIM", "Trim some",
  // "RUNNERS ONLY"). The header itself contains "Trim", so exclude it — a
  // header-only alert has no size qualifier.
  const directiveText = lines
    .filter((line) => !TRIM_EXIT_HEADER.test(line) && !TRIM_EXIT_CONTRACT_LINE.test(line))
    .join('\n');

  const candidate = {
    isCallout: true,
    assetType: 'option',
    action: 'sell',
    ticker: contract.ticker,
    orderType: 'market',
    limitPrice: null,
    sizeHint: null,
    positionSize: classifyPositionSize(directiveText),
    option: {
      optionType: contract.optionType,
      strike: contract.strike,
      expiration,
    },
    confidence: 0.99,
    rationale: `TRIM ${contract.ticker} ${contract.contractLabel} ${contract.expirationRaw} — Close or Trim exit, P/L line is status only`,
  };

  const parsed = CalloutSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function buildDeterministicOptionCallout(opts: {
  groups: Record<string, string | undefined>;
  timestamp: string;
  /** Text scanned for qualitative size keywords. */
  content: string;
  rationalePrefix: string;
}): Callout | null {
  const capture = OptionLineCaptureSchema.safeParse(compactGroups(opts.groups));
  if (!capture.success) return null;
  const contract = capture.data;
  if (contract.expirationRaw === null) return null;

  const expiration = resolveDeterministicExpiration(contract.expirationRaw, opts.timestamp);
  if (!expiration) return null;

  const hasLimit = contract.limitPrice !== null;
  const candidate = {
    isCallout: true,
    assetType: 'option',
    action: 'buy',
    ticker: contract.ticker,
    orderType: hasLimit ? 'limit' : 'market',
    limitPrice: contract.limitPrice,
    sizeHint: null,
    positionSize: classifyPositionSize(opts.content),
    option: {
      optionType: contract.optionType,
      strike: contract.strike,
      expiration,
    },
    confidence: 0.99,
    rationale: [
      opts.rationalePrefix,
      contract.ticker,
      contract.contractLabel,
      contract.expirationRaw,
      hasLimit ? 'at $' + contract.limitRaw : 'at market',
    ].join(' '),
  };

  const parsed = CalloutSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

// =============================================================================
// Expiration resolution
// =============================================================================

const toIsoDate = (date: Date): string => date.toISOString().slice(0, 10);

const utcDateOnly = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

const FRIDAY = 5;

const MONTH_NAMES = [
  'JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
  'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER',
] as const;

function nextFridayOnOrAfter(reference: Date): Date {
  const date = utcDateOnly(reference);
  date.setUTCDate(date.getUTCDate() + ((FRIDAY - date.getUTCDay() + 7) % 7));
  return date;
}

function thirdFriday(year: number, monthIndex: number): Date {
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const offsetToFriday = (FRIDAY - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, monthIndex, 1 + offsetToFriday + 14));
}

function lastFridayOfDecember(year: number): Date {
  const date = new Date(Date.UTC(year, 11, 31));
  date.setUTCDate(31 - ((date.getUTCDay() - FRIDAY + 7) % 7));
  return date;
}

/**
 * Resolve an expiration token to ISO YYYY-MM-DD against the message timestamp.
 * Understands the same aliases the old prompt taught the model: 0DTE/today,
 * Friday/weeklies, next Friday, monthly, EOY, leaps, M/D and ISO dates.
 */
function resolveDeterministicExpiration(raw: string, referenceTimestamp: string): string | null {
  const upper = raw.toUpperCase().replace(/\s+/g, ' ').trim();
  const reference = new Date(referenceTimestamp);
  if (!Number.isFinite(reference.getTime())) return null;

  if (upper === '0DTE' || upper === 'TODAY') {
    return toIsoDate(utcDateOnly(reference));
  }

  if (upper === 'FRIDAY' || upper === 'WEEKLY' || upper === 'WEEKLIES') {
    return toIsoDate(nextFridayOnOrAfter(reference));
  }

  if (upper === 'NEXT FRIDAY') {
    const friday = nextFridayOnOrAfter(reference);
    friday.setUTCDate(friday.getUTCDate() + 7);
    return toIsoDate(friday);
  }

  if (upper === 'MONTHLY') {
    const thisMonth = thirdFriday(reference.getUTCFullYear(), reference.getUTCMonth());
    if (thisMonth.getTime() >= utcDateOnly(reference).getTime()) return toIsoDate(thisMonth);
    return toIsoDate(thirdFriday(reference.getUTCFullYear(), reference.getUTCMonth() + 1));
  }

  if (upper === 'EOY') {
    return toIsoDate(lastFridayOfDecember(reference.getUTCFullYear()));
  }

  if (upper === 'LEAP' || upper === 'LEAPS') {
    // January monthly expiration at least one year out.
    const oneYearOut = utcDateOnly(reference);
    oneYearOut.setUTCFullYear(oneYearOut.getUTCFullYear() + 1);
    let year = reference.getUTCFullYear() + 1;
    while (thirdFriday(year, 0).getTime() < oneYearOut.getTime()) year += 1;
    return toIsoDate(thirdFriday(year, 0));
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  // Month-name dates: "Sep 23", "Sep23", "September 23, 2026", "Dec 19 '25".
  // Yearless forms resolve to the nearest on-or-after occurrence — callers
  // only alert live contracts, so a past date this year means next year.
  const monthDay = upper.match(/^([A-Z]{3,9})\.?\s?(\d{1,2})(?:\s*,?\s*'?(\d{2,4}))?$/);
  if (monthDay) {
    const monthIndex = MONTH_NAMES.findIndex(
      (name) => name.startsWith(monthDay[1]!) && monthDay[1]!.length >= 3
    );
    if (monthIndex === -1) return null;
    const day = Number(monthDay[2]);
    const year = monthDay[3]
      ? Number(monthDay[3].length === 2 ? '20' + monthDay[3] : monthDay[3])
      : reference.getUTCFullYear();
    let date = new Date(Date.UTC(year, monthIndex, day));
    if (date.getUTCMonth() !== monthIndex || date.getUTCDate() !== day) return null;
    if (!monthDay[3] && date.getTime() < utcDateOnly(reference).getTime()) {
      date = new Date(Date.UTC(year + 1, monthIndex, day));
    }
    return toIsoDate(date);
  }

  const parts = raw.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (!parts) return null;

  const month = Number(parts[1]);
  const day = Number(parts[2]);
  const refYear = reference.getUTCFullYear();
  const year = parts[3]
    ? Number(parts[3].length === 2 ? '20' + parts[3] : parts[3])
    : refYear;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return toIsoDate(date);
}

// =============================================================================
// Pre-LLM gates
// =============================================================================

// A standalone 1-5 letter uppercase token, optionally $-prefixed, not glued to
// other letters. Matches "SPY", "$QQQ", "NVDA"; ignores "@Pro", "0DTE", prose.
const TICKER_LIKE = /(?:^|[^A-Za-z0-9$])\$?[A-Z]{1,5}(?![A-Za-z])/;

// Words that plausibly signal a buy/sell/manage directive. Deliberately broad:
// a false positive just means we still ask the LLM (safe), whereas a false
// negative would skip a real callout (unsafe).
const TRADE_VERB =
  /\b(?:buy|buys|buying|bought|sell|sells|selling|sold|bto|btc|stc|sto|long|short|trim|trimming|close|closing|closed|add|adds|adding|scale|scaling|enter|entering|entered|entry|grab|grabbing|took|take|taking|chase|chasing|load|loading|lotto|call|calls|put|puts|leap|leaps|runner|runners)\b/i;

/**
 * Conservative pre-LLM gate: a message can only be a callout if it contains a
 * ticker-like token or a trade verb. When it has neither (pure hype, emoji, or
 * a bare P/L line) we can safely classify it as a non-callout without spending
 * an LLM call. Biased toward calling the LLM — only obvious chatter is skipped.
 */
function messageHasTradeSignal(content: string): boolean {
  return TICKER_LIKE.test(content) || TRADE_VERB.test(content);
}

// P/L-brag openers like "**130%** 🔥aapl calls 3.38 to 7.70 now!!!" — a bold
// percentage leads the message.
const BOLD_PCT_START = /^\s*\*\*\s*\+?\d+(?:\.\d+)?\s*%\s*\*\*/;

// "3.38 to 7.70 now" — entry-price-to-current-price update phrasing.
const PRICE_TO_PRICE_NOW = /\b\d+(?:\.\d+)?\s+to\s+\d+(?:\.\d+)?\s+now\b/i;

// Words that signal an actual directive. Narrower than TRADE_VERB on purpose:
// brags say "calls"/"puts" without any of these, while real entries always
// carry one. Presence of any directive word sends the message to the LLM.
const DIRECTIVE_VERB =
  /\b(?:bto|btc|sto|stc|buy|buying|sell|selling|enter|entering|entered|entry|add|adding|trim|trimming|close|closing|long|short|grab|grabbing|chase|chasing|load|loading|scale|scaling|take|taking)\b/i;

/**
 * Detect profit-brag / P/L-update messages ("**130%** 🔥aapl calls 3.38 to
 * 7.70 now!!! 🚀") so they never reach the LLM, which has misread them as
 * fresh entries. Conservative: only fires when the brag shape is present AND
 * no directive verb appears anywhere in the message.
 */
function isProfitBrag(content: string): boolean {
  return (
    (BOLD_PCT_START.test(content) || PRICE_TO_PRICE_NOW.test(content)) &&
    !DIRECTIVE_VERB.test(content)
  );
}

// Language shapes the old prompt taught by example; the parser owns them now.
// Every entry is guarded by "no directive verb anywhere in the author's own
// words", and most are additionally disarmed when a contract-like token is
// present (the P/L filter must fire despite one — that is its whole point).
interface LanguagePrefilter {
  readonly name: string;
  readonly test: RegExp;
  readonly firesDespiteContract: boolean;
}

const LANGUAGE_PREFILTERS: readonly LanguagePrefilter[] = [
  {
    name: 'P/L status update',
    test: /\d(?:\.\d+)?\s*(?:→|⇒|->)\s*\d|\bP\/L\b/i,
    firesDespiteContract: true,
  },
  {
    name: 'hype/commentary',
    test: /\bBANG\w*\b|\bBTFD\w*\b|\bLFG\w*\b|\bLETS\s+BANK\b/i,
    firesDespiteContract: false,
  },
  {
    name: 'holding update',
    test: /\bstill\s+in\b/i,
    firesDespiteContract: false,
  },
  {
    name: 'watchlist mention',
    test: /\bwatching\b/i,
    firesDespiteContract: false,
  },
  {
    name: 'opinion/comparison',
    test: /\bvibes?\b/i,
    firesDespiteContract: false,
  },
  {
    name: 'fill complaint',
    test: /\bbetter\s+fill\b|\bfill\s+than\b/i,
    firesDespiteContract: false,
  },
  {
    name: 'past-tense recap',
    test: /\b(?:we|i)\s+made\s+\d+(?:\.\d+)?\s*%/i,
    firesDespiteContract: false,
  },
];

// A recap header marks the whole message as history. It outranks the
// directive-verb disarm below because recap bodies quote the day's entries
// and exits verbatim ("$AAPL 345C @ 1.77 --> 3.92 | +121.75%"), which the LLM
// has misread as a fresh bullish entry.
const RECAP_HEADER = /\bDAILY\s+RECAP\b/i;

/**
 * Classify obvious non-callout language without the LLM. Runs on the author's
 * own words (quotes/noise stripped). Conservative by construction: any
 * directive verb disarms every filter, and a contract-like token disarms all
 * but the P/L filter, so a real entry always reaches a parser or the model.
 */
function matchLanguagePrefilter(languageContent: string): string | null {
  if (RECAP_HEADER.test(languageContent)) return 'daily recap header';
  if (DIRECTIVE_VERB.test(languageContent)) return null;
  const hasContract = CONTRACT_TEST.test(languageContent);
  for (const filter of LANGUAGE_PREFILTERS) {
    if (!filter.firesDespiteContract && hasContract) continue;
    if (filter.test.test(languageContent)) return filter.name;
  }
  return null;
}

// =============================================================================
// LLM candidates + grounding
// =============================================================================

interface ContractCandidate {
  readonly ticker: string;
  readonly strike: number;
  readonly optionType: OptionType;
  readonly expiration: string | null;
  readonly premium: number | null;
}

function extractContractCandidates(content: string, timestamp: string): ContractCandidate[] {
  const candidates: ContractCandidate[] = [];
  for (const match of content.matchAll(CONTRACT_SCAN)) {
    const groups = match.groups ?? {};
    const capture = OptionLineCaptureSchema.safeParse(
      compactGroups({ ...groups, cp: groups.cpWord })
    );
    if (!capture.success) continue;
    const contract = capture.data;
    candidates.push({
      ticker: contract.ticker,
      strike: contract.strike,
      optionType: contract.optionType,
      expiration:
        contract.expirationRaw === null
          ? null
          : resolveDeterministicExpiration(contract.expirationRaw, timestamp),
      premium: contract.limitPrice,
    });
  }
  return candidates;
}

/** Every resolvable expiration token in the message, as token -> ISO date. */
function extractExpirationTokens(content: string, timestamp: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const match of content.matchAll(EXPIRATION_TOKEN_SCAN)) {
    const token = match.groups?.token;
    if (!token || tokens.has(token.toLowerCase())) continue;
    const resolved = resolveDeterministicExpiration(token, timestamp);
    if (resolved) tokens.set(token.toLowerCase(), resolved);
  }
  return tokens;
}

/**
 * Deterministic extraction shared with the model: it should pick from these
 * (or ground fields in the literal text) instead of inventing values.
 */
function buildCandidatesBlock(content: string, timestamp: string): string {
  const lines: string[] = [];

  const contracts = extractContractCandidates(content, timestamp);
  for (const contract of contracts) {
    lines.push(
      `- contract: ${contract.ticker} ${contract.strike}${contract.optionType === 'call' ? 'C' : 'P'}` +
        (contract.expiration ? ` expiration=${contract.expiration}` : '') +
        (contract.premium !== null ? ` premium=${contract.premium}` : '')
    );
  }

  const expirations = extractExpirationTokens(content, timestamp);
  if (expirations.size > 0) {
    lines.push(
      '- expiration tokens: ' +
        [...expirations].map(([token, iso]) => `"${token}" -> ${iso}`).join(', ')
    );
  }

  const size = classifyPositionSize(content);
  if (size) lines.push(`- size keywords suggest positionSize=${size}`);

  if (lines.length === 0) return 'Candidates: none extracted from the message text.';
  return [
    'Candidates (extracted deterministically from the message; ground every field in these or the message text, otherwise set isCallout=false):',
    ...lines,
  ].join('\n');
}

/** True when `value` equals any numeric token in the message ("0.9000" ≙ 0.9). */
function numberAppearsIn(content: string, value: number): boolean {
  for (const match of content.matchAll(/\d+(?:\.\d+)?|(?<!\d)\.\d+/g)) {
    if (Number(match[0]) === value) return true;
  }
  return false;
}

function tickerAppearsIn(content: string, ticker: string): boolean {
  // Tickers passed CalloutSchema's [A-Z][A-Z0-9]{0,5} shape — regex-safe.
  return new RegExp(`(?<![A-Za-z0-9])\\$?${ticker}(?![A-Za-z])`, 'i').test(content);
}

function expirationIsGrounded(expiration: string, content: string, timestamp: string): boolean {
  const reference = new Date(timestamp);
  // A message with no date token defaults to 0DTE — same-day is always allowed.
  if (
    Number.isFinite(reference.getTime()) &&
    toIsoDate(utcDateOnly(reference)) === expiration
  ) {
    return true;
  }

  for (const match of content.matchAll(EXPIRATION_TOKEN_SCAN)) {
    const token = match.groups?.token;
    if (!token) continue;
    if (resolveDeterministicExpiration(token, timestamp) === expiration) return true;
    // A yearless M/D is "nearest future" to the model; accept next year too.
    const monthDay = token.match(/^(\d{1,2})\/(\d{1,2})$/);
    if (monthDay) {
      const nextYear = new Date(reference);
      nextYear.setUTCFullYear(reference.getUTCFullYear() + 1);
      if (resolveDeterministicExpiration(token, nextYear.toISOString()) === expiration) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Post-validate an isCallout=true LLM result against the message it came
 * from: every tradable field must be grounded in the text (or resolvable from
 * a token in it). An invented ticker, strike, expiration or price is exactly
 * the failure mode that turns chatter into a live order — refuse to trade on
 * it. Returns a human-readable reason, or null when grounded.
 */
function findLlmGroundingError(
  callout: Callout,
  content: string,
  timestamp: string
): string | null {
  if (callout.ticker && !tickerAppearsIn(content, callout.ticker)) {
    return `ticker ${callout.ticker} does not appear in the message`;
  }
  if (callout.limitPrice !== null && !numberAppearsIn(content, callout.limitPrice)) {
    return `limit price ${callout.limitPrice} does not appear in the message`;
  }
  if (callout.option) {
    if (!numberAppearsIn(content, callout.option.strike)) {
      return `strike ${callout.option.strike} does not appear in the message`;
    }
    if (!expirationIsGrounded(callout.option.expiration, content, timestamp)) {
      return `expiration ${callout.option.expiration} is not grounded in any date token in the message`;
    }
  }
  return null;
}

// =============================================================================
// Public parser — model-agnostic; delegates to whatever LlmProvider is injected
// =============================================================================

export type ParsePath =
  | 'deterministic'
  | 'prefilter_brag'
  | 'prefilter_language'
  | 'prefilter_signal'
  | 'llm'
  | 'llm_repair';

export interface TracedParse {
  readonly callout: Callout;
  readonly path: ParsePath;
  readonly elapsedMs: number;
  readonly llmCalls: number;
}

export class LlmCalloutParser implements CalloutParser {
  private readonly provider: LlmProvider;

  constructor(provider?: LlmProvider) {
    this.provider = provider ?? createLlmProvider();
  }

  async parse(envelope: DiscordEnvelope): Promise<Callout> {
    return (await this.parseTraced(envelope)).callout;
  }

  /** Same parse, plus which path resolved it and what it cost. */
  async parseTraced(envelope: DiscordEnvelope): Promise<TracedParse> {
    const startedAt = performance.now();
    let llmCalls = 0;

    const finish = (callout: Callout, path: ParsePath): TracedParse => {
      const elapsedMs = Math.round(performance.now() - startedAt);
      log.debug('parse complete', {
        messageId: envelope.messageId,
        path,
        elapsedMs,
        llmCalls,
        isCallout: callout.isCallout,
      });
      return { callout, path, elapsedMs, llmCalls };
    };

    // Discord ANSI color codes end in `m` (`\u001b[1;32mTSLA` → `mTSLA`).
    const cleaned: DiscordEnvelope = {
      ...envelope,
      content: envelope.content.replace(/\u001b\[[0-9;]*m/g, ''),
    };

    const deterministic = tryParseDeterministicCallout(cleaned);
    if (deterministic) {
      log.debug('parsed deterministic callout', {
        messageId: envelope.messageId,
        ticker: deterministic.ticker,
        option: deterministic.option,
        limitPrice: deterministic.limitPrice,
      });
      return finish(deterministic, 'deterministic');
    }

    if (isProfitBrag(cleaned.content)) {
      log.debug('P/L brag/update pattern; skipping LLM', {
        messageId: envelope.messageId,
        content: cleaned.content.slice(0, 200),
      });
      return finish(
        buildNonCallout(
          'P/L brag/update pattern (bold % gain or price-to-price-now); skipped LLM (pre-filter)'
        ),
        'prefilter_brag'
      );
    }

    const languageContent = stripNoiseLines(cleaned.content).join('\n');
    const prefilter = matchLanguagePrefilter(languageContent);
    if (prefilter) {
      log.debug('language pattern classified as non-callout; skipping LLM', {
        messageId: envelope.messageId,
        prefilter,
        content: cleaned.content.slice(0, 200),
      });
      return finish(
        buildNonCallout(`${prefilter} pattern with no directive verb; skipped LLM (pre-filter)`),
        'prefilter_language'
      );
    }

    if (!messageHasTradeSignal(cleaned.content)) {
      log.debug('no ticker or trade verb; skipping LLM', {
        messageId: envelope.messageId,
        content: cleaned.content.slice(0, 200),
      });
      return finish(
        buildNonCallout('no ticker or trade verb present; skipped LLM (pre-filter)'),
        'prefilter_signal'
      );
    }

    const llmContent = stripNoiseLinesForLlm(cleaned.content);
    const userMessage = [
      'Reference timestamp (use as "now" for relative dates): ' + cleaned.timestamp,
      'Author: ' + cleaned.authorName,
      'Message: ' + llmContent,
      '',
      buildCandidatesBlock(languageContent, cleaned.timestamp),
    ].join('\n');

    llmCalls += 1;
    const args = await this.provider.callStructured({
      system: SYSTEM_PROMPT,
      user: userMessage,
      tool: { name: TOOL_NAME, description: TOOL_DESCRIPTION, schema: TOOL_SCHEMA },
    });

    let path: ParsePath = 'llm';
    let result = LlmCalloutInputSchema.safeParse(args);
    if (!result.success) {
      log.warn('LLM callout failed schema validation; retrying with validation feedback', {
        messageId: envelope.messageId,
        content: envelope.content.slice(0, 200),
        error: result.error.message,
      });

      llmCalls += 1;
      path = 'llm_repair';
      const repairArgs = await this.provider.callStructured({
        system: SYSTEM_PROMPT,
        user: [
          userMessage,
          '',
          'Your previous structured output failed validation:',
          result.error.message,
          '',
          'Return exactly one corrected report_callout object that satisfies the schema.',
          'If the message has multiple alternatives, choose the first concrete entry with both a contract and entry price.',
          'If it is only a P/L update or status update, return isCallout=false with every nullable field set to null.',
        ].join('\n'),
        tool: { name: TOOL_NAME, description: TOOL_DESCRIPTION, schema: TOOL_SCHEMA },
      });
      result = LlmCalloutInputSchema.safeParse(repairArgs);
    }

    if (!result.success) {
      log.warn('LLM callout failed schema validation after retry; treating message as non-callout', {
        messageId: envelope.messageId,
        content: envelope.content.slice(0, 200),
        error: result.error.message,
      });
      return finish(
        buildNonCallout('LLM output failed schema validation after retry; treated as non-callout'),
        path
      );
    }

    const callout = result.data;
    let normalized: Callout = callout.ticker
      ? { ...callout, ticker: callout.ticker.toUpperCase() }
      : callout;

    // Exits go out as market orders — the same rule the deterministic trim
    // template enforces. Models lift a status-arrow or fill price into a sell
    // limit ("Sold 3 of 15 @ $1.069" → limit 1.069); the sell itself is right,
    // the price is noise, so normalize instead of rejecting. ponytail: this
    // also flattens a genuine "sell half at 2.50" limit exit to market; the
    // upgrade path is limiting the rewrite to prices found in arrow/fill lines.
    if (normalized.isCallout && normalized.action === 'sell' && normalized.orderType === 'limit') {
      log.debug('normalizing sell limit to market order', {
        messageId: envelope.messageId,
        droppedLimitPrice: normalized.limitPrice,
      });
      normalized = { ...normalized, orderType: 'market', limitPrice: null };
    }

    if (normalized.isCallout) {
      const groundingError = findLlmGroundingError(normalized, llmContent, cleaned.timestamp);
      if (groundingError) {
        log.warn('LLM callout rejected by grounding post-validation', {
          messageId: envelope.messageId,
          content: envelope.content.slice(0, 200),
          groundingError,
          ticker: normalized.ticker,
          option: normalized.option,
        });
        return finish(
          buildNonCallout(`LLM ${groundingError}; treated as non-callout (post-validation)`),
          path
        );
      }
    }

    log.debug('parsed callout', {
      messageId: envelope.messageId,
      isCallout: normalized.isCallout,
      assetType: normalized.assetType,
      action: normalized.action,
      ticker: normalized.ticker,
      positionSize: normalized.positionSize,
      confidence: normalized.confidence,
    });

    return finish(normalized, path);
  }
}
