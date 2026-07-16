/**
 * Trader REST API client. Response shapes mirror src/trader/server.ts and
 * src/shared/types.ts in the parent repo.
 *
 * ponytail: types are hand-copied, not imported from ../src (the client is a
 * standalone package with its own tsconfig). Upgrade path: extract a shared
 * types package or generate from the zod schemas.
 */

export const TRADER_URL: string =
  import.meta.env.VITE_TRADER_URL ?? 'http://localhost:3000'

export interface OptionContract {
  optionType: 'call' | 'put'
  strike: number
  expiration: string
}

export interface SubmittedOrder {
  symbol: string
  side: 'buy' | 'sell'
  assetType: 'equity' | 'option'
  quantity: number
  orderType: 'market' | 'limit'
  limitPrice: number | null
  option: OptionContract | null
  orderId: string | null
  status: string | null
}

export type DecisionKind =
  | 'not_callout'
  | 'parser_error'
  | 'risk_rejected'
  | 'pending_approval'
  | 'submitted'
  | 'execution_failed'

/** Machine-readable rejection code; mirrors RejectionCode in server/src/shared/types.ts. */
export type RejectionCode =
  | 'parse_failed'
  | 'not_callout'
  | 'missing_contract'
  | 'invalid_sizing'
  | 'low_confidence'
  | 'parse_inconsistent'
  | 'ticker_blocked'
  | 'ticker_not_allowed'
  | 'outside_market_hours'
  | 'daily_cap_reached'
  | 'cooldown_active'
  | 'insufficient_capital'
  | 'execution_error'

/** Live trade lifecycle event from the trader's `stage` SSE frames. */
export interface StageEvent {
  messageId: string
  ticker: string | null
  stage: 'received' | 'parsing' | 'risk_check' | 'executing' | 'done'
  at: string
}

export interface DiscordEmbed {
  title?: string
  description?: string
  [key: string]: unknown
}

export interface Decision {
  at: string
  envelope: {
    messageId: string
    authorName: string
    content: string
    timestamp: string
    embeds?: DiscordEmbed[]
  }
  callout: {
    ticker: string | null
    action: 'buy' | 'sell' | null
    assetType: 'equity' | 'option'
    limitPrice: number | null
    option: OptionContract | null
  } | null
  kind: DecisionKind
  /** Null for successful/informational decisions; older log entries predate the field. */
  code?: RejectionCode | null
  reason: string
  order: SubmittedOrder | null
}

/**
 * One item from GET /api/callouts: today's Discord channel history joined
 * with pipeline outcomes. `decision` is null when the message never reached
 * the trader webhook (e.g. trader downtime) — the backfill case.
 */
export interface CalloutItem {
  messageId: string
  channelId: string
  channelName: string | null
  authorName: string
  timestamp: string
  content: string
  embeds: DiscordEmbed[]
  decision: { kind: DecisionKind; reason: string; at: string } | null
}

export interface PerformanceRow {
  assetType: 'equity' | 'option'
  symbol: string
  quantity: number
  optionType?: 'call' | 'put'
  strike?: number
  expiration?: string
  entryPrice: number | null
  currentPrice: number | null
  pctChange: number | null
}

/** GET /api/portfolio: account totals for the dashboard header. */
export interface PortfolioSummary {
  /** Null when Robinhood's account payload omits a total-value field. */
  portfolioValueUsd: number | null
  openPositions: number
}

/**
 * Session overrides pushed to /api/settings-state. Mirrors TradeSettingsSchema:
 * every field optional — an absent field falls through to the trader's
 * settings.json / env defaults.
 */
export type TradeSettingsInput = Partial<TradeSettings>

/** Resolved settings from GET /api/settings: every field populated. */
export interface TradeSettings {
  executionMode: 'immediate' | 'approval'
  maxNotionalPct: number
  maxOptionsNotionalPct: number
  maxSingleContractPct: number
  positionSmallPct: number
  positionMediumPct: number
  maxTradesPerDay: number
  cooldownSeconds: number
  allowedTickers: string[]
  blockedTickers: string[]
  minConfidence: number
  regularHoursOnly: boolean
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${TRADER_URL}${path}`)
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`)
  return res.json() as Promise<T>
}

export const fetchDecisions = (): Promise<Decision[]> =>
  getJson<{ decisions: Decision[] }>('/api/decisions').then((r) => r.decisions)

export const fetchPerformance = (): Promise<PerformanceRow[]> =>
  getJson<{ positions: PerformanceRow[] }>('/api/trades/performance').then(
    (r) => r.positions,
  )

export const fetchSettings = (): Promise<TradeSettings> =>
  getJson<{ settings: TradeSettings }>('/api/settings').then((r) => r.settings)

export const fetchCallouts = (): Promise<CalloutItem[]> =>
  getJson<{ callouts: CalloutItem[] }>('/api/callouts').then((r) => r.callouts)

export const fetchPortfolio = (): Promise<PortfolioSummary> =>
  getJson<PortfolioSummary>('/api/portfolio')
