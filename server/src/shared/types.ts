import { z } from 'zod';

// =============================================================================
// Discord envelope
// =============================================================================

export const DiscordEnvelopeSchema = z.object({
  messageId: z.string().min(1),
  channelId: z.string().min(1),
  guildId: z.string().nullable(),
  authorId: z.string().min(1),
  authorName: z.string(),
  content: z.string(),
  timestamp: z.string(),
  /** Raw Discord embed JSON, passed through permissively (the bot flattens it into `content` for the LLM). */
  embeds: z.array(z.record(z.string(), z.unknown())).optional(),
});

export type DiscordEnvelope = z.infer<typeof DiscordEnvelopeSchema>;

// =============================================================================
// Callout — the structured trade signal extracted from a Discord message
// =============================================================================

const validateTicker = (ticker: string): boolean => /^[A-Z][A-Z0-9]{0,5}$/.test(ticker.toUpperCase());

export const OptionContractSchema = z.object({
  optionType: z.enum(['call', 'put']),
  strike: z.number().positive(),
  expiration: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, { error: 'expiration must be ISO YYYY-MM-DD' }),
});

export type OptionContract = z.infer<typeof OptionContractSchema>;

export const CalloutSchema = z
  .object({
    isCallout: z.boolean(),
    assetType: z.enum(['equity', 'option']),
    action: z.enum(['buy', 'sell']).nullable(),
    ticker: z.string().refine(validateTicker, { error: 'Invalid ticker' }).nullable(),
    orderType: z.enum(['market', 'limit']),
    /** For options this is the per-contract premium, NOT the strike. */
    limitPrice: z.number().positive().nullable(),
    sizeHint: z
      .object({
        kind: z.enum(['shares', 'usd', 'contracts']),
        value: z.number().positive(),
      })
      .nullable(),
    /** Qualitative size keyword extracted from the message. */
    positionSize: z.enum(['small', 'medium', 'full']).nullable(),
    option: OptionContractSchema.nullable(),
    confidence: z.number().min(0).max(1),
    rationale: z.string(),
  })
  .refine(
    (c) =>
      (c.assetType === 'option' && c.option !== null) ||
      (c.assetType === 'equity' && c.option === null),
    { error: 'option fields must be present iff assetType=option' }
  );

export type Callout = z.infer<typeof CalloutSchema>;

// =============================================================================
// Trade settings — runtime-tunable risk parameters
//
// Every field is optional: a settings payload/file only carries overrides.
// Resolution order (see src/trader/settings.ts): payload override →
// state/settings.json → env defaults from config.ts.
// =============================================================================

const pct = z.number().positive().max(100);
const tickerList = z.array(z.string().transform((t) => t.toUpperCase()));

export const TradeSettingsSchema = z.object({
  executionMode: z.enum(['immediate', 'approval']).optional(),
  /** Max equity notional per trade as % of buying power. */
  maxNotionalPct: pct.optional(),
  /** Max options premium spend per trade as % of buying power. */
  maxOptionsNotionalPct: pct.optional(),
  /** Skip options trades where even 1 contract exceeds this % of buying power. */
  maxSingleContractPct: pct.optional(),
  /** % of the per-trade cap used for the "small" / "medium" size keywords. */
  positionSmallPct: pct.optional(),
  positionMediumPct: pct.optional(),
  maxTradesPerDay: z.number().int().nonnegative().optional(),
  cooldownSeconds: z.number().nonnegative().optional(),
  allowedTickers: tickerList.optional(),
  blockedTickers: tickerList.optional(),
  minConfidence: z.number().min(0).max(1).optional(),
  regularHoursOnly: z.boolean().optional(),
});

export type TradeSettings = z.infer<typeof TradeSettingsSchema>;

/** Fully-resolved settings: every field populated after the resolution chain. */
export type ResolvedTradeSettings = Required<TradeSettings>;

// =============================================================================
// LLM provider abstraction (implementations live in src/shared/llm.ts)
// =============================================================================

