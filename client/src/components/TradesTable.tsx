/**
 * Trades table: one row per trade-relevant decision, joined with live prices
 * and the Caller who posted the originating callout.
 *
 * Skipped/rejected decisions carry no order, so instead of a row of dashes
 * they render compact — caller + ticker + the full rejection reason — and
 * dimmed. Every row expands on click into a detail panel (same local-state
 * pattern as performance/LeaderboardTable.tsx).
 */
import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  createColumnHelper,
  createSortedRowModel,
  rowSortingFeature,
  tableFeatures,
  useTable,
} from '@tanstack/react-table'

import { approveTrade, rejectTrade } from '../lib/api'
import type {
  Caller,
  CalloutItem,
  Decision,
  DecisionKind,
  PerformanceRow,
} from '../lib/api'
import { resolveTradeCaller, type TradeCallerFace } from '../lib/following'

/** Decision kinds that belong in the trades table at all. */
const TRADE_KINDS = new Set<DecisionKind>([
  'risk_rejected',
  'pending_approval',
  'rejected',
  'submitted',
  'execution_failed',
  'max_loss_exit',
])

/**
 * Kinds that never carried an order: rendering their empty Qty/Entry/Live
 * cells is noise, so they collapse to a compact reason row.
 */
export function isCompactKind(kind: DecisionKind): boolean {
  return kind === 'risk_rejected' || kind === 'rejected'
}

export type TradeStatusFilter =
  | 'all'
  | 'pending'
  | 'executed'
  | 'skipped'
  | 'failed'

const FILTER_KINDS: Record<Exclude<TradeStatusFilter, 'all'>, DecisionKind[]> = {
  pending: ['pending_approval'],
  executed: ['submitted', 'max_loss_exit'],
  skipped: ['risk_rejected', 'rejected'],
  failed: ['execution_failed'],
}

const FILTER_LABELS: Record<TradeStatusFilter, string> = {
  all: 'All',
  pending: 'Pending',
  executed: 'Executed',
  skipped: 'Skipped',
  failed: 'Failed',
}

const FILTER_ORDER: TradeStatusFilter[] = [
  'all',
  'pending',
  'executed',
  'skipped',
  'failed',
]

export function matchesTradeFilter(
  kind: DecisionKind,
  filter: TradeStatusFilter,
): boolean {
  return filter === 'all' || FILTER_KINDS[filter].includes(kind)
}

interface TradeRowData {
  decision: Decision
  position: PerformanceRow | undefined
  caller: TradeCallerFace | null
  callout: CalloutItem | undefined
}

const SHORT_TIME: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
}

/** "AAPL $150 call 9/26" for options, plain ticker for equities. */
function contractText(decision: Decision): string {
  const ticker = decision.order?.symbol ?? decision.ticker
  if (!ticker) return '—'
  const option = decision.order?.option
  if (!option) return ticker
  return `${ticker} $${option.strike} ${option.optionType} ${option.expiration}`
}

// =============================================================================
// Table definition (TanStack Table v9, same setup as LeaderboardTable)
// =============================================================================

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
})

const helper = createColumnHelper<typeof features, TradeRowData>()

const columns = helper.columns([
  helper.accessor((r) => r.caller?.name ?? '', {
    id: 'caller',
    header: 'Caller',
    cell: ({ row }) => <CallerCell caller={row.original.caller} />,
  }),
  helper.accessor((r) => contractText(r.decision), {
    id: 'contract',
    header: 'Contract',
    cell: ({ getValue }) => (
      <span className="font-medium text-white">{getValue()}</span>
    ),
  }),
  helper.accessor((r) => r.decision.order?.side ?? r.decision.action ?? '—', {
    id: 'side',
    header: 'Side',
    cell: ({ getValue }) => <SideChip side={getValue()} />,
  }),
  helper.accessor((r) => r.decision.order?.quantity, {
    id: 'qty',
    header: 'Qty',
    cell: ({ getValue }) => getValue() ?? '—',
  }),
  helper.accessor((r) => r.decision.order?.limitPrice, {
    id: 'entry',
    header: 'Entry',
    cell: ({ getValue }) => {
      const entry = getValue()
      return entry != null ? `$${entry.toFixed(2)}` : '—'
    },
  }),
  helper.accessor((r) => r.position?.pctChange, {
    id: 'livePct',
    header: 'Live %',
    cell: ({ getValue }) => {
      const pct = getValue()
      if (pct == null) return <span className="text-ink-500">—</span>
      return (
        <span className={pct >= 0 ? 'text-gain' : 'text-loss'}>
          {pct >= 0 ? '+' : ''}
          {pct.toFixed(2)}%
        </span>
      )
    },
  }),
  helper.accessor((r) => r.decision.at, {
    id: 'time',
    header: 'Time',
    cell: ({ getValue }) => (
      <span className="text-ink-400">
        {new Date(getValue()).toLocaleString(undefined, SHORT_TIME)}
      </span>
    ),
  }),
  helper.display({
    id: 'outcome',
    header: 'Outcome',
    cell: ({ row }) => <Outcome decision={row.original.decision} />,
  }),
])

