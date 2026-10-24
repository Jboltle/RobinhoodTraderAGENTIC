/**
 * Trading sessions for the Recaps page: one per ET trading day, built from
 * the tracked-callout book and, for days before tracking began, from the
 * parsed Discord DAILY RECAP posts.
 *
 * A tracked day wins over a recap day outright: the recap is the Caller's
 * own summary of the same entries, so showing both would double-count.
 * Recap-sourced dollars are nominal — the $5k rule applied to the recap's
 * entry and exit — and flagged so the UI can say so.
 */
import type { BookResponse, RecapTrade, TrackedPosition, TrackedResult } from './api'

/** Swift's nominal position for an entry with no stated size; mirrors book/ladder.ts. */
export const NOMINAL_POSITION_USD = 5000
const OPTION_MULTIPLIER = 100

export interface SessionTrade {
  key: string
  ticker: string
  /** "680C 10/23" */
  contract: string
  /** Discord author id when tracked; null for recap rows (name only). */
  authorId: string | null
  /** Recap section name ("Harvey"); null for tracked rows (resolve via callers). */
  callerName: string | null
  entryPrice: number | null
  exitPrice: number | null
  pnl: number
  roiPct: number | null
  peakPct: number | null
  result: TrackedResult
  /** Dollars are the $5k nominal rule on a recap line, not a tracked fill record. */
  nominal: boolean
  tracked: TrackedPosition | null
}

export interface Session {
  /** ISO ET trading day. */
  date: string
  source: 'tracked' | 'recap'
  trades: SessionTrade[]
  net: number
  wins: number
  losses: number
  breakEvens: number
  /** Tracked entries opened that day and still open. */
  stillRunning: TrackedPosition[]
}

export interface SessionsKpis {
  net: number
  wins: number
  losses: number
  breakEvens: number
  green: number
  red: number
  flat: number
  best: Session | null
  worst: Session | null
}

/** YYYY-MM-DD of an ISO timestamp in New York time. */
export function isoDateEt(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso))
}

/** Sessions newest first. Either source may be absent while loading. */
export function buildSessions(
  book: BookResponse | undefined,
  recapTrades: readonly RecapTrade[] | undefined,
): Session[] {
  const byDate = new Map<string, Session>()

  for (const position of book?.closed ?? []) {
    const date = isoDateEt(position.closedAt!)
    const session = byDate.get(date) ?? emptySession(date, 'tracked')
    session.trades.push(trackedTrade(position))
    byDate.set(date, session)
  }
  for (const position of book?.open ?? []) {
    const date = isoDateEt(position.openedAt)
    const session = byDate.get(date) ?? emptySession(date, 'tracked')
    session.stillRunning.push(position)
    byDate.set(date, session)
  }

  for (const trade of recapTrades ?? []) {
    if (trade.isSoft) continue
    const existing = byDate.get(trade.recapDate)
    if (existing?.source === 'tracked') continue
    const session = existing ?? emptySession(trade.recapDate, 'recap')
    session.trades.push(recapTrade(trade))
    byDate.set(trade.recapDate, session)
  }

  return [...byDate.values()]
    .map(total)
    .filter((s) => s.trades.length > 0 || s.stillRunning.length > 0)
    .sort((a, b) => b.date.localeCompare(a.date))
}

const emptySession = (date: string, source: Session['source']): Session => ({
  date,
  source,
  trades: [],
  net: 0,
  wins: 0,
  losses: 0,
  breakEvens: 0,
  stillRunning: [],
})

function total(session: Session): Session {
  return {
    ...session,
    net: session.trades.reduce((sum, t) => sum + t.pnl, 0),
    wins: session.trades.filter((t) => t.result === 'win').length,
    losses: session.trades.filter((t) => t.result === 'loss').length,
    breakEvens: session.trades.filter((t) => t.result === 'be').length,
  }
}

