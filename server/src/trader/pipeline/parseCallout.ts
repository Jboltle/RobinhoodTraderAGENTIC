import { createLlmProvider } from '../../shared/llm.js';
import { createLogger } from '../../shared/logger.js';
import {
  CalloutSchema,
  type Callout,
  type CalloutParser,
  type DiscordEnvelope,
  type LlmProvider,
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

const SYSTEM_PROMPT = `You extract structured trading callouts (US equities OR US-listed options) from Discord chat messages.

A "callout" is an explicit, forward-looking directive to BUY or SELL.
Entry language counts as BUY: "buying", "entering", "I'm entering", "I'm in", "adding", "grabbing", "starting a position". Exit language counts as SELL: "selling", "trimming", "closing", "taking profit".

EQUITY EXAMPLES:
- "Buying NVDA at open"           -> equity buy NVDA, market
- "Sell half my TSLA, $250 limit" -> equity sell TSLA, limit 250
- "$500 of AAPL"                  -> equity buy AAPL, sizeHint usd 500
- "100 shares of MSFT"            -> equity buy MSFT, sizeHint shares 100

OPTION EXAMPLES:
- "10 NVDA 200c 12/15"            -> option buy NVDA call, strike 200, exp 2026-12-15, sizeHint contracts 10
- "Long AAPL 180 puts Friday"     -> option buy AAPL put, strike 180, exp = next Friday
- "Sell to close my SPY 450c next week" -> option sell SPY call, strike 450, exp = Friday after next
- "Buying 5x TSLA 250c 0DTE"      -> option buy TSLA call, strike 250, exp = today, sizeHint contracts 5
- "META 500p weeklies $5 limit"   -> option buy META put, strike 500, exp = next Friday, limit 5 (per-contract premium)

REAL-WORLD CHANNEL FORMAT (with noise lines stripped):
  "@Optionality | Monday - 06-15-2026  09:35 AM EST   <- ignore (header)
   @Pro                                                <- ignore (role mention)
   Buy To Open
   SPY 755C 0DTE $0.71
   @Namrood - LIVE DASHBOARD"                         <- ignore (footer)
  -> option buy SPY call, strike 755, exp = today, limit 0.71

  "@Optionality | Friday - 06-12-2026  11:24 AM EST   <- ignore
   @Pro                                                <- ignore
   ⚠️ Lotto Trade — RISKY
   SPY 745C 0DTE $1.7
   ⚠️ Size for what you can afford to lose --- 1% of your account balance.
   @Namrood - LIVE DASHBOARD"                         <- ignore
  -> option buy SPY call, strike 745, exp = today, limit 1.7, positionSize small

  "@Pro                                                <- ignore
   Close or Trim & Set SL to BE
   TRIM
   QQQ 707C 2026-06-11
   1.5900  →  1.75   P/L: +10.06% ($16.00)
   @Namrood - LIVE DASHBOARD"                         <- ignore
  -> option sell QQQ call, strike 707, exp 2026-06-11, positionSize medium (P/L line is status only)

  "@Pro                                                <- ignore
   Close or Trim & Set SL to BE
   TRIM TRIM
   QQQ 707C 2026-06-11
   1.5900  →  2.03   P/L: +27.67% ($44.00)"           <- P/L is status, not a limit price
  -> option sell QQQ call, strike 707, exp 2026-06-11, positionSize full

  "@Pro                                                <- ignore
   Close or Trim & Set SL to BE
   RUNNERS ONLY
   QQQ 707C 2026-06-11
   1.5900  →  2.14   P/L: +34.59% ($55.00)"
  -> option sell QQQ call, strike 707, exp 2026-06-11, positionSize full (sell most, keep runners)

  "Trimming most
   Close or Trim & Set SL to BE
   GOOGL 370C 2026-06-18
   2.7500  →  5.1   P/L: +85.45% ($235.00)"
  -> option sell GOOGL call, strike 370, exp 2026-06-18, positionSize full

  "I'm Entering
   Option: GOOGL 380 C 7/24"
  -> option buy GOOGL call, strike 380, exp = nearest future 07-24, market order (no price given)

  "Entering
   Option: SPY 550 P 8/15
   Entry: @1.20"
  -> option buy SPY put, strike 550, exp = nearest future 08-15, limit 1.20 (per-contract premium)

NON-CALLOUTS (set isCallout=false):
- "Watching SOFI", "Bought MSFT" (past tense), "Long $META" (no buy/sell verb), generic chatter.
- P/L update lines only (e.g. "0.71 → 0.90  P/L: +26%") with no buy/sell directive.
- Hype / commentary following a callout: "BANG!", "BANGGGGG", "BANGERERRRRR!", "BTFDD", "LETS BANK NEXT WEEK!".
- Fill complaints: "everyone had MUCH better fill than me!! This dropped to .8".
- Past-tense portfolio recaps: "we made 100% on both $AAPL and $CVS calls".
- Holding updates: "Still in $X", "gives me vibes".

DISCORD MESSAGE NOISE (ignore completely — these are role/user mention tags):
- "@Pro", "@here", "@everyone"
- "@<Name> - LIVE DASHBOARD" lines
- "@Optionality | <Weekday> - <Date>  <Time> EST" header lines
- Bot-appended footer lines like "@Namrood - LIVE DASHBOARD"
These tags appear in almost every message and have no bearing on the trade signal.

REQUIRED RULES:
- ticker: uppercase letters (1-5).
- assetType: 'equity' for plain stock, 'option' for any single-leg option contract. Multi-leg spreads are NOT callouts (set isCallout=false).
- action: 'buy' or 'sell'. For options, 'buy' opens a long and 'sell' closes it.
- orderType: 'market' by default; 'limit' only when an explicit price is stated.
- limitPrice: the explicit limit price for the order itself.
  * For equities this is the share price.
  * For options this is the per-contract PREMIUM, NOT the strike.
- sizeHint:
  * 'shares'    -> count of shares ("100 shares of NVDA")
  * 'usd'       -> dollar amount ("$500 of AAPL")
  * 'contracts' -> count of options contracts ("10 calls", "5x", "3 puts")
  * null        -> not specified.

POSITION SIZE KEYWORDS (positionSize field):
Classify based on qualitative size language in the message. Ignore this field if an explicit sizeHint is present.
- 'small'  -> "small", "light", "quick", "scalp", "tiny", "starter"
- 'medium' -> "medium", "half", "half size", "partial", "trim", "TRIM"
- 'full'   -> "full", "full size", "max", "heavy", "load up", "all in", "full send", "trimming most", "TRIM TRIM", "RUNNERS ONLY" (heavy exit: sell most, keep a runner when possible)
- null     -> no size qualifier present.

OPTION CONTRACT FIELDS (option must be populated when assetType='option', else null):
- option.optionType: 'call' or 'put'.
- option.strike: numeric strike price.
- option.expiration: ISO YYYY-MM-DD. Use the Reference timestamp as "now":
  * "12/15", "Dec 15"  -> nearest future date matching that month/day.
  * "Friday"           -> next Friday on or after the reference date.
  * "next Friday"      -> the Friday after the next one.
  * "weekly/weeklies"  -> next Friday on or after the reference date.
  * "0DTE/today"       -> the reference date itself.
  * "monthly"          -> third Friday of current month, or next month if past.
  * "EOY"              -> last Friday of December of the reference year.
  * "leaps"            -> January monthly expiration at least one year out.
  * If you cannot confidently resolve a future date, set isCallout=false.

OTHER:
- confidence: 0.0 - 1.0.
- rationale: <=200 char summary of the trade extracted (or why rejected).
- Always call the report_callout tool exactly once.`;
function tryParseDeterministicCallout(envelope: DiscordEnvelope): Callout | null {
  const ownContent = envelope.content
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('>'))
    .join('\n');
  const normalized = ownContent
    .replace(/\r/g, '\n')
    .replace(/[\u2192\u21d2]/g, ' -> ')
    .replace(/\s+/g, ' ')
    .trim();

  return (
    parseBtoOption(normalized, envelope.timestamp) ??
    parseChaseOption(normalized, envelope.timestamp) ??
    parseCompactOptionLine(ownContent, envelope.timestamp) ??
    parseLabeledEntryOption(ownContent, envelope.timestamp) ??
    parseTrimExitOption(ownContent, envelope.timestamp)
  );
}

