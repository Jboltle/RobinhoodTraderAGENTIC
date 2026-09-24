import { z } from 'zod';

// =============================================================================
// Trading vocabulary — the single source of truth for every string union.
//
// Zod schemas consume the tuples and everything else imports the named types,
// so adding a member updates the schema, the types, and every exhaustive
// switch in one edit.
// =============================================================================

export const ORDER_SIDES = ['buy', 'sell'] as const;
export type OrderSide = (typeof ORDER_SIDES)[number];

export const ORDER_TYPES = ['market', 'limit'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

export const ASSET_TYPES = ['equity', 'option'] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

export const OPTION_TYPES = ['call', 'put'] as const;
export type OptionType = (typeof OPTION_TYPES)[number];

export const POSITION_SIZES = ['small', 'medium', 'full'] as const;
export type PositionSize = (typeof POSITION_SIZES)[number];

export const SIZE_HINT_KINDS = ['shares', 'usd', 'contracts'] as const;
export type SizeHintKind = (typeof SIZE_HINT_KINDS)[number];

export const EXECUTION_MODES = ['immediate', 'approval'] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

// =============================================================================
// Discord envelope — the internal shape between the poller and the pipeline
//
// The trader's poller builds one from a raw `messages` row (which the Listener
// wrote) and hands it to the pipeline. It carries RAW parts — `content` as the
// message text (attachment URLs appended by the Listener) and `embeds` as raw
// embed JSON. The pipeline flattens exactly once at its entry (flattenEnvelope
// in shared/embedText.ts). Nothing external produces envelopes any more: the
// database is the ingestion boundary, so this is a plain type, not a schema.
// =============================================================================

export interface DiscordEnvelope {
  readonly messageId: string;
  readonly channelId: string;
  /** Discord channel name; null when the Listener could not resolve one. */
  readonly channelName?: string | null;
  /** Retained for fixture/test provenance; nothing routes or filters by it. */
  readonly guildId: string | null;
  readonly authorId: string;
  readonly authorName: string;
  /** Resolved CDN avatar URL, recovered from the raw snapshot; null when absent. */
  readonly authorAvatarUrl: string | null;
  /**
   * Raw message text, plus attachment URLs serialized as text. May be empty
   * for embed-only messages. Contains flattened embed text only after
   * flattenEnvelope has run.
   */
  readonly content: string;
  /** Original message ISO timestamp — drives expiration parsing and staleness. */
  readonly timestamp: string;
  /** Raw Discord embed JSON; flattened into content at the pipeline entry. */
  readonly embeds?: Record<string, unknown>[];
}

// =============================================================================
// Callout — the structured trade signal extracted from a Discord message
// =============================================================================

const validateTicker = (ticker: string): boolean => /^[A-Z][A-Z0-9]{0,5}$/.test(ticker.toUpperCase());

export const OptionContractSchema = z.object({
  optionType: z.enum(OPTION_TYPES),
  strike: z.number().positive(),
  expiration: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, { error: 'expiration must be ISO YYYY-MM-DD' }),
});

export type OptionContract = z.infer<typeof OptionContractSchema>;

/** Strike + C/P + expiration, e.g. `397.5C 2026-06-11` — the one contract label. */
export function optionLabel(option: OptionContract): string {
  return `${option.strike}${option.optionType[0]?.toUpperCase()} ${option.expiration}`;
}