function trackedTrade(position: TrackedPosition): SessionTrade {
  const { optionType, strike, expiration } = position.option
  const [, month, day] = expiration.split('-').map(Number) as [number, number, number]
  const cost =
    position.entryPrice !== null ? position.entryPrice * position.nominalQty * OPTION_MULTIPLIER : null
  return {
    key: position.messageId,
    ticker: position.ticker,
    contract: `${strike}${optionType === 'call' ? 'C' : 'P'} ${month}/${day}`,
    authorId: position.authorId,
    callerName: null,
    entryPrice: position.entryPrice,
    exitPrice: position.exitPrice,
    pnl: position.realizedPnl,
    roiPct: cost !== null && cost > 0 ? (position.realizedPnl / cost) * 100 : null,
    peakPct: position.highestPct,
    result: position.result ?? 'be',
    nominal: false,
    tracked: position,
  }
}

function recapTrade(trade: RecapTrade): SessionTrade {
  const type = trade.optionType === 'put' ? 'P' : 'C'
  const contract = `${trade.strike !== null ? `${trade.strike}${type}` : ''}${trade.expiration ? ` ${trade.expiration}` : ''}`.trim()
  return {
    key: `${trade.recapDate}:${trade.lineRaw}`,
    ticker: trade.ticker,
    contract,
    authorId: null,
    callerName: trade.caller,
    entryPrice: trade.entryPrice,
    exitPrice: trade.exitPrice,
    pnl: nominalPnl(trade),
    roiPct: trade.pctGain,
    peakPct: null,
    result: trade.pctGain > 0 ? 'win' : trade.pctGain < 0 ? 'loss' : 'be',
    nominal: true,
    tracked: null,
  }
}

/**
 * Dollars for a recap line under the $5k rule: whole contracts at the stated
 * entry when there is one, else the percentage straight off $5k.
 */
export function nominalPnl(trade: Pick<RecapTrade, 'entryPrice' | 'exitPrice' | 'pctGain'>): number {
  const { entryPrice, exitPrice } = trade
  if (entryPrice !== null && entryPrice > 0 && exitPrice !== null) {
    const qty = Math.max(1, Math.round(NOMINAL_POSITION_USD / (entryPrice * OPTION_MULTIPLIER)))
    return (exitPrice - entryPrice) * qty * OPTION_MULTIPLIER
  }
  return (NOMINAL_POSITION_USD * trade.pctGain) / 100
}

export function sessionsKpis(sessions: readonly Session[]): SessionsKpis {
  const decided = sessions.filter((s) => s.trades.length > 0)
  const byNet = [...decided].sort((a, b) => b.net - a.net)
  return {
    net: sessions.reduce((sum, s) => sum + s.net, 0),
    wins: sessions.reduce((sum, s) => sum + s.wins, 0),
    losses: sessions.reduce((sum, s) => sum + s.losses, 0),
    breakEvens: sessions.reduce((sum, s) => sum + s.breakEvens, 0),
    green: decided.filter((s) => s.net > 0).length,
    red: decided.filter((s) => s.net < 0).length,
    flat: decided.filter((s) => s.net === 0).length,
    best: byNet[0] ?? null,
    worst: byNet.at(-1) ?? null,
  }
}

export interface MonthGroup {
  /** "October 2026" */
  label: string
  sessions: Session[]
}

/** Sessions (already newest first) grouped by calendar month, newest month first. */
export function groupByMonth(sessions: readonly Session[]): MonthGroup[] {
  const groups: MonthGroup[] = []
  for (const session of sessions) {
    const label = monthLabel(session.date)
    const group = groups.at(-1)
    if (group?.label === label) group.sessions.push(session)
    else groups.push({ label, sessions: [session] })
  }
  return groups
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]
const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function monthLabel(isoDate: string): string {
  const [year, month] = isoDate.split('-').map(Number) as [number, number]
  return `${MONTH_NAMES[month - 1]} ${year}`
}

/** "Wed 21" for a session row. */
export function dayLabel(isoDate: string): { dow: string; day: number } {
  const [year, month, day] = isoDate.split('-').map(Number) as [number, number, number]
  return { dow: DOW_NAMES[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]!, day }
}

/** "OCTOBER 21, 2026", the DAILY RECAP header date. */
export function recapHeaderDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number) as [number, number, number]
  return `${MONTH_NAMES[month - 1]!.toUpperCase()} ${day}, ${year}`
}
