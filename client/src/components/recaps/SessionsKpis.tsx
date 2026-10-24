import { fmtUsd, pnlTone } from '../../lib/book'
import { dayLabel, monthLabel, type SessionsKpis as Kpis } from '../../lib/sessions'

/** NET · RECORD · SESSIONS · BEST / WORST across every session shown. */
export function SessionsKpis({ kpis }: { kpis: Kpis }) {
  const record = kpis.wins + kpis.losses + kpis.breakEvens
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Card label="Net">
        <p className={`text-2xl font-semibold tabular-nums ${pnlTone(kpis.net)}`}>{fmtUsd(kpis.net)}</p>
        <p className="mt-1 text-xs text-ink-500">{record} closed trades</p>
      </Card>
      <Card label="Record">
        <p className="text-2xl font-semibold tabular-nums text-white">
          {kpis.wins}
          <span className="text-ink-500">/</span>
          {kpis.losses}
          {kpis.breakEvens > 0 && (
            <>
              <span className="text-ink-500">/</span>
              {kpis.breakEvens}
            </>
          )}
        </p>
        <Bar green={kpis.wins} red={kpis.losses} grey={kpis.breakEvens} />
      </Card>
      <Card label="Sessions">
        <p className="text-2xl font-semibold tabular-nums">
          <span className="text-gain">{kpis.green}</span>
          <span className="text-ink-500"> · </span>
          <span className="text-loss">{kpis.red}</span>
          {kpis.flat > 0 && (
            <>
              <span className="text-ink-500"> · </span>
              <span className="text-ink-400">{kpis.flat}</span>
            </>
          )}
        </p>
        <p className="mt-1 text-xs text-ink-500">green · red{kpis.flat > 0 ? ' · flat' : ''}</p>
      </Card>
      <Card label="Best / Worst">
        <SessionLine label="Best" session={kpis.best} />
        <SessionLine label="Worst" session={kpis.worst} />
      </Card>
    </div>
  )
}

function Card({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-ink-600 bg-ink-800 px-5 py-4">
      <p className="mb-1 text-xs uppercase tracking-wider text-ink-400">{label}</p>
      {children}
    </div>
  )
}

function SessionLine({ label, session }: { label: string; session: Kpis['best'] }) {
  if (!session) return <p className="text-sm text-ink-500">{label} —</p>
  const { dow, day } = dayLabel(session.date)
  return (
    <p className="flex items-baseline gap-2 text-sm tabular-nums">
      <span className="w-12 text-xs text-ink-500">{label}</span>
      <span className={`font-semibold ${pnlTone(session.net)}`}>{fmtUsd(session.net)}</span>
      <span className="text-xs text-ink-400">
        {dow} {day} {monthLabel(session.date).split(' ')[0]!.slice(0, 3)}
      </span>
    </p>
  )
}

/** Proportional W / L / BE strip. */
export function Bar({ green, red, grey }: { green: number; red: number; grey: number }) {
  const total = green + red + grey
  if (total === 0) return <div className="mt-2 h-1.5 rounded-full bg-ink-700" />
  const pct = (n: number) => `${(n / total) * 100}%`
  return (
    <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-ink-700">
      <span className="bg-gain" style={{ width: pct(green) }} />
      <span className="bg-loss" style={{ width: pct(red) }} />
      <span className="bg-ink-500" style={{ width: pct(grey) }} />
    </div>
  )
}