export interface ToolJsonSchema {
  readonly type: 'object';
  readonly properties: Record<string, unknown>;
  readonly required: readonly string[];
  readonly additionalProperties: false;
}

export interface LlmProvider {
  /**
   * Forces the LLM to emit a single structured tool/function call matching the
   * supplied JSON schema and returns the raw arguments object the model produced.
   */
  callStructured(opts: {
    system: string;
    user: string;
    tool: { name: string; description: string; schema: ToolJsonSchema };
    maxTokens?: number;
  }): Promise<unknown>;
}

export interface CalloutParser {
  parse(envelope: DiscordEnvelope): Promise<Callout>;
}

// =============================================================================
// Rejection codes — machine-readable reason for every rejected/failed trade
// =============================================================================

export type RejectionCode =
  | 'parse_failed'          // LLM parse crashed or output never validated
  | 'not_callout'           // no trade directive / ticker found in message
  | 'missing_contract'      // option callout without contract details
  | 'invalid_sizing'        // sizing hint incompatible with asset type
  | 'low_confidence'        // parser confidence below threshold
  | 'parse_inconsistent'    // parse contradicts message text or market price (e.g. options language but equity parse)
  | 'ticker_blocked'        // ticker on the blocklist
  | 'ticker_not_allowed'    // ticker missing from a non-empty allowlist
  | 'outside_market_hours'  // regular-hours gate active
  | 'daily_cap_reached'     // max trades per day hit
  | 'cooldown_active'       // per-ticker cooldown still running
  | 'insufficient_capital'  // buying power zero or trade unviable at current balance
  | 'execution_error';      // broker/quote/order call failed

// =============================================================================
// Risk check — result of evaluating a callout against risk rules
// =============================================================================

export type RiskCheck =
  | { readonly allow: false; readonly code: RejectionCode; readonly reason: string }
  | {
      readonly allow: true;
      readonly assetType: 'equity' | 'option';
      /**
       * Percentage of available buying power to deploy (0–100).
       * The pipeline fetches buying power once and computes:
       *   notionalUsd = buyingPower × portfolioPct / 100
       * Ignored when quantityHint is set.
       */
      readonly portfolioPct: number;
      /**
       * Explicit unit count (shares for equity, contracts for options) when the
       * message provided one directly. When set, percentage sizing is bypassed.
       */
      readonly quantityHint: number | null;
      readonly limitPrice: number | null;
      readonly orderType: 'market' | 'limit';
      /** Resolved caps carried through so execution honours per-request settings. */
      readonly maxSingleContractPct: number;
      readonly maxOptionsNotionalPct: number;
    };

// =============================================================================
// Delivery callback — post a receipt back to Discord
// =============================================================================

export type PostReceipt = (channelId: string, content: string) => Promise<void>;

// =============================================================================
// Decision record
// =============================================================================

export type DecisionKind =
  | 'not_callout'
  | 'parser_error'
  | 'risk_rejected'
  | 'pending_approval'
  | 'submitted'
  | 'execution_failed';

export interface SubmittedOrder {
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly assetType: 'equity' | 'option';
  /** Shares for equity orders; contracts for options orders. */
  readonly quantity: number;
  readonly orderType: 'market' | 'limit';
  readonly limitPrice: number | null;
  /** Populated for options orders; null for equity. */
  readonly option: OptionContract | null;
  /** Robinhood order id (null until the broker accepts the request). */
  readonly orderId: string | null;
  /** Broker-reported status at submit time. */
  readonly status: string | null;
}

export interface Decision {
  readonly at: string;
  readonly envelope: DiscordEnvelope;
  readonly callout: Callout | null;
  readonly kind: DecisionKind;
  /** Machine-readable rejection code; null for successful/informational kinds. */
  readonly code: RejectionCode | null;
  /** Human-readable: rejection reason or success summary. Always populated. */
  readonly reason: string;
  /** Set when we attempted to submit (kind: 'submitted' or 'execution_failed'). */
  readonly order: SubmittedOrder | null;
}
