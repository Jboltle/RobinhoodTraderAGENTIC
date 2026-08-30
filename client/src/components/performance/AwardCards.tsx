import type { RecapCallerStats, RecapPerformanceData, RecapTrade } from '../../lib/api'
import { contractLabel, fmtPct, pctToneClass } from './format'

/**
 * Headline awards over the window. Only callers at or above the trade floor
 * can win the avg/rate/consistency awards; "most wins" is a raw count and
 * "best trade" is any single non-soft trade.
 */
export function AwardCards({
  awards,
  minTrades,
}: {
  awards: RecapPerformanceData['awards']
  minTrades: number
}) {
  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold text-white">Awards</h2>
        <span className="text-xs text-ink-500">callers with ≥ {minTrades} trades</span>
      </div>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <CallerAward
          label="Best performer"
          stats={awards.bestPerformer}
          metric={(s) => fmtPct(s.avgPct)}
          metricClass={(s) => pctToneClass(s.avgPct)}
          detail={(s) => `avg per trade · ${s.trades} trades`}
        />
        <CallerAward
          label="Worst performer"
          stats={awards.worstPerformer}
          metric={(s) => fmtPct(s.avgPct)}
          metricClass={(s) => pctToneClass(s.avgPct)}
          detail={(s) => `avg per trade · ${s.trades} trades`}
        />
        <CallerAward
          label="Most wins"
          stats={awards.mostWins}
          metric={(s) => String(s.wins)}
          detail={(s) => `winning trades of ${s.trades}`}
        />
        <CallerAward
          label="Highest win rate"
          stats={awards.highestWinRate}
          metric={(s) => `${s.winRatePct.toFixed(1)}%`}
          detail={(s) => `${s.wins}W / ${s.losses}L`}
        />
        <CallerAward
          label="Most consistent"
          stats={awards.mostConsistent}
          metric={(s) => `σ ${s.stdDevPct.toFixed(1)}`}
          detail={(s) => `${s.winRatePct.toFixed(1)}% win rate`}
        />
        <BestTradeAward trade={awards.bestTrade} />
      </div>
    </section>
  )
}

function CallerAward({
  label,
  stats,
  metric,
  detail,
  metricClass,
}: {
  label: string
  stats: RecapCallerStats | null
  metric: (stats: RecapCallerStats) => string
  detail: (stats: RecapCallerStats) => string
  metricClass?: (stats: RecapCallerStats) => string
}) {
  return (
    <AwardShell label={label}>
      {stats ? (
        <>
          <p className="truncate text-lg font-semibold text-white">{stats.caller}</p>
          <p className={`text-xl font-semibold tabular-nums ${metricClass?.(stats) ?? 'text-white'}`}>
            {metric(stats)}
          </p>
          <p className="mt-1 truncate text-xs text-ink-400">{detail(stats)}</p>
        </>
      ) : (
        <NoAward />
      )}
    </AwardShell>
  )
}

function BestTradeAward({ trade }: { trade: RecapTrade | null }) {
  return (
    <AwardShell label="Best trade">
      {trade ? (
        <>
          <p className={`text-xl font-semibold tabular-nums ${pctToneClass(trade.pctGain)}`}>
            {fmtPct(trade.pctGain)}
          </p>
          <p className="truncate text-sm font-medium text-white">{contractLabel(trade)}</p>
          <p className="mt-1 truncate text-xs text-ink-400">
            {trade.caller} · {trade.recapDate}
            {trade.entryPrice !== null && trade.exitPrice !== null
              ? ` · ${trade.entryPrice} → ${trade.exitPrice}`
              : ''}
          </p>
        </>
      ) : (
        <NoAward />
      )}
    </AwardShell>
  )
}

function AwardShell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-ink-600 bg-ink-800 p-4">
      <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-400">
        {label}
      </p>
      {children}
    </div>
  )
}

const NoAward = () => <p className="text-sm text-ink-500">Not enough trades</p>
