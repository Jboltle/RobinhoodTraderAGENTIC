import type { RecapTrade } from '../../lib/api'
import { contractLabel, fmtPct, pctToneClass } from './format'

/** The window's ten biggest trades by percent gain (soft results excluded). */
export function TopTrades({ trades }: { trades: RecapTrade[] }) {
  return (
    <div className="rounded-xl border border-ink-600 bg-ink-800 p-4">
      <h3 className="mb-3 text-sm font-semibold text-white">Top trades</h3>
      {trades.length === 0 ? (
        <p className="text-sm text-ink-400">No trades in this window.</p>
      ) : (
        <ol className="flex flex-col">
          {trades.map((trade, i) => (
            <li
              key={`${trade.recapDate}-${trade.caller}-${i}`}
              className="flex items-center gap-3 border-t border-ink-600/50 py-2 first:border-t-0"
            >
              <span className="w-5 shrink-0 text-right text-xs tabular-nums text-ink-500">
                {i + 1}.
              </span>
              <span
                className={`w-20 shrink-0 text-right font-semibold tabular-nums ${pctToneClass(trade.pctGain)}`}
              >
                {fmtPct(trade.pctGain)}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-white">
                {contractLabel(trade)}
              </span>
              <span className="shrink-0 text-xs text-ink-400">
                {trade.caller} · {trade.recapDate}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
