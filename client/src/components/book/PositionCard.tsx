/**
 * One open tracked callout, Swift's card anatomy: P&L color bar on the left
 * edge; ticker, Caller and this account's outcome on the first row; the
 * contract on the second; unrealized $ and % on the right; the trim ladder;
 * then `qty @ entry -> mark` with the peak. Compact density drops the ladder
 * and the detail line.
 */
import type { Caller, Decision, TrackedPosition } from '../../lib/api'
import { contractLine, fmtPremium, fmtUsd, pnlTone } from '../../lib/book'
import { fmtPct } from '../performance/format'
import { CallerChip, MyOutcome } from './chips'
import { TrimLadder } from './TrimLadder'

export type Density = 'normal' | 'compact'

export function PositionCard({
  position,
  caller,
  decision,
  density,
}: {
  position: TrackedPosition
  caller: Caller | undefined
  decision: Decision | null | undefined
  density: Density
}) {
  const pnl = position.unrealizedPnl
  const bar = pnl === null ? 'bg-ink-600' : pnl >= 0 ? 'bg-gain' : 'bg-loss'
  const filled = position.ladder.filter((l) => l.filledAt).length

  return (
    <article className="relative overflow-hidden rounded-2xl border border-ink-600 bg-ink-800 pr-5 pl-6 py-4">
      <span className={`absolute inset-y-0 left-0 w-1 ${bar}`} />
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-base font-semibold text-white">{position.ticker}</span>
            <CallerChip caller={caller} authorId={position.authorId} />
            <MyOutcome decision={decision} />
          </div>
          <p className="mt-1 text-sm tabular-nums text-ink-400">{contractLine(position)}</p>
        </div>
        <div className="shrink-0 text-right tabular-nums">
          <p className={`text-lg font-semibold ${pnlTone(pnl)}`}>
            {pnl === null ? '—' : fmtUsd(pnl)}
          </p>
          <p className={`text-xs ${pnlTone(position.pctNow)}`}>
            {position.pctNow === null ? 'awaiting mark' : fmtPct(position.pctNow)}
          </p>
        </div>
      </div>

      {density === 'normal' && (
        <>
          <TrimLadder ladder={position.ladder} pctNow={position.pctNow} className="mt-3" />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs tabular-nums text-ink-400">
            {position.entryPrice === null ? (
              <span>No stated entry: priced from the first mark</span>
            ) : (
              <span>
                {position.remainingQty}
                {position.remainingQty !== position.nominalQty ? `/${position.nominalQty}` : ''} @{' '}
                {fmtPremium(position.entryPrice)}
                {' → '}
                {position.lastMark === null ? '—' : fmtPremium(position.lastMark)}
                {filled > 0 && (
                  <span className="ml-2 text-ink-500">
                    {filled}/{position.ladder.length} trims
                  </span>
                )}
              </span>
            )}
            <span className="flex gap-3">
              {position.highestPct !== null && (
                <span>
                  Peak <span className="text-white">{fmtPct(position.highestPct)}</span>
                </span>
              )}
              {position.realizedPnl !== 0 && (
                <span>
                  Realized{' '}
                  <span className={pnlTone(position.realizedPnl)}>{fmtUsd(position.realizedPnl)}</span>
                </span>
              )}
            </span>
          </div>
        </>
      )}
    </article>
  )
}
