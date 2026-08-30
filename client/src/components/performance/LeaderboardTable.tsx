import { useState } from 'react'
import {
  createColumnHelper,
  createSortedRowModel,
  rowSortingFeature,
  tableFeatures,
  useTable,
} from '@tanstack/react-table'

import type { RecapCallerStats, RecapTrade } from '../../lib/api'
import { contractLabel, fmtPct, pctToneClass } from './format'

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
})

const helper = createColumnHelper<typeof features, RecapCallerStats>()

const pctCell = (value: number) => (
  <span className={`tabular-nums ${pctToneClass(value)}`}>{fmtPct(value)}</span>
)

const columns = helper.columns([
  helper.accessor('caller', {
    header: 'Caller',
    cell: ({ row, getValue }) => (
      <span className="font-medium text-white">
        {getValue()}
        {!row.original.qualifies && (
          <span className="ml-2 rounded bg-ink-700 px-1.5 py-0.5 text-[10px] text-ink-500">
            below floor
          </span>
        )}
      </span>
    ),
  }),
  helper.accessor('trades', { header: 'Trades' }),
  helper.accessor('wins', { header: 'W' }),
  helper.accessor('losses', { header: 'L' }),
  helper.accessor('winRatePct', {
    header: 'Win %',
    cell: ({ getValue }) => <span className="tabular-nums">{getValue().toFixed(1)}%</span>,
  }),
  helper.accessor('avgPct', { header: 'Avg %', cell: ({ getValue }) => pctCell(getValue()) }),
  helper.accessor('medianPct', { header: 'Med %', cell: ({ getValue }) => pctCell(getValue()) }),
  helper.accessor('totalPct', { header: 'Total %', cell: ({ getValue }) => pctCell(getValue()) }),
  helper.accessor('bestPct', { header: 'Best', cell: ({ getValue }) => pctCell(getValue()) }),
  helper.accessor('worstPct', { header: 'Worst', cell: ({ getValue }) => pctCell(getValue()) }),
  helper.accessor('stdDevPct', {
    header: 'σ',
    cell: ({ getValue }) => <span className="tabular-nums">{getValue().toFixed(1)}</span>,
  }),
])

const EMPTY_LEADERBOARD: RecapCallerStats[] = []

/**
 * Sortable caller leaderboard (TanStack Table v9). Clicking a row expands
 * that caller's full trade history for the window; soft trades appear there
 * dimmed and flagged, though they never count toward the stats columns.
 */
export function LeaderboardTable({
  leaderboard,
  trades,
}: {
  leaderboard: RecapCallerStats[]
  trades: RecapTrade[]
}) {
  // ponytail: expansion is one piece of local state rather than the table's
  // rowExpandingFeature — flat rows with a custom detail panel don't need a
  // row model for it.
  const [expandedCaller, setExpandedCaller] = useState<string | null>(null)

  const table = useTable({
    features,
    columns,
    data: leaderboard.length ? leaderboard : EMPTY_LEADERBOARD,
    initialState: { sorting: [{ id: 'avgPct', desc: true }] },
  })

  const columnCount = columns.length

  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold text-white">Leaderboard</h2>
        <span className="text-xs text-ink-500">
          click a column to sort · click a caller for their trades
        </span>
      </div>
      <div className="overflow-x-auto rounded-xl border border-ink-600 bg-ink-800">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-ink-400">
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => {
                  const sorted = header.column.getIsSorted()
                  return (
                    <th key={header.id} className="px-4 py-3 font-medium">
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        className="inline-flex items-center gap-1 hover:text-white"
                      >
                        {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                        <span className="w-2 text-[10px] text-brand">
                          {sorted === 'asc' ? '▲' : sorted === 'desc' ? '▼' : ''}
                        </span>
                      </button>
                    </th>
                  )
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => {
              const caller = row.original.caller
              const isExpanded = expandedCaller === caller
              return (
                <RowGroup key={row.id}>
                  <tr
                    onClick={() => setExpandedCaller(isExpanded ? null : caller)}
                    className={`cursor-pointer border-t border-ink-600 transition-colors hover:bg-ink-700/40 ${
                      row.original.qualifies ? '' : 'opacity-60'
                    } ${isExpanded ? 'bg-ink-700/30' : ''}`}
                  >
                    {row.getAllCells().map((cell) => (
                      <td key={cell.id} className="px-4 py-3 tabular-nums">
                        <table.FlexRender cell={cell} />
                      </td>
                    ))}
                  </tr>
                  {isExpanded && (
                    <tr className="border-t border-ink-600/60 bg-ink-900/40">
                      <td colSpan={columnCount} className="px-4 py-3">
                        <CallerTrades
                          trades={trades.filter((t) => t.caller === caller)}
                        />
                      </td>
                    </tr>
                  )}
                </RowGroup>
              )
            })}
            {leaderboard.length === 0 && (
              <tr>
                <td colSpan={columnCount} className="px-4 py-6 text-center text-ink-400">
                  No parsed trades in this window yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}

/** Fragment wrapper so the data row + detail row share one map key. */
const RowGroup = ({ children }: { children: React.ReactNode }) => <>{children}</>

function CallerTrades({ trades }: { trades: RecapTrade[] }) {
  const newestFirst = [...trades].sort((a, b) => b.recapDate.localeCompare(a.recapDate))
  return (
    <div className="max-h-72 overflow-y-auto">
      <table className="w-full text-left text-xs">
        <thead className="text-ink-500">
          <tr>
            <th className="py-1.5 pr-4 font-medium">Date</th>
            <th className="py-1.5 pr-4 font-medium">Contract</th>
            <th className="py-1.5 pr-4 font-medium">Entry → Exit</th>
            <th className="py-1.5 pr-4 font-medium">Result</th>
            <th className="py-1.5 font-medium">Note</th>
          </tr>
        </thead>
        <tbody>
          {newestFirst.map((trade, i) => (
            <tr
              key={`${trade.recapDate}-${i}`}
              className={`border-t border-ink-600/50 ${trade.isSoft ? 'opacity-50' : ''}`}
            >
              <td className="py-1.5 pr-4 tabular-nums text-ink-400">{trade.recapDate}</td>
              <td className="py-1.5 pr-4 font-medium text-white">{contractLabel(trade)}</td>
              <td className="py-1.5 pr-4 tabular-nums text-ink-400">
                {trade.entryPrice !== null && trade.exitPrice !== null
                  ? `${trade.entryPrice} → ${trade.exitPrice}`
                  : '—'}
              </td>
              <td className={`py-1.5 pr-4 tabular-nums ${pctToneClass(trade.pctGain)}`}>
                {fmtPct(trade.pctGain)}
                {trade.isSoft && (
                  <span className="ml-2 rounded bg-warn/10 px-1.5 py-0.5 text-[10px] text-warn">
                    soft — excluded
                  </span>
                )}
              </td>
              <td className="max-w-72 truncate py-1.5 text-ink-500" title={trade.note ?? ''}>
                {trade.note ?? ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