// Bot-generated exit alerts always carry this fixed header line.
const TRIM_EXIT_HEADER = /^\s*Close\s+or\s+Trim\b/im;

// Contract line inside an exit alert: "SPY 743P 2026-07-20" / "QQQ 707C 06/11".
const TRIM_EXIT_CONTRACT_LINE =
  /^\$?([A-Z]{1,6})\s+(\d+(?:\.\d+)?)([CP])\b\s+(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s*$/;

// Heavy-exit language: sell most of the position, keep at most a runner.
const TRIM_EXIT_FULL =
  /\btrim\s+trim\b|\btrim(?:ming)?\s+most\b|\brunners?\s+only\b|\bclos(?:e|ing)\s+(?:all|full|it\s+all|everything)\b/i;

// Any other trim wording ("TRIM", "Trim some") is a partial exit.
const TRIM_EXIT_PARTIAL = /\btrim/i;

function resolveTrimExitSize(directiveText: string): 'medium' | 'full' | null {
  if (TRIM_EXIT_FULL.test(directiveText)) return 'full';
  if (TRIM_EXIT_PARTIAL.test(directiveText)) return 'medium';
  return null;
}

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
  if (!contractMatch) return null;

  const [, tickerRaw, strikeRaw, typeRaw, expirationRaw] = contractMatch;
  const expiration = resolveDeterministicExpiration(expirationRaw!, timestamp);
  if (!expiration) return null;

  // Size keywords live on their own directive line ("TRIM TRIM", "Trim some",
  // "RUNNERS ONLY"). The header itself contains "Trim", so exclude it — a
  // header-only alert has no size qualifier.
  const directiveText = lines
    .filter((line) => !TRIM_EXIT_HEADER.test(line) && !TRIM_EXIT_CONTRACT_LINE.test(line))
    .join('\n');

  const ticker = tickerRaw!.toUpperCase();
  const candidate = {
    isCallout: true,
    assetType: 'option',
    action: 'sell',
    ticker,
    orderType: 'market',
    limitPrice: null,
    sizeHint: null,
    positionSize: resolveTrimExitSize(directiveText),
    option: {
      optionType: typeRaw!.toUpperCase() === 'C' ? 'call' : 'put',
      strike: Number(strikeRaw),
      expiration,
    },
    confidence: 0.99,
    rationale: `TRIM ${ticker} ${strikeRaw}${typeRaw!.toUpperCase()} ${expirationRaw} — Close or Trim exit, P/L line is status only`,
  };

  const parsed = CalloutSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function parseBtoOption(content: string, timestamp: string): Callout | null {
  const match = content.match(
    /^(?:BTO|BUY\s+TO\s+OPEN)\b.*?\$?([A-Z]{1,5})\s+(\d+(?:\.\d+)?)([CP])\b\s+(0DTE|TODAY|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{4}-\d{2}-\d{2})\s+(?:@|\$)?\s*(\d+(?:\.\d+)?)/i
  );
  if (!match) return null;

  const [, tickerRaw, strikeRaw, typeRaw, expirationRaw, limitRaw] = match;
  return buildDeterministicOptionCallout({
    tickerRaw: tickerRaw!,
    strikeRaw: strikeRaw!,
    typeRaw: typeRaw!,
    expirationRaw: expirationRaw!,
    limitRaw: limitRaw!,
    timestamp,
    content,
    rationalePrefix: 'BTO',
  });
}

function parseChaseOption(content: string, timestamp: string): Callout | null {
  const match = content.match(
    /^\$?([A-Z]{1,5})\s+(\d+(?:\.\d+)?)([CP])\b\s*[-–—]\s*(?:@|\$)?\s*(\d+(?:\.\d+)?)\b.*\b(?:chase|starter|small|lotto|risk)\b/i
  );
  if (!match) return null;

  const [, tickerRaw, strikeRaw, typeRaw, limitRaw] = match;
  return buildDeterministicOptionCallout({
    tickerRaw: tickerRaw!,
    strikeRaw: strikeRaw!,
    typeRaw: typeRaw!,
    expirationRaw: '0DTE',
    limitRaw: limitRaw!,
    timestamp,
    content,
    rationalePrefix: 'CHASE',
  });
}

function parseCompactOptionLine(content: string, timestamp: string): Callout | null {
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (!/\b(?:fill|entry)\b/i.test(line)) continue;
    const match = line.match(
      /^\$?([A-Z]{1,6})\s+(\d+(?:\.\d+)?)([CP])\b\s+(0DTE|TODAY|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{4}-\d{2}-\d{2})\s+(?:@|\$)?\s*(\d+(?:\.\d+)?)(?:\b|\s)/i
    );
    if (!match) continue;

    const [, tickerRaw, strikeRaw, typeRaw, expirationRaw, limitRaw] = match;
    return buildDeterministicOptionCallout({
      tickerRaw: tickerRaw!,
      strikeRaw: strikeRaw!,
      typeRaw: typeRaw!,
      expirationRaw: expirationRaw!,
      limitRaw: limitRaw!,
      timestamp,
      content: line,
      rationalePrefix: 'ENTRY',
    });
  }

  return null;
}

