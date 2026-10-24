/**
 * The DAILY RECAP text for one session — the inverse of the server's recap
 * parser (server/src/trader/recaps/parser.ts), so what Copy recap produces
 * is what the parser reads back:
 *
 *   DAILY RECAP | OCTOBER 21, 2026
 *
 *   HARVEY CALLS:
 *   🟩 $SPY - 10/21 680C @ 0.50 --> 1.00 | +100.00%
 *
 *   📊 STATS:
 *   Total Trades: 1
 *   ...
 */
import type { Session, SessionTrade } from './sessions'
import { recapHeaderDate } from './sessions'

const WIN_MARKER = '\u{1F7E9}'
const LOSS_MARKER = '\u{1F7E5}'

const signedPct = (value: number): string => `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`

/** `callerNames` resolves tracked rows' author ids; recap rows carry their own name. */
export function recapText(session: Session, callerNames: ReadonlyMap<string, string>): string {
  const sections = new Map<string, SessionTrade[]>()
  for (const trade of session.trades) {
    const name = trade.callerName ?? (trade.authorId && callerNames.get(trade.authorId)) ?? 'Desk'
    const list = sections.get(name) ?? []
    list.push(trade)
    sections.set(name, list)
  }

  const lines: string[] = [`DAILY RECAP | ${recapHeaderDate(session.date)}`, '']
  for (const [name, trades] of sections) {
    lines.push(`${name.toUpperCase()} CALLS:`)
    for (const trade of trades) lines.push(tradeLine(trade))
    lines.push('')
  }

  const rois = session.trades.map((t) => t.roiPct ?? 0)
  const totalPct = rois.reduce((sum, pct) => sum + pct, 0)
  lines.push(
    '\u{1F4CA} STATS:',
    `Total Trades: ${session.trades.length}`,
    `Winners: ${session.wins}`,
    `Losers: ${session.losses}`,
    `Total Options Gain: ${signedPct(totalPct)}`,
    `Average Gain per Options Call: ${signedPct(rois.length ? totalPct / rois.length : 0)}`,
  )
  return lines.join('\n')
}

function tradeLine(trade: SessionTrade): string {
  const marker = trade.result === 'loss' ? LOSS_MARKER : WIN_MARKER
  const prices =
    trade.entryPrice !== null && trade.exitPrice !== null
      ? ` @ ${trade.entryPrice.toFixed(2)} --> ${trade.exitPrice.toFixed(2)}`
      : ''
  // "680C 10/23" -> "10/23 680C": the recap puts the expiration first.
  const [strike, expiration] = trade.contract.split(' ')
  const contract = expiration ? `${expiration} ${strike}` : strike
  return `${marker} $${trade.ticker} - ${contract}${prices} | ${signedPct(trade.roiPct ?? 0)}`
}
