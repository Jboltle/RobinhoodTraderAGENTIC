import { useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import type { RecapCallerStats, RecapSeriesPoint } from '../../lib/api'
import { callerColor } from './format'

const GRID_STROKE = '#1f1f1f' // ink-600
const TICK_FILL = '#999999' // ink-400
const TOOLTIP_STYLE = {
  backgroundColor: '#0a0a0a',
  border: '1px solid #1f1f1f',
  borderRadius: 8,
  fontSize: 12,
} as const

/**
 * Cumulative gain per caller (line, legend toggles) and win rate by caller
 * (bar, sub-floor callers dimmed). Caller colors follow leaderboard order so
 * both charts and the table agree.
 */
export function PerformanceCharts({
  series,
  leaderboard,
}: {
  series: RecapSeriesPoint[]
  leaderboard: RecapCallerStats[]
}) {
  return (
    <section className="grid gap-4 lg:grid-cols-2">
      <CumulativeGainChart series={series} leaderboard={leaderboard} />
      <WinRateChart leaderboard={leaderboard} />
    </section>
  )
}

function CumulativeGainChart({
  series,
  leaderboard,
}: {
  series: RecapSeriesPoint[]
  leaderboard: RecapCallerStats[]
}) {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const callers = leaderboard.map((c) => c.caller)

  const toggle = (caller: string): void => {
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(caller)) next.delete(caller)
      else next.add(caller)
      return next
    })
  }

  return (
    <ChartCard title="Cumulative gain %" subtitle="running sum of per-trade % by caller">
      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={series} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={GRID_STROKE} vertical={false} />
          <XAxis
            dataKey="date"
            tick={{ fill: TICK_FILL, fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: GRID_STROKE }}
            minTickGap={32}
            tickFormatter={shortDate}
          />
          <YAxis
            tick={{ fill: TICK_FILL, fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            width={52}
            tickFormatter={(v: number) => `${v}%`}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            labelStyle={{ color: TICK_FILL }}
            formatter={(value) => `${Number(value).toFixed(2)}%`}
          />
          {callers.map((caller, i) => (
            <Line
              key={caller}
              type="monotone"
              dataKey={caller}
              stroke={callerColor(i)}
              strokeWidth={1.5}
              dot={false}
              hide={hidden.has(caller)}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
      {/* Custom legend: recharts' own legend click payloads are fiddly to type. */}
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
        {callers.map((caller, i) => (
          <button
            key={caller}
            type="button"
            onClick={() => toggle(caller)}
            className={`flex items-center gap-1.5 text-xs transition-opacity ${
              hidden.has(caller) ? 'opacity-40' : ''
            }`}
          >
            <span
              className="size-2 rounded-full"
              style={{ backgroundColor: callerColor(i) }}
            />
            <span className="text-ink-400">{caller}</span>
          </button>
        ))}
      </div>
    </ChartCard>
  )
}

function WinRateChart({ leaderboard }: { leaderboard: RecapCallerStats[] }) {
  const byWinRate = [...leaderboard].sort((a, b) => b.winRatePct - a.winRatePct)
  const colorByCaller = new Map(leaderboard.map((c, i) => [c.caller, callerColor(i)]))

  return (
    <ChartCard title="Win rate by caller" subtitle="dimmed bars are under the award floor">
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={byWinRate} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={GRID_STROKE} vertical={false} />
          <XAxis
            dataKey="caller"
            tick={{ fill: TICK_FILL, fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: GRID_STROKE }}
            interval={0}
            angle={byWinRate.length > 6 ? -30 : 0}
            textAnchor={byWinRate.length > 6 ? 'end' : 'middle'}
            height={byWinRate.length > 6 ? 48 : 30}
          />
          <YAxis
            domain={[0, 100]}
            tick={{ fill: TICK_FILL, fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            width={40}
            tickFormatter={(v: number) => `${v}%`}
          />
          <Tooltip
            cursor={{ fill: '#191919' }}
            contentStyle={TOOLTIP_STYLE}
            labelStyle={{ color: TICK_FILL }}
            formatter={(value) => [`${Number(value).toFixed(1)}%`, 'win rate']}
          />
          <Bar dataKey="winRatePct" radius={[4, 4, 0, 0]} maxBarSize={48}>
            {byWinRate.map((entry) => (
              <Cell
                key={entry.caller}
                fill={colorByCaller.get(entry.caller)}
                fillOpacity={entry.qualifies ? 0.9 : 0.3}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

function ChartCard({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-xl border border-ink-600 bg-ink-800 p-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-white">{title}</h3>
        <span className="text-xs text-ink-500">{subtitle}</span>
      </div>
      {children}
    </div>
  )
}

/** "2026-08-19" -> "8/19" for axis ticks. */
function shortDate(iso: string): string {
  const [, month, day] = iso.split('-')
  return month && day ? `${Number(month)}/${Number(day)}` : iso
}
