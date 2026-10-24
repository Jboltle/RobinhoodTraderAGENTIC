/**
 * One closed tracked callout as a compact row: result dot, ticker and
 * contract, Caller, entry → exit, realized $ and ROI, peak, how it closed,
 * and this account's own outcome.
 */
import type { Caller, Decision, TrackedPosition } from '../../lib/api'
import { contractShort, fmtPremium, fmtUsd, pnlTone } from '../../lib/book'
import { fmtPct } from '../performance/format'
import { CallerChip, MyOutcome } from './chips'

const CLOSED_BY_LABEL: Record<NonNullable<TrackedPosition['closedBy']>, string> = {
  caller_exit: 'caller exit',
  ladder: 'ladder',
  expiry: 'expired',
}

export function ClosedRow({
  position,
  caller,
  decision,
}: {
  position: TrackedPosition
  caller: Caller | undefined
  decision: Decision | null | undefined
}) {
  const roi =
    position.entryPrice !== null && position.nominalQty > 0
      ? (position.realizedPnl / (position.entryPrice * position.nominalQty * 100)) * 100
      : null
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-ink-600 bg-ink-800 px-4 py-2.5 text-sm">
      <ResultDot result={position.result} />
      <span className="min-w-36 font-semibold text-white">
        {position.ticker}{' '}
        <span className="font-normal tabular-nums text-ink-400">{contractShort(position)}</span>
      </span>
      <CallerChip caller={caller} authorId={position.authorId} />
      <span className="tabular-nums text-ink-400">
        {position.entryPrice === null ? '—' : fmtPremium(position.entryPrice)}
        {' → '}
        {position.exitPrice === null ? '—' : fmtPremium(position.exitPrice)}
      </span>
      <span className={`ml-auto font-semibold tabular-nums ${pnlTone(position.realizedPnl)}`}>
        {fmtUsd(position.realizedPnl)}
      </span>
      <span className={`w-20 text-right tabular-nums ${pnlTone(roi)}`}>
        {roi === null ? '—' : fmtPct(roi)}
      </span>
      <span className="w-24 text-right text-xs tabular-nums text-ink-400">
        {position.highestPct === null ? '' : `peak ${fmtPct(position.highestPct)}`}
      </span>
      <span className="w-20 text-right text-xs text-ink-500">
        {position.closedBy ? CLOSED_BY_LABEL[position.closedBy] : ''}
      </span>
      <MyOutcome decision={decision} />
    </li>
  )
}

export function ResultDot({ result }: { result: TrackedPosition['result'] }) {
  const tone = result === 'win' ? 'bg-gain' : result === 'loss' ? 'bg-loss' : 'bg-ink-500'
  return <span className={`size-2 shrink-0 rounded-full ${tone}`} />
}