function parseLabeledEntryOption(content: string, timestamp: string): Callout | null {
  if (!/\b(?:entering|entry)\b/i.test(content)) return null;

  const optionMatch = content.match(
    /^\s*Option\s*:\s*\$?([A-Z]{1,5})\s+(\d+(?:\.\d+)?)\s*([CP]|calls?|puts?)\s+(0DTE|TODAY|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{4}-\d{2}-\d{2})\s*$/im
  );
  if (!optionMatch) return null;

  // Entry price is optional: "Entry: @1.20" -> limit order; absent -> market
  // order (execution sizes off the live mark price).
  const entryMatch = content.match(
    /^\s*Entry\s*:\s*(?:@|\$)?\s*(\d+(?:\.\d+)?)(?:\s*[-–—]\s*(?:@|\$)?\s*(\d+(?:\.\d+)?))?\s*$/im
  );

  const [, tickerRaw, strikeRaw, typeRaw, expirationRaw] = optionMatch;
  const limitRaw = entryMatch ? (entryMatch[2] ?? entryMatch[1]) : undefined;
  return buildDeterministicOptionCallout({
    tickerRaw: tickerRaw!,
    strikeRaw: strikeRaw!,
    typeRaw: typeRaw![0]!,
    expirationRaw: expirationRaw!,
    limitRaw,
    timestamp,
    content,
    rationalePrefix: 'ENTRY',
  });
}