const columnCount = columns.length

// =============================================================================
// Component
// =============================================================================

export function TradesTable({
  decisions,
  positions,
  callouts,
  callers,
}: {
  decisions: Decision[]
  positions: PerformanceRow[]
  callouts: CalloutItem[]
  callers: Caller[]
}) {
  const [filter, setFilter] = useState<TradeStatusFilter>('all')
  // Same local-state expansion as LeaderboardTable: flat rows with a custom
  // detail panel don't need the table's rowExpandingFeature.
  const [expandedKey, setExpandedKey] = useState<string | null>(null)

  const trades = useMemo(
    () => decisions.filter((d) => TRADE_KINDS.has(d.kind)),
    [decisions],
  )

  const rows = useMemo<TradeRowData[]>(() => {
    const calloutByMessageId = new Map(callouts.map((c) => [c.messageId, c]))
    const rosterByAuthorId = new Map(callers.map((c) => [c.authorId, c]))
    return (
      trades
        .filter((d) => matchesTradeFilter(d.kind, filter))
        // Pending first — the only rows the user can still act on — then
        // newest; column sorting on top of this order is the user's choice.
        .sort(
          (a, b) =>
            Number(b.kind === 'pending_approval') -
              Number(a.kind === 'pending_approval') ||
            b.at.localeCompare(a.at),
        )
        .map((decision) => ({
          decision,
          position: matchPosition(decision, positions),
          caller: resolveTradeCaller(
            decision.messageId,
            calloutByMessageId,
            rosterByAuthorId,
          ),
          callout: calloutByMessageId.get(decision.messageId),
        }))
    )
  }, [trades, positions, callouts, callers, filter])

  const table = useTable({ features, columns, data: rows })

  if (trades.length === 0) {
    return <Empty>No trades yet.</Empty>
  }

  return (
    <div className="flex flex-col gap-3">
      <FilterChips trades={trades} filter={filter} onChange={setFilter} />
      {rows.length === 0 ? (
        <Empty>No {FILTER_LABELS[filter].toLowerCase()} trades.</Empty>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-ink-600 bg-ink-800">
          <table className="w-full text-left text-sm tabular-nums">
            <thead className="text-xs text-ink-400">
              {table.getHeaderGroups().map((group) => (
                <tr key={group.id}>
                  {group.headers.map((header) => {
                    const sorted = header.column.getIsSorted()
                    return (
                      <th key={header.id} className="px-4 py-3 font-medium">
                        {header.column.getCanSort() ? (
                          <button
                            type="button"
                            onClick={header.column.getToggleSortingHandler()}
                            className="inline-flex items-center gap-1 hover:text-white"
                          >
                            {header.isPlaceholder ? null : (
                              <table.FlexRender header={header} />
                            )}
                            <span className="w-2 text-[10px] text-brand">
                              {sorted === 'asc' ? '▲' : sorted === 'desc' ? '▼' : ''}
                            </span>
                          </button>
                        ) : header.isPlaceholder ? null : (
                          <table.FlexRender header={header} />
                        )}
                      </th>
                    )
                  })}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.map((row) => {
                const { decision } = row.original
                const key = `${decision.messageId}-${decision.at}`
                const isExpanded = expandedKey === key
                return (
                  <RowGroup key={row.id}>
                    {isCompactKind(decision.kind) ? (
                      <CompactRow
                        data={row.original}
                        expanded={isExpanded}
                        onToggle={() => setExpandedKey(isExpanded ? null : key)}
                      />
                    ) : (
                      <tr
                        onClick={() => setExpandedKey(isExpanded ? null : key)}
                        className={`cursor-pointer border-t border-ink-600 transition-colors hover:bg-ink-700/40 ${
                          isExpanded ? 'bg-ink-700/30' : ''
                        }`}
                      >
                        {row.getAllCells().map((cell) => (
                          <td key={cell.id} className="px-4 py-3">
                            <table.FlexRender cell={cell} />
                          </td>
                        ))}
                      </tr>
                    )}
                    {isExpanded && <DetailRow data={row.original} />}
                  </RowGroup>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/** Fragment wrapper so the data row + detail row share one map key. */
const RowGroup = ({ children }: { children: React.ReactNode }) => <>{children}</>

function FilterChips({
  trades,
  filter,
  onChange,
}: {
  trades: Decision[]
  filter: TradeStatusFilter
  onChange: (filter: TradeStatusFilter) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {FILTER_ORDER.map((key) => {
        const count = trades.filter((d) => matchesTradeFilter(d.kind, key)).length
        const active = filter === key
        return (
          <button
            key={key}
            type="button"
            onClick={() => onChange(key)}
            className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
              active
                ? 'bg-brand/15 text-brand'
                : 'bg-ink-700 text-ink-400 hover:text-white'
            }`}
          >
            {FILTER_LABELS[key]}
            <span className={`ml-1.5 ${active ? 'text-brand/70' : 'text-ink-500'}`}>
              {count}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/**
 * Skipped/rejected decision: no order ever existed, so the reason gets the
 * width the empty Qty/Entry/Live cells would have wasted.
 */
function CompactRow({
  data,
  expanded,
  onToggle,
}: {
  data: TradeRowData
  expanded: boolean
  onToggle: () => void
}) {
  const { decision, caller } = data
  const code = decision.code ? ` [${decision.code}]` : ''
  return (
    <tr
      onClick={onToggle}
      className={`cursor-pointer border-t border-ink-600 opacity-60 transition-all hover:bg-ink-700/40 hover:opacity-100 ${
        expanded ? 'bg-ink-700/30 opacity-100' : ''
      }`}
    >
      <td className="px-4 py-3">
        <CallerCell caller={caller} />
      </td>
      <td colSpan={columnCount - 3} className="px-4 py-3">
        <span className="font-medium text-white">{contractText(decision)}</span>
        <span className="ml-3 text-ink-400">{decision.reason}</span>
      </td>
      <td className="px-4 py-3 text-ink-400">
        {new Date(decision.at).toLocaleString(undefined, SHORT_TIME)}
      </td>
      <td className="px-4 py-3">
        <span className={`${chipClass} bg-ink-700 text-ink-400`}>
          {decision.kind === 'risk_rejected' ? `skipped${code}` : 'rejected'}
        </span>
      </td>
    </tr>
  )
}

/** Expanded detail panel: everything known about the decision, full width. */
function DetailRow({ data }: { data: TradeRowData }) {
  const { decision, position, callout } = data
  const { order } = decision
  return (
    <tr className="border-t border-ink-600/60 bg-ink-900/40">
      <td colSpan={columnCount} className="px-4 py-4">
        <div className="grid gap-x-8 gap-y-2 text-xs sm:grid-cols-2 lg:grid-cols-3">
          <Detail label="When" value={new Date(decision.at).toLocaleString()} />
          <Detail
            label="Status"
            value={decision.kind + (decision.code ? ` [${decision.code}]` : '')}
          />
          {decision.reason && <Detail label="Reason" value={decision.reason} />}
          {order && (
            <>
              <Detail
                label="Order"
                value={`${order.side} ${order.quantity} ${order.symbol} (${order.assetType}, ${order.orderType})`}
              />
              {order.limitPrice != null && (
                <Detail label="Limit" value={`$${order.limitPrice.toFixed(2)}`} />
              )}
              {order.status && (
                <Detail
                  label="Broker status"
                  value={order.status + (order.orderId ? ` · ${order.orderId}` : '')}
                />
              )}
            </>
          )}
          {position && (
            <Detail
              label="Position"
              value={`entry ${position.entryPrice ?? '—'} → now ${
                position.currentPrice ?? '—'
              }`}
            />
          )}
        </div>
        {callout && (
          <div className="mt-3 border-l-2 border-brand/25 pl-3">
            <p className="text-xs text-ink-500">
              {callout.authorName} ·{' '}
              {new Date(callout.timestamp).toLocaleString(undefined, SHORT_TIME)}
            </p>
            <p className="mt-1 max-h-24 overflow-y-auto text-xs whitespace-pre-wrap text-ink-400">
              {callout.content}
            </p>
          </div>
        )}
      </td>
    </tr>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <p className="min-w-0">
      <span className="text-ink-500">{label}: </span>
      <span className="wrap-break-word text-ink-300">{value}</span>
    </p>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-ink-600 bg-ink-800 px-4 py-6 text-center text-sm text-ink-400">
      {children}
    </div>
  )
}

function matchPosition(
  decision: Decision,
  positions: PerformanceRow[],
): PerformanceRow | undefined {
  const symbol = decision.order?.symbol ?? decision.ticker
  if (!symbol) return undefined
  const option = decision.order?.option ?? null
  return positions.find((p) => {
    if (p.symbol !== symbol) return false
    if (option === null) return p.assetType === 'equity'
    return (
      p.assetType === 'option' &&
      p.optionType === option.optionType &&
      p.strike === option.strike &&
      p.expiration === option.expiration
    )
  })
}

function CallerCell({ caller }: { caller: TradeCallerFace | null }) {
  if (!caller) return <span className="text-ink-500">—</span>
  return (
    <span className="flex min-w-0 items-center gap-2 font-normal">
      {caller.avatarUrl ? (
        <img src={caller.avatarUrl} alt="" className="size-6 shrink-0 rounded-full" />
      ) : null}
      <span className="truncate text-white" title={caller.name}>
        {caller.name}
      </span>
    </span>
  )
}

function SideChip({ side }: { side: string }) {
  if (side !== 'buy' && side !== 'sell')
    return <span className="text-ink-500">{side}</span>
  const tone = side === 'buy' ? 'bg-gain/10 text-gain' : 'bg-loss/10 text-loss'
  return (
    <span
      className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium uppercase ${tone}`}
    >
      {side}
    </span>
  )
}

export const chipClass =
  'inline-flex max-w-full items-center truncate rounded-md px-2 py-0.5 text-xs font-medium'

/**
 * Approve / reject for one parked trade, in its own row.
 *
 * Deliberately per-row with no bulk action: the whole point of approval mode
 * is that each trade gets looked at, and one button that submits a backlog
 * would hand back the mass-execution problem it exists to prevent.
 */
function ApprovalControls({ decision }: { decision: Decision }) {
  const queryClient = useQueryClient()
  // The server pushes the resolved decision over SSE, so the mutation only
  // needs to refresh the callout feed's copy of the same outcome.
  const act = useMutation({
    mutationFn: (action: 'approve' | 'reject') =>
      action === 'approve'
        ? approveTrade(decision.messageId)
        : rejectTrade(decision.messageId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['callouts'] }),
  })

  if (act.isError) {
    return (
      <span
        className={`${chipClass} bg-loss/10 text-loss`}
        title={(act.error as Error).message}
      >
        {(act.error as Error).message}
      </span>
    )
  }

  // stopPropagation: these buttons live inside a click-to-expand row.
  return (
    <span className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        disabled={act.isPending}
        onClick={() => act.mutate('approve')}
        className="rounded-md bg-gain/15 px-2.5 py-1 text-xs font-medium text-gain transition-colors hover:bg-gain/25 disabled:opacity-50"
      >
        {act.isPending ? 'Working…' : 'Approve'}
      </button>
      <button
        type="button"
        disabled={act.isPending}
        onClick={() => act.mutate('reject')}
        className="rounded-md bg-ink-700 px-2.5 py-1 text-xs font-medium text-ink-400 transition-colors hover:text-white disabled:opacity-50"
      >
        Reject
      </button>
    </span>
  )
}

/** Outcome chip for a decision; shared with the callout feed cards. */
export function Outcome({ decision }: { decision: Decision }) {
  // Machine code from the trader (e.g. cooldown_active); older log entries predate it.
  const code = decision.code ? ` [${decision.code}]` : ''
  switch (decision.kind) {
    case 'submitted':
      return <span className={`${chipClass} bg-gain/10 text-gain`}>executed</span>
    case 'pending_approval':
      return <ApprovalControls decision={decision} />
    case 'rejected':
      return (
        <span className={`${chipClass} bg-ink-700 text-ink-400`}>rejected</span>
      )
    case 'risk_rejected':
      return (
        <span
          className={`${chipClass} bg-ink-700 text-ink-400`}
          title={decision.reason}
        >
          skipped{code}: {decision.reason}
        </span>
      )
    case 'execution_failed':
      return (
        <span
          className={`${chipClass} bg-loss/10 text-loss`}
          title={decision.reason}
        >
          failed{code}: {decision.reason}
        </span>
      )
    case 'missed':
      return (
        <span
          className={`${chipClass} bg-ink-700 text-ink-400`}
          title={decision.reason}
        >
          missed: too old to trade when the trader woke up
        </span>
      )
    case 'max_loss_exit':
      return (
        <span className={`${chipClass} bg-loss/10 text-loss`} title={decision.reason}>
          max loss
        </span>
      )
    default:
      return (
        <span className={`${chipClass} bg-ink-700 text-ink-400`}>
          {decision.kind}
        </span>
      )
  }
}