export const CalloutSchema = z
  .object({
    isCallout: z.boolean(),
    assetType: z.enum(ASSET_TYPES),
    action: z.enum(ORDER_SIDES).nullable(),
    ticker: z.string().refine(validateTicker, { error: 'Invalid ticker' }).nullable(),
    orderType: z.enum(ORDER_TYPES),
    /**
     * True when a buy extends a position the caller already holds
     * ("averaging down", "added 10 more"). Execution requires an open
     * position for adds, so a caller's own position management can never
     * open a fresh position for a follower who missed the entry.
     */
    isAddition: z.boolean().default(false),
    /** For options this is the per-contract premium, NOT the strike. */
    limitPrice: z.number().positive().nullable(),
    sizeHint: z
      .object({
        kind: z.enum(SIZE_HINT_KINDS),
        value: z.number().positive(),
      })
      .nullable(),
    /** Qualitative size keyword extracted from the message. */
    positionSize: z.enum(POSITION_SIZES).nullable(),
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
// This schema is the single source of truth for defaults. Each user owns one
// settings row holding the full payload; parsing `{}` yields the defaults
// below, so there is no env or file layer behind it.
// =============================================================================

const pct = z.number().positive().max(100);
const tickerList = z.array(z.string().transform((t) => t.toUpperCase()));

export const TradeSettingsSchema = z.object({
  executionMode: z.enum(EXECUTION_MODES).default('approval'),
  /**
   * Position sizing. Every value below is a plain percentage of buying power,
   * so a "medium size" stock callout deploys exactly equityMediumPct of the
   * account — nothing is multiplied by anything else. The `full` value doubles
   * as the per-trade ceiling: an explicit dollar, share or contract count from
   * a callout is clamped to it.
   */
  equitySmallPct: pct.default(1.25),
  equityMediumPct: pct.default(2.5),
  equityFullPct: pct.default(5),
  optionsSmallPct: pct.default(0.5),
  optionsMediumPct: pct.default(1),
  optionsFullPct: pct.default(2),
  /** Skip options trades where even 1 contract exceeds this % of buying power. */
  maxSingleContractPct: pct.default(5),
  maxTradesPerDay: z.number().int().nonnegative().default(10),
  cooldownSeconds: z.number().nonnegative().default(300),
  /** Empty = allow every ticker. */
  allowedTickers: tickerList.default([]),
  blockedTickers: tickerList.default([]),
  minConfidence: z.number().min(0).max(1).default(0.7),
  regularHoursOnly: z.boolean().default(true),
  /**
   * Following: [] = follow no one (default — a new account trades nothing until
   * its owner picks Callers), non-empty = follow exactly those Discord author
   * ids. null still means "follow every Caller including future ones" so rows
   * written before this default flipped keep their meaning, but nothing in the
   * UI produces it any more.
   */
  followedCallerIds: z.array(z.string()).nullable().default([]),
  /**
   * Max Loss: flatten one open position when unrealized loss hits either
   * threshold. null / 0 = that side is off. Both off (the default) = feature off.
   */
  maxLossPct: z.number().min(0).max(100).nullable().default(null),
  maxLossUsd: z.number().min(0).nullable().default(null),
});

/** What a client may send: every field optional, defaults fill the rest. */
export type TradeSettings = z.input<typeof TradeSettingsSchema>;

/** Fully-resolved settings: every field populated by the schema defaults. */
export type ResolvedTradeSettings = z.output<typeof TradeSettingsSchema>;

/** The defaults, as a fresh object. */
export const defaultSettings = (): ResolvedTradeSettings => TradeSettingsSchema.parse({});

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
  | 'ticker_invalid'        // broker has no equity quote for the parsed ticker
  | 'broker_unavailable'    // user's Robinhood session not connected / needs re-authorization
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
      readonly assetType: AssetType;
      /**
       * Percentage of available buying power to deploy (0–100), resolved
       * straight from the size keyword's setting. The pipeline fetches buying
       * power once and computes:
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
      readonly orderType: OrderType;
      /** Resolved caps carried through so execution honours per-request settings. */
      readonly maxSingleContractPct: number;
      /** The options ceiling: no trade may exceed this % of buying power. */
      readonly optionsFullPct: number;
    };

// =============================================================================
// Decision record
// =============================================================================

export type DecisionKind =
  | 'not_callout'
  | 'parser_error'
  | 'risk_rejected'
  /** Sized and waiting for the user to approve or reject it in the dashboard. */
  | 'pending_approval'
  /** The user turned down a pending_approval. Terminal. */
  | 'rejected'
  | 'submitted'
  | 'execution_failed'
  /** Seen on catch-up but too old to execute at a price that still makes sense. */
  | 'missed'
  /** Server-side Max Loss flattened this open position. Does not count as a submitted entry. */
  | 'max_loss_exit';

export interface SubmittedOrder {
  readonly symbol: string;
  readonly side: OrderSide;
  readonly assetType: AssetType;
  /** Shares for equity orders; contracts for options orders. */
  readonly quantity: number;
  readonly orderType: OrderType;
  readonly limitPrice: number | null;
  /** Populated for options orders; null for equity. */
  readonly option: OptionContract | null;
  /** Robinhood order id (null until the broker accepts the request). */
  readonly orderId: string | null;
  /** Broker-reported status at submit time. */
  readonly status: string | null;
}

/**
 * One user's outcome for one Discord callout — a row in `trades`. Ticker and
 * action are denormalized off the callout so a decision reads standalone
 * without joining the shared `callouts` table.
 */
export interface Decision {
  readonly at: string;
  readonly messageId: string;
  readonly kind: DecisionKind;
  /** Machine-readable rejection code; null for successful/informational kinds. */
  readonly code: RejectionCode | null;
  /** Human-readable: rejection reason or success summary. Always populated. */
  readonly reason: string;
  readonly ticker: string | null;
  readonly action: OrderSide | null;
  /** Set when we attempted to submit (kind: 'submitted' or 'execution_failed'). */
  readonly order: SubmittedOrder | null;
}
