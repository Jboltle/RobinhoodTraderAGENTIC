/**
 * Trader REST API client. Response shapes mirror src/trader/server.ts and
 * src/shared/types.ts in the parent repo.
 *
 * Every request carries the caller's Supabase access token; the server derives
 * the acting user from it, so no request ever names a user.
 *
 * ponytail: types are hand-copied, not imported from ../src (the client is a
 * standalone package with its own tsconfig). Upgrade path: extract a shared
 * types package or generate from the zod schemas.
 */

// Local `vite dev` can default; a production bundle must bake in API_URL or
// every fetch silently goes to localhost:3000 (the browser reports CORS).
export const TRADER_URL: string =
  import.meta.env.API_URL ||
  (import.meta.env.DEV ? 'http://localhost:3000' : '')

if (!TRADER_URL) {
  throw new Error('API_URL must be set at build time (see client/.env.example)')
}

// Set once by AuthProvider (lib/auth.tsx). A getter rather than a value so a
// refreshed token is picked up without re-wiring anything.
let accessToken: () => string | null = () => null

export function setAccessTokenSource(source: () => string | null): void {
  accessToken = source
}

/** Authorization header for the current session; throws when signed out. */
export function authHeaders(): Record<string, string> {
  const token = accessToken()
  if (!token) throw new Error('not signed in')
  return { authorization: `Bearer ${token}` }
}

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
  | 'missed'

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

/** One row of the caller's `trades` table: their outcome for one callout. */
export interface Decision {
  at: string
  messageId: string
  kind: DecisionKind
  code: RejectionCode | null
  reason: string
  ticker: string | null
  action: 'buy' | 'sell' | null
  order: SubmittedOrder | null
}

/**
 * One item from GET /api/callouts: a Discord message the pipeline has seen,
 * carrying the caller's own outcome. `decision` is null when nothing was
 * recorded for this user — the message arrived before they connected.
 */
export interface CalloutItem {
  messageId: string
  channelId: string
  channelName: string | null
  /** The Caller's Discord author ID; null on rows stored before author identity was kept. */
  authorId: string | null
  authorName: string
  timestamp: string
  content: string
  embeds: DiscordEmbed[]
  parseStatus: 'parsed' | 'not_callout' | 'failed' | 'skipped'
  decision: Decision | null
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
 * Settings saved via PUT /api/settings. Mirrors TradeSettingsSchema's input:
 * every field optional, and an absent field takes the schema default.
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
  /** null = follow every Caller including future ones; [] = follow no one. */
  followedCallerIds: string[] | null
}

/** One row from GET /api/callers: a Caller known to the roster. */
export interface Caller {
  authorId: string
  displayName: string
  avatarUrl: string | null
  lastSeenAt: string
}

/** One options trade parsed out of a daily recap post. */
export interface RecapTrade {
  /** Recap section name ("Demon"), not a Discord identity. */
  caller: string
  ticker: string
  /** Raw expiration token as posted ("8/19", "0DTE"). */
  expiration: string | null
  strike: number | null
  optionType: 'call' | 'put' | null
  entryPrice: number | null
  exitPrice: number | null
  pctGain: number
  isWin: boolean
  /** Hedged by the recap itself ("if held") — excluded from all stats. */
  isSoft: boolean
  note: string | null
  lineRaw: string
  recapDate: string
}

/** One leaderboard row from GET /api/recaps/performance. */
export interface RecapCallerStats {
  caller: string
  trades: number
  wins: number
  losses: number
  winRatePct: number
  avgPct: number
  medianPct: number
  totalPct: number
  bestPct: number
  worstPct: number
  stdDevPct: number
  /** Meets the award floor (trades >= minTradesForAwards). */
  qualifies: boolean
}

/** One chart row: { date: '2026-08-19', Demon: 1029.2, Waxui: 105, ... }. */
export type RecapSeriesPoint = Record<string, number | string>

