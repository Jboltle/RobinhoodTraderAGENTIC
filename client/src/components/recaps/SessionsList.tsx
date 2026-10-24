import { Link } from '@tanstack/react-router'

import { fmtUsd, pnlTone } from '../../lib/book'
import { dayLabel, groupByMonth, type Session } from '../../lib/sessions'

/** Sessions grouped by month: day, net, record and a win/loss dot strip per row. */
export function SessionsList({ sessions }: { sessions: readonly Session[] }) {
  return (
    <div className="flex flex-col gap-6">
      {groupByMonth(sessions).map((group) => (
        <section key={group.label}>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-ink-400">{group.label}</h3>
          <ul className="grid gap-2 md:grid-cols-2">
            {group.sessions.map((session) => (
              <SessionRow key={session.date} session={session} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

function SessionRow({ session }: { session: Session }) {
  const { dow, day } = dayLabel(session.date)
  const edge = session.net > 0 ? 'bg-gain' : session.net < 0 ? 'bg-loss' : 'bg-ink-600'
  return (
    <li>
      <Link
        to="/recaps"
        search={{ d: session.date }}
        className="relative flex items-center gap-4 overflow-hidden rounded-xl border border-ink-600 bg-ink-800 py-3 pr-4 pl-5 transition-colors hover:bg-ink-700/60"
      >
        <span className={`absolute inset-y-0 left-0 w-1 ${edge}`} />
        <span className="w-12 shrink-0 leading-tight">
          <span className="block text-[10px] uppercase text-ink-500">{dow}</span>
          <span className="block text-lg font-semibold tabular-nums text-white">{day}</span>
        </span>
        <span className={`w-24 shrink-0 font-semibold tabular-nums ${pnlTone(session.net)}`}>
          {session.trades.length === 0 ? '—' : fmtUsd(session.net)}
        </span>
        <span className="w-20 shrink-0 text-xs tabular-nums text-ink-400">
          {session.wins}W {session.losses}L
          {session.stillRunning.length > 0 && (
            <span className="ml-1 text-brand">· {session.stillRunning.length} open</span>
          )}
        </span>
        <DotStrip session={session} />
        {session.source === 'recap' && (
          <span className="ml-auto shrink-0 text-[10px] uppercase text-ink-500" title="Dollars are nominal ($5k per entry) from the Caller's posted recap">
            recap
          </span>
        )}
      </Link>
    </li>
  )
}

const MAX_DOTS = 16

function DotStrip({ session }: { session: Session }) {
  const dots = session.trades.slice(0, MAX_DOTS)
  return (
    <span className="flex min-w-0 flex-wrap gap-1">
      {dots.map((trade) => (
        <span
          key={trade.key}
          className={`size-1.5 rounded-full ${
            trade.result === 'win' ? 'bg-gain' : trade.result === 'loss' ? 'bg-loss' : 'bg-ink-500'
          }`}
        />
      ))}
      {session.trades.length > MAX_DOTS && (
        <span className="text-[10px] leading-none text-ink-500">+{session.trades.length - MAX_DOTS}</span>
      )}
    </span>
  )
}
