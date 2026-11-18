/**
 * Positions table: one row per holding the viewed account's broker reports as
 * open. The columns are the ones a brokerage gives a position (Alpaca's
 * /v2/positions is the model). SnapTrade reports a quantity, a price and an
 * average cost per unit and no totals, so the totals are worked out here.
 */
import {
  createColumnHelper,
  createSortedRowModel,
  rowSortingFeature,
  tableFeatures,
  useTable,
} from '@tanstack/react-table'

import type { PerformanceRow } from '../lib/api'
import { contractLine, fmtUsd, pnlTone } from '../lib/book'
import { OPTION_MULTIPLIER } from '../lib/sessions'
import { fmtPct } from './performance/format'
import { SHORT_TIME } from './TradesTable'

export interface PositionValue {
  marketValue: number | null
  costBasis: number | null
  unrealizedPnl: number | null
}

/**
 * A position's totals from its per-unit figures. Null wherever the broker
 * gave no price or no average cost: a total is never guessed.
 *
 * ponytail: every option counts as a standard 100-share contract. Upgrade
 * path: carry SnapTrade's `instrument.multiplier` on PerformanceRow.
 */
export function positionValue(position: PerformanceRow): PositionValue {
  const unitsPerQuantity = position.assetType === 'option' ? OPTION_MULTIPLIER : 1
  const total = (perUnit: number | null): number | null =>
    perUnit === null ? null : perUnit * position.quantity * unitsPerQuantity
  const marketValue = total(position.currentPrice)
  const costBasis = total(position.entryPrice)
  return {
    marketValue,
    costBasis,
    unrealizedPnl: marketValue !== null && costBasis !== null ? marketValue - costBasis : null,
  }
}

/** "SPY Oct21 '26 772 C" for an option, the ticker alone for shares. */
function positionLabel(position: PerformanceRow): string {
  const { symbol, optionType, strike, expiration } = position
  if (optionType === undefined || strike === undefined || expiration === undefined) return symbol
  return `${symbol} ${contractLine({ option: { optionType, strike, expiration } })}`
}

const MISSING = <span className="text-ink-500">—</span>

const usdCell = (value: number | undefined): React.ReactNode =>
  value === undefined ? MISSING : fmtUsd(value, { cents: true, signed: false })

/**
 * How old a price that is no live mark is: the broker's own last known price
 * can be a day behind, so it never passes for a current one. Nothing for a
 * live mark, and no time is shown where the broker gave none.
 */
function PriceAge({ asOf }: { asOf: PerformanceRow['priceAsOf'] }): React.JSX.Element | null {
  if (asOf === undefined) return null
  return (
    <span className="block text-xs text-ink-400">
      {asOf === null ? (
        'last known, time not given'
      ) : (
        <>
          as of <time dateTime={asOf}>{new Date(asOf).toLocaleString(undefined, SHORT_TIME)}</time>
        </>
      )}
    </span>
  )
}

// =============================================================================
// Table definition (TanStack Table v9, same setup as LeaderboardTable)
// =============================================================================

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
})

const helper = createColumnHelper<typeof features, PerformanceRow>()

// A missing figure is `undefined` to the table, not null: that is the value
// `sortUndefined` keeps at the bottom.
const columns = helper.columns([
  helper.accessor(positionLabel, {
    id: 'position',
    header: 'Position',
    cell: ({ getValue }) => <span className="font-medium text-white">{getValue()}</span>,
  }),
  helper.accessor('quantity', { header: 'Qty' }),
  helper.accessor((position) => position.entryPrice ?? undefined, {
    id: 'avgEntry',
    header: 'Avg entry',
    cell: ({ getValue }) => usdCell(getValue()),
  }),
  helper.accessor((position) => position.currentPrice ?? undefined, {
    id: 'price',
    header: 'Price',
    cell: ({ getValue, row }) => (
      <>
        {usdCell(getValue())}
        <PriceAge asOf={row.original.priceAsOf} />
      </>
    ),
  }),
  helper.accessor((position) => positionValue(position).marketValue ?? undefined, {
    id: 'marketValue',
    header: 'Market value',
    cell: ({ getValue }) => usdCell(getValue()),
  }),
  helper.accessor((position) => positionValue(position).costBasis ?? undefined, {
    id: 'costBasis',
    header: 'Cost basis',
    cell: ({ getValue }) => usdCell(getValue()),
  }),
  helper.accessor((position) => positionValue(position).unrealizedPnl ?? undefined, {
    id: 'unrealizedPnl',
    header: 'P/L $',
    cell: ({ getValue }) => {
      const pnl = getValue()
      if (pnl === undefined) return MISSING
      return <span className={pnlTone(pnl)}>{fmtUsd(pnl, { cents: true })}</span>
    },
  }),
  helper.accessor((position) => position.pctChange ?? undefined, {
    id: 'unrealizedPnlPct',
    header: 'P/L %',
    cell: ({ getValue }) => {
      const pct = getValue()
      if (pct === undefined) return MISSING
      return <span className={pnlTone(pct)}>{fmtPct(pct)}</span>
    },
  }),
])

interface PositionsTableProps {
  positions: PerformanceRow[]
}

export function PositionsTable({ positions }: PositionsTableProps): React.JSX.Element {
  const table = useTable({
    features,
    columns,
    data: positions,
    // A position the broker gave no price for stays below the priced ones,
    // whichever way a column is sorted.
    defaultColumn: { sortUndefined: 'last' },
    initialState: { sorting: [{ id: 'marketValue', desc: true }] },
  })

  return (
    <div className="overflow-x-auto rounded-xl border border-ink-600 bg-ink-800">
      <table className="w-full text-left text-sm tabular-nums">
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
          {table.getRowModel().rows.map((row) => (
            <tr key={row.id} className="border-t border-ink-600">
              {row.getAllCells().map((cell) => (
                <td key={cell.id} className="px-4 py-3">
                  <table.FlexRender cell={cell} />
                </td>
              ))}
            </tr>
          ))}
          {positions.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="px-4 py-6 text-center text-ink-400">
                No open positions.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
