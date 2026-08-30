import type { RecapTrade } from '../../lib/api'

/** Signed percent for display: 118.2 -> "+118.20%". */
export function fmtPct(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}

export function pctToneClass(value: number): string {
  return value >= 0 ? 'text-gain' : 'text-loss'
}

/** "$AAPL 312.5C 8/19" — compact contract label for a recap trade. */
export function contractLabel(trade: RecapTrade): string {
  const type = trade.optionType === 'put' ? 'P' : 'C'
  const contract = trade.strike !== null ? ` ${trade.strike}${type}` : ''
  const expiration = trade.expiration ? ` ${trade.expiration}` : ''
  return `$${trade.ticker}${contract}${expiration}`
}

/**
 * Stable per-caller line/bar colors, assigned by leaderboard order. Starts
 * from the theme accents so charts match the rest of the UI.
 */
export const CALLER_PALETTE = [
  '#00bddd', // brand
  '#0fedbe', // gain
  '#ffaa2b', // warn
  '#f63c6b', // loss
  '#a78bfa',
  '#f472b6',
  '#38bdf8',
  '#facc15',
  '#4ade80',
  '#fb923c',
] as const

export function callerColor(index: number): string {
  return CALLER_PALETTE[index % CALLER_PALETTE.length]!
}
