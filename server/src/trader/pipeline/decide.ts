/**
 * The Jev decision engine (docs/adr/0002): parser patterns read the message,
 * hosted Jev decides the Action from the message plus what the patterns saw,
 * and code turns the answer into the Callout the pipeline trades. The contract
 * and the exit size always come from the patterns, never from Jev.
 */
import { createLogger } from '../../shared/logger.js';
import {
  CalloutSchema,
  type Callout,
  type CalloutParser,
  type DiscordEnvelope,
  type ExitPortion,
} from '../../shared/types.js';
import { JevError, type JevDecisionSource, type JevVerdict } from './jev.js';
import { patternHint, readPatterns, type PatternRead } from './parseCallout.js';

const log = createLogger('trader:decider');

/** Jev probability at or above which a trade goes through without approval. */
export const AUTO_TRADE_MIN = 0.8;
/** Below this the message is ignored; from here up to AUTO_TRADE_MIN it waits for approval. */
export const REVIEW_MIN = 0.6;
/** A Buy whose act-now answer is below this is a plan or a recap, not a trade being called now. */
export const ACT_NOW_MIN = 0.3;

/** A Trim that doesn't say how much sells half. */
const DEFAULT_TRIM: ExitPortion = { kind: 'fraction', value: 0.5 };
const SELL_ALL: ExitPortion = { kind: 'all' };

const MENTION = /<(?:@[&!]?|#)\d+>/g;
const MARKDOWN_LINK = /\[([^\]]*)\]\(<?[^)\s]+>?\)/g;
const BARE_URL = /<?https?:\/\/\S+/g;

/** The message as Jev reads it: mentions and URLs dropped, links reduced to their text, one line. */
export function jevMessage(content: string): string {
  return content
    .replace(MENTION, ' ')
    .replace(MARKDOWN_LINK, '$1')
    .replace(BARE_URL, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const noTrade = (rationale: string): Callout =>
  CalloutSchema.parse({
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
    engine: 'jev',
  });

/** Turn Jev's answer and the pattern read into the Callout the pipeline trades. */
export function decideCallout(patterns: PatternRead, verdict: JevVerdict): Callout {
  const { choice } = verdict;
  const probability = verdict.probabilities[choice];
  const said = `Jev ${choice} ${probability.toFixed(2)}${patterns.pattern ? ` (${patterns.pattern})` : ''}`;

  if (choice === 'AVERAGE') return noTrade(`${said}: averages are never traded`);
  if (choice === 'INFO' || choice === 'NONE') return noTrade(`${said}: not a trade`);

  // A fixed entry template is an entry by construction; the act-now check
  // vetoed real ones in the Oct 4 test, so it only judges free-form Buys.
  const actingNow = verdict.actingNow ?? 0;
  if (choice === 'BUY' && patterns.read !== 'BUY' && actingNow < ACT_NOW_MIN) {
    return noTrade(`${said}, act-now ${actingNow.toFixed(2)} below ${ACT_NOW_MIN}: not called now`);
  }
  if (probability < REVIEW_MIN) return noTrade(`${said} is below ${REVIEW_MIN}`);

  const routing = probability < AUTO_TRADE_MIN ? { reviewReason: `${said} is below ${AUTO_TRADE_MIN}` } : {};
  const common = {
    isCallout: true,
    assetType: 'option',
    isAddition: false,
    ticker: patterns.ticker,
    sizeHint: null,
    option: patterns.option,
    confidence: probability,
    rationale: said,
    engine: 'jev',
    ...routing,
  } as const;

  if (choice === 'BUY') {
    if (!patterns.option || !patterns.ticker) {
      return noTrade(`${said}, but the patterns read no complete options contract`);
    }
    return CalloutSchema.parse({
      ...common,
      action: 'buy',
      orderType: patterns.limitPrice !== null ? 'limit' : 'market',
      limitPrice: patterns.limitPrice,
      positionSize: patterns.positionSize,
    });
  }

  // Jev picks Trim or Sell; the size is whatever the caller says they sold.
  return CalloutSchema.parse({
    ...common,
    action: 'sell',
    orderType: 'market',
    limitPrice: null,
    positionSize: null,
    exitPortion: patterns.exitPortion ?? (choice === 'SELL' ? SELL_ALL : DEFAULT_TRIM),
  });
}

export interface TracedDecision {
  readonly callout: Callout;
  readonly patterns: PatternRead;
  /** Null when there was nothing to ask Jev about (an empty message). */
  readonly verdict: JevVerdict | null;
}

/** The trade path's CalloutParser on the Jev engine. Throws JevError when Jev fails. */
export class JevCalloutDecider implements CalloutParser {
  constructor(private readonly jev: JevDecisionSource) {}

  async parse(envelope: DiscordEnvelope): Promise<Callout> {
    return (await this.decideTraced(envelope)).callout;
  }

  /** Same decision, plus the evidence behind it (the replay scores these). */
  async decideTraced(envelope: DiscordEnvelope): Promise<TracedDecision> {
    const patterns = readPatterns(envelope);
    const message = jevMessage(envelope.content);
    if (!message) return { callout: noTrade('empty message'), patterns, verdict: null };

    let verdict: JevVerdict;
    try {
      verdict = await this.jev.ask({ message, pattern_match: patternHint(patterns) });
    } catch (err) {
      log.error('Jev failed; message skipped', {
        messageId: envelope.messageId,
        kind: err instanceof JevError ? err.kind : 'unknown',
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    const callout = decideCallout(patterns, verdict);
    log.info('jev decision', {
      messageId: envelope.messageId,
      choice: verdict.choice,
      probability: verdict.probabilities[verdict.choice],
      actingNow: verdict.actingNow,
      pattern: patterns.pattern,
      isCallout: callout.isCallout,
      reviewReason: callout.reviewReason ?? null,
    });
    return { callout, patterns, verdict };
  }
}