export interface RecapPerformanceData {
  windowDays: number
  minTradesForAwards: number
  fromDate: string | null
  toDate: string | null
  recapCount: number
  tradeCount: number
  softExcluded: number
  trades: RecapTrade[]
  totals: {
    wins: number
    losses: number
    winRatePct: number
    avgPct: number
    totalPct: number
  }
  leaderboard: RecapCallerStats[]
  awards: {
    bestPerformer: RecapCallerStats | null
    worstPerformer: RecapCallerStats | null
    mostWins: RecapCallerStats | null
    highestWinRate: RecapCallerStats | null
    mostConsistent: RecapCallerStats | null
    bestTrade: RecapTrade | null
  }
  topTrades: RecapTrade[]
  series: RecapSeriesPoint[]
  parseHealth: {
    parsed: number
    partial: number
    failed: number
    lastPostedAt: string | null
  }
}

/** Cached AI narration for one window; null until the first sweep generates it. */
export interface RecapInsight {
  windowDays: number
  generatedAt: string
  content: string
}

export interface RecapPerformanceResponse {
  performance: RecapPerformanceData
  insight: RecapInsight | null
}

/** Window filter choices; must match RECAP_WINDOW_DAYS_CHOICES server-side. */
export const RECAP_WINDOWS = [
  { days: 7, label: '7D' },
  { days: 30, label: '30D' },
  { days: 90, label: '90D' },
  { days: 180, label: '6M' },
  { days: 365, label: '1Y' },
] as const

export const fetchRecapPerformance = (
  days: number,
): Promise<RecapPerformanceResponse> =>
  request<RecapPerformanceResponse>(`/api/recaps/performance?days=${days}`)

/** GET /api/broker/status: the caller's Robinhood connection state. */
export interface BrokerStatus {
  connected: boolean
  /** Authorization URL awaiting consent; null when none is pending. */
  authUrl: string | null
  tokenState: 'missing' | 'valid' | 'refreshable' | 'expired' | null
  executionMode: 'immediate' | 'approval'
}

/** POST /api/broker/connect: the URL to open, or `connected` when already live. */
export interface BrokerConnectResult {
  connected: boolean
  authUrl: string | null
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${TRADER_URL}${path}`, {
    ...init,
    headers: { ...authHeaders(), ...init.headers },
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `${init.method ?? 'GET'} ${path} failed: ${res.status}`)
  }
  return res.json() as Promise<T>
}

const postJson = <T>(path: string, body: unknown): Promise<T> =>
  request<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

export const fetchDecisions = (): Promise<Decision[]> =>
  request<{ decisions: Decision[] }>('/api/decisions').then((r) => r.decisions)

export const fetchPerformance = (): Promise<PerformanceRow[]> =>
  request<{ positions: PerformanceRow[] }>('/api/trades/performance').then(
    (r) => r.positions,
  )

export const fetchSettings = (): Promise<TradeSettings> =>
  request<{ settings: TradeSettings }>('/api/settings').then((r) => r.settings)

export const fetchCallouts = (): Promise<CalloutItem[]> =>
  request<{ callouts: CalloutItem[] }>('/api/callouts').then((r) => r.callouts)

export const fetchCallers = (): Promise<Caller[]> =>
  request<{ callers: Caller[] }>('/api/callers').then((r) => r.callers)

export const fetchPortfolio = (): Promise<PortfolioSummary> =>
  request<PortfolioSummary>('/api/portfolio')

export const fetchBrokerStatus = (): Promise<BrokerStatus> =>
  request<BrokerStatus>('/api/broker/status')

/** Start the Robinhood OAuth flow and get the URL the user must approve. */
export const connectBroker = (): Promise<BrokerConnectResult> =>
  postJson<BrokerConnectResult>('/api/broker/connect', {})

/** POST the dead-end 127.0.0.1 redirect URL the user pasted after approving. */
export const submitBrokerRedirect = (redirectUrl: string): Promise<void> =>
  postJson<{ ok: true }>('/api/broker/callback', { redirectUrl }).then(() => undefined)

/**
 * Ask the server to email a one-time sign-in link. Unauthenticated on purpose —
 * this is where the session comes from — and gated server-side against the
 * invite allowlist.
 */
export async function requestMagicLink(email: string): Promise<void> {
  const res = await fetch(`${TRADER_URL}/api/auth/magic-link`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `sign in failed: ${res.status}`)
  }
}
