/**
 * Pure helpers over the tracked-callout book (GET /api/book): KPI totals,
 * Caller filtering, and the labels the cards and rows share.
 */
import type { TrackedPosition } from './api'

export interface PnlBucket {
  count: number
  usd: number
}

export interface BookSummary {
  /** Realized on the period's closes plus unrealized on what is still open. */
  netPnl: number
  realizedPnl: number
  unrealizedPnl: number
  winners: PnlBucket
  losers: PnlBucket
  /** Winners over decided closes (break-evens excluded); null with no closes. */
  winRatePct: number | null
}

export function summarizeBook(
  open: readonly TrackedPosition[],
  closed: readonly TrackedPosition[],
): BookSummary {
  const realizedPnl = closed.reduce((sum, p) => sum + p.realizedPnl, 0)
  const unrealizedPnl = open.reduce((sum, p) => sum + (p.unrealizedPnl ?? 0), 0)
  const winners = bucket(closed.filter((p) => p.result === 'win'))
  const losers = bucket(closed.filter((p) => p.result === 'loss'))
  const decided = winners.count + losers.count
  return {
    netPnl: realizedPnl + unrealizedPnl,
    realizedPnl,
    unrealizedPnl,
    winners,
    losers,
    winRatePct: decided === 0 ? null : (winners.count / decided) * 100,
  }
}

const bucket = (positions: readonly TrackedPosition[]): PnlBucket => ({
  count: positions.length,
  usd: positions.reduce((sum, p) => sum + p.realizedPnl, 0),
})

/** "Whose book": everyone, the Callers this account follows, or one Caller. */
export type CallerSelection = 'all' | 'following' | { authorId: string }

export function filterByCaller<T extends { authorId: string }>(
  positions: readonly T[],
  selection: CallerSelection,
  followedCallerIds: readonly string[] | null,
): T[] {
  if (selection === 'all') return [...positions]
  if (selection === 'following') {
    // null = the legacy "follow everyone".
    if (followedCallerIds === null) return [...positions]
    return positions.filter((p) => followedCallerIds.includes(p.authorId))
  }
  return positions.filter((p) => p.authorId === selection.authorId)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Swift's contract line: "Oct23 '26 680 C". */
export function contractLine(position: Pick<TrackedPosition, 'option'>): string {
  const { optionType, strike, expiration } = position.option
  const [year, month, day] = expiration.split('-').map(Number) as [number, number, number]
  return `${MONTHS[month - 1]}${day} '${String(year).slice(2)} ${strike} ${optionType === 'call' ? 'C' : 'P'}`
}

/** "680C 10/23": the compact form for rows and recap text. */
export function contractShort(position: Pick<TrackedPosition, 'option'>): string {
  const { optionType, strike, expiration } = position.option
  const [, month, day] = expiration.split('-').map(Number) as [number, number, number]
  return `${strike}${optionType === 'call' ? 'C' : 'P'} ${month}/${day}`
}

const USD_WHOLE = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})
const USD_CENTS = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

/** "+$1,250" / "-$80"; cents only when asked. */
export function fmtUsd(value: number, options: { cents?: boolean; signed?: boolean } = {}): string {
  const formatter = options.cents ? USD_CENTS : USD_WHOLE
  const body = formatter.format(Math.abs(value))
  if (value < 0) return `-${body}`
  return options.signed === false ? body : `+${body}`
}

/** A premium: "0.68" or "12.50". */
export const fmtPremium = (value: number): string => value.toFixed(2)

export const pnlTone = (value: number | null): string =>
  value === null || value === 0 ? 'text-ink-400' : value > 0 ? 'text-gain' : 'text-loss'
