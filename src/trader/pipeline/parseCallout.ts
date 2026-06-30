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
  -> option sell QQQ call, strike 707, exp 2026-06-11, positionSize medium

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
- 'full'   -> "full", "full size", "max", "heavy", "load up", "all in", "full send", "trimming most", "TRIM TRIM", "RUNNERS ONLY" (sell most, keep tiny runner)
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

// =============================================================================
// Public parser — model-agnostic; delegates to whatever LlmProvider is injected
// =============================================================================

export class LlmCalloutParser implements CalloutParser {
  private readonly provider: LlmProvider;

  constructor(provider?: LlmProvider) {
    this.provider = provider ?? createLlmProvider();
  }

  async parse(envelope: DiscordEnvelope): Promise<Callout> {
    const userMessage = [
      `Reference timestamp (use as "now" for relative dates): ${envelope.timestamp}`,
      `Author: ${envelope.authorName}`,
      `Message: ${envelope.content}`,
    ].join('\n');

    const args = await this.provider.callStructured({
      system: SYSTEM_PROMPT,
      user: userMessage,
      tool: { name: TOOL_NAME, description: TOOL_DESCRIPTION, schema: TOOL_SCHEMA },
    });

    const callout = CalloutSchema.parse(args);
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
