import type { BookPeriod } from '../../lib/api'
import { fmtUsd, pnlTone, type BookSummary } from '../../lib/book'

const PERIOD_PNL_LABEL: Record<BookPeriod, string> = {
  today: 'Day P&L',
  week: 'Week P&L',
  all: 'All-time P&L',
}

/** The 2x2 strip at the top of the book: P&L, winners, losers, win rate. */
export function KpiGrid({ summary, period }: { summary: BookSummary; period: BookPeriod }) {
  const decided = summary.winners.count + summary.losers.count
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Kpi
        label={PERIOD_PNL_LABEL[period]}
        value={fmtUsd(summary.netPnl)}
        tone={pnlTone(summary.netPnl)}
        detail={
          summary.unrealizedPnl !== 0
            ? `${fmtUsd(summary.realizedPnl)} realized · ${fmtUsd(summary.unrealizedPnl)} open`
            : 'realized'
        }
      />
      <Kpi
        label="Winners"
        value={String(summary.winners.count)}
        tone="text-gain"
        detail={fmtUsd(summary.winners.usd)}
      />
      <Kpi
        label="Losers"
        value={String(summary.losers.count)}
        tone="text-loss"
        detail={fmtUsd(summary.losers.usd)}
      />
      <Kpi
        label="Win rate"
        value={summary.winRatePct === null ? '—' : `${Math.round(summary.winRatePct)}%`}
        tone="text-white"
        detail={decided === 0 ? 'no closes yet' : `${summary.winners.count}W ${summary.losers.count}L`}
      />
    </div>
  )
}

function Kpi({
  label,
  value,
  tone,
  detail,
}: {
  label: string
  value: string
  tone: string
  detail: string
}) {
  return (
    <div className="rounded-2xl border border-ink-600 bg-ink-800 px-5 py-4">
      <p className="text-xs text-ink-400">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${tone}`}>{value}</p>
      <p className="mt-1 text-xs tabular-nums text-ink-500">{detail}</p>
    </div>
  )
}
