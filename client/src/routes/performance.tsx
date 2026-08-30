import { createFileRoute } from '@tanstack/react-router'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { useState } from 'react'

import { AwardCards } from '../components/performance/AwardCards'
import { InsightPanel } from '../components/performance/InsightPanel'
import { LeaderboardTable } from '../components/performance/LeaderboardTable'
import { PerformanceCharts } from '../components/performance/PerformanceCharts'
import { TopTrades } from '../components/performance/TopTrades'
import {
  RECAP_WINDOWS,
  fetchRecapPerformance,
} from '../lib/api'
import type { RecapPerformanceData } from '../lib/api'

export const Route = createFileRoute('/performance')({
  component: PerformancePage,
  ssr: false,
})

/** Recaps land once a day; a lazy poll keeps an open tab current. */
const REFRESH_MS = 5 * 60_000

function PerformancePage() {
  const [days, setDays] = useState<number>(90)
  const query = useQuery({
    queryKey: ['recap-performance', days],
    queryFn: () => fetchRecapPerformance(days),
    refetchInterval: REFRESH_MS,
    placeholderData: keepPreviousData,
    retry: false,
  })

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-center gap-4">
        <div>
          <h1 className="text-xl font-semibold text-white">Performance &amp; Metrix</h1>
          {query.data && <MetaLine performance={query.data.performance} />}
        </div>
        <div className="ml-auto flex rounded-lg border border-ink-600 bg-ink-800 p-1">
          {RECAP_WINDOWS.map((window) => (
            <button
              key={window.days}
              type="button"
              onClick={() => setDays(window.days)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                days === window.days
                  ? 'bg-brand/15 text-brand'
                  : 'text-ink-400 hover:text-white'
              }`}
            >
              {window.label}
            </button>
          ))}
        </div>
      </header>

      {query.isPending && <EmptyState>Loading…</EmptyState>}
      {query.isError && (
        <EmptyState>
          Performance data unavailable ({(query.error as Error).message})
        </EmptyState>
      )}
      {query.isSuccess && query.data.performance.recapCount === 0 && (
        <EmptyState>
          No recaps stored yet. The server backfills the recap channel at boot
          and sweeps hourly on weekdays — check back after the first sweep.
        </EmptyState>
      )}

      {query.isSuccess && query.data.performance.recapCount > 0 && (
        <>
          <AwardCards
            awards={query.data.performance.awards}
            minTrades={query.data.performance.minTradesForAwards}
          />
          <PerformanceCharts
            series={query.data.performance.series}
            leaderboard={query.data.performance.leaderboard}
          />
          <LeaderboardTable
            leaderboard={query.data.performance.leaderboard}
            trades={query.data.performance.trades}
          />
          <section className="grid gap-4 lg:grid-cols-2">
            <TopTrades trades={query.data.performance.topTrades} />
            <InsightPanel insight={query.data.insight} />
          </section>
        </>
      )}
    </div>
  )
}

/** "62 recaps · 1,041 trades · 38 soft excluded · last recap Aug 29" + parse warnings. */
function MetaLine({ performance }: { performance: RecapPerformanceData }) {
  const parts = [
    `${performance.recapCount} recaps`,
    `${performance.tradeCount.toLocaleString()} trades`,
  ]
  if (performance.softExcluded > 0) {
    parts.push(`${performance.softExcluded} soft excluded`)
  }
  if (performance.toDate) parts.push(`last recap ${performance.toDate}`)

  const { partial, failed } = performance.parseHealth
  return (
    <p className="mt-1 text-xs text-ink-400">
      {parts.join(' · ')}
      {partial + failed > 0 && (
        <span className="ml-2 rounded bg-warn/10 px-1.5 py-0.5 text-warn">
          {partial > 0 ? `${partial} partially parsed` : ''}
          {partial > 0 && failed > 0 ? ', ' : ''}
          {failed > 0 ? `${failed} failed` : ''}
        </span>
      )}
    </p>
  )
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-ink-600 bg-ink-800 px-4 py-6 text-center text-sm text-ink-400">
      {children}
    </div>
  )
}