function buildDeterministicOptionCallout(opts: {
  tickerRaw: string;
  strikeRaw: string;
  typeRaw: string;
  expirationRaw: string;
  /** Explicit per-contract premium; omit for a market order. */
  limitRaw?: string;
  timestamp: string;
  content: string;
  rationalePrefix: string;
}): Callout | null {
  const expiration = resolveDeterministicExpiration(opts.expirationRaw, opts.timestamp);
  if (!expiration) return null;

  const hasLimit = opts.limitRaw !== undefined && opts.limitRaw !== '';
  const ticker = opts.tickerRaw.toUpperCase();
  const contract = opts.strikeRaw + opts.typeRaw.toUpperCase();
  const candidate = {
    isCallout: true,
    assetType: 'option',
    action: 'buy',
    ticker,
    orderType: hasLimit ? 'limit' : 'market',
    limitPrice: hasLimit ? Number(opts.limitRaw) : null,
    sizeHint: null,
    positionSize: /\b(risky|lotto|small|light|tiny|starter|scalp)\b/i.test(opts.content) ? 'small' : null,
    option: {
      optionType: opts.typeRaw.toUpperCase() === 'C' ? 'call' : 'put',
      strike: Number(opts.strikeRaw),
      expiration,
    },
    confidence: 0.99,
    rationale: [
      opts.rationalePrefix,
      ticker,
      contract,
      opts.expirationRaw,
      hasLimit ? 'at $' + opts.limitRaw : 'at market',
    ].join(' '),
  };

  const parsed = CalloutSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
/**
 * Fill the structural fields a strict `CalloutSchema` requires when the model
 * omits them. Models frequently return a partial object for plain chatter
 * (e.g. missing `assetType`/`orderType`); coercing to the full shape lets a
 * non-callout validate on the first attempt instead of forcing a repair retry
 * and then dropping the message. Invalid enum *values* are left untouched so
 * the schema still rejects genuinely malformed output.
 */
function coerceCalloutShape(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const r = raw as Record<string, unknown>;
  const hasOption = typeof r.option === 'object' && r.option !== null;
  return {
    isCallout: typeof r.isCallout === 'boolean' ? r.isCallout : false,
    assetType: r.assetType ?? (hasOption ? 'option' : 'equity'),
    action: r.action ?? null,
    ticker: r.ticker ?? null,
    orderType: r.orderType ?? 'market',
    limitPrice: r.limitPrice ?? null,
    sizeHint: r.sizeHint ?? null,
    positionSize: r.positionSize ?? null,
    option: r.option ?? null,
    confidence: typeof r.confidence === 'number' ? r.confidence : 0,
    rationale: typeof r.rationale === 'string' ? r.rationale : '',
  };
}

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

function buildNonCallout(rationale: string): Callout {
  return {
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
    rationale,
  };
}

function resolveDeterministicExpiration(raw: string, referenceTimestamp: string): string | null {
  const upper = raw.toUpperCase();
  const reference = new Date(referenceTimestamp);
  if (!Number.isFinite(reference.getTime())) return null;

  if (upper === '0DTE' || upper === 'TODAY') {
    return reference.toISOString().slice(0, 10);
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

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

  return date.toISOString().slice(0, 10);
}

// =============================================================================
// Public parser — model-agnostic; delegates to whatever LlmProvider is injected
// =============================================================================

export class LlmCalloutParser implements CalloutParser {
  private readonly provider: LlmProvider;

  constructor(provider?: LlmProvider) {
    this.provider = provider ?? createLlmProvider();
  }

  async parse(envelope: DiscordEnvelope): Promise<Callout> {
    const deterministic = tryParseDeterministicCallout(envelope);
    if (deterministic) {
      log.debug('parsed deterministic callout', {
        messageId: envelope.messageId,
        ticker: deterministic.ticker,
        option: deterministic.option,
        limitPrice: deterministic.limitPrice,
      });
      return deterministic;
    }

    if (isProfitBrag(envelope.content)) {
      log.debug('P/L brag/update pattern; skipping LLM', {
        messageId: envelope.messageId,
        content: envelope.content.slice(0, 200),
      });
      return buildNonCallout('P/L brag/update pattern (bold % gain or price-to-price-now); skipped LLM (pre-filter)');
    }

    if (!messageHasTradeSignal(envelope.content)) {
      log.debug('no ticker or trade verb; skipping LLM', {
        messageId: envelope.messageId,
        content: envelope.content.slice(0, 200),
      });
      return buildNonCallout('no ticker or trade verb present; skipped LLM (pre-filter)');
    }

    const userMessage = [
      'Reference timestamp (use as "now" for relative dates): ' + envelope.timestamp,
      'Author: ' + envelope.authorName,
      'Message: ' + envelope.content,
    ].join('\n');

    const args = await this.provider.callStructured({
      system: SYSTEM_PROMPT,
      user: userMessage,
      tool: { name: TOOL_NAME, description: TOOL_DESCRIPTION, schema: TOOL_SCHEMA },
    });

    let result = CalloutSchema.safeParse(coerceCalloutShape(args));
    if (!result.success) {
      log.warn('LLM callout failed schema validation; retrying with validation feedback', {
        messageId: envelope.messageId,
        content: envelope.content.slice(0, 200),
        error: result.error.message,
      });

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
      result = CalloutSchema.safeParse(coerceCalloutShape(repairArgs));
    }

    if (!result.success) {
      log.warn('LLM callout failed schema validation after retry; treating message as non-callout', {
        messageId: envelope.messageId,
        content: envelope.content.slice(0, 200),
        error: result.error.message,
      });
      return buildNonCallout('LLM output failed schema validation after retry; treated as non-callout');
    }

    const callout = result.data;
    const normalized: Callout = callout.ticker
      ? { ...callout, ticker: callout.ticker.toUpperCase() }
      : callout;

    log.debug('parsed callout', {
      messageId: envelope.messageId,
      isCallout: normalized.isCallout,
      assetType: normalized.assetType,
      action: normalized.action,
      ticker: normalized.ticker,
      positionSize: normalized.positionSize,
      confidence: normalized.confidence,
    });

    return normalized;
  }
}
