import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

import { CalloutCard } from '../components/CalloutCard'
import { ConnectBanner } from '../components/ConnectBanner'
import { fetchCallouts, fetchPortfolio } from '../lib/api'
import type {
  CalloutItem,
  Decision,
  PerformanceRow,
  PortfolioSummary,
  StageEvent,
} from '../lib/api'

export const Route = createFileRoute('/')({ component: Dashboard, ssr: false })

const FEED_POLL_MS = 60_000

function Dashboard() {
  // No queryFn/polling: both caches are hydrated and kept live by the SSE
  // stream (lib/stream.ts) — snapshot on connect, pushes thereafter.
  const decisions = useQuery<Decision[]>({
    queryKey: ['decisions'],
    enabled: false,
  })
  const performance = useQuery<PerformanceRow[]>({
    queryKey: ['performance'],
    enabled: false,
  })
  // Every callout the pipeline has recorded, each carrying this user's own
  // outcome. Polled: the SSE stream carries decisions, not the callouts
  // themselves, so a message that produced no decision arrives on this query.
  const callouts = useQuery<CalloutItem[]>({
    queryKey: ['callouts'],
    queryFn: fetchCallouts,
    refetchInterval: FEED_POLL_MS,
    retry: false,
  })

  return (
    <div className="flex flex-col gap-8">
      <ConnectBanner />
      <LiveStageBanner />
      <PortfolioSummaryBar />
      <section>
        <SectionTitle>Trades</SectionTitle>
        {performance.isError && (
          <p className="mb-3 inline-flex rounded-md bg-warn/10 px-3 py-1.5 text-xs text-warn">
            Live prices unavailable ({(performance.error as Error).message})
          </p>
        )}
        <TradesTable
          decisions={decisions.data ?? []}
          positions={performance.data ?? []}
        />
      </section>

      <section>
        <SectionTitle>Callout feed</SectionTitle>
        {callouts.isError && (
          <EmptyState>
            Callout feed unavailable ({(callouts.error as Error).message})
          </EmptyState>
        )}
        {callouts.isPending && <EmptyState>Loading…</EmptyState>}
        {callouts.isSuccess && <FeedList callouts={callouts.data} />}
      </section>
    </div>
  )
}

// =============================================================================
// Live trade lifecycle banner — driven by `stage` SSE frames (lib/stream.ts)
// =============================================================================

const STAGE_SEQUENCE = ['received', 'parsing', 'risk_check', 'executing'] as const
const STAGE_LABELS: Record<string, string> = {
  received: 'Received',
  parsing: 'Parsing',
  risk_check: 'Risk check',
  executing: 'Executing',
}

function LiveStageBanner() {
  // Hydrated by the SSE stream; null (or absent) = no trade in flight.
  const stage = useQuery<StageEvent | null>({
    queryKey: ['trade-stage'],
    enabled: false,
  })
  const event = stage.data
  if (!event) return null

  const activeIndex = STAGE_SEQUENCE.indexOf(
    event.stage as (typeof STAGE_SEQUENCE)[number],
  )

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-brand/40 bg-brand/8 px-5 py-3">
      <span className="size-2 animate-pulse rounded-full bg-brand" />
      <span className="text-sm font-medium text-white">
        Trade in progress{event.ticker ? `: ${event.ticker}` : ''}
      </span>
      <ol className="flex items-center gap-2 text-xs">
        {STAGE_SEQUENCE.map((s, i) => (
          <li key={s} className="flex items-center gap-2">
            {i > 0 && <span className="text-ink-500">→</span>}
            <span
              className={
                i < activeIndex
                  ? 'text-ink-400'
                  : i === activeIndex
                    ? 'font-semibold text-brand'
                    : 'text-ink-500'
              }
            >
              {STAGE_LABELS[s]}
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}

// =============================================================================
// Portfolio summary — total account value + open positions count
// =============================================================================

const USD = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
})

function PortfolioSummaryBar() {
  // Polled: totals aren't on the SSE stream and don't need 5s freshness.
  const portfolio = useQuery<PortfolioSummary>({
    queryKey: ['portfolio'],
    queryFn: fetchPortfolio,
    refetchInterval: 60_000,
    retry: false,
  })
  const data = portfolio.data

  return (
    <section className="flex flex-wrap gap-4">
      <Stat
        label="Portfolio value"
        value={
          data?.portfolioValueUsd != null
            ? USD.format(data.portfolioValueUsd)
            : '—'
        }
      />
      <Stat label="Open positions" value={data ? String(data.openPositions) : '—'} />
      {portfolio.isError && (
        <p className="self-center rounded-md bg-warn/10 px-3 py-1.5 text-xs text-warn">
          Portfolio unavailable ({(portfolio.error as Error).message})
        </p>
      )}
    </section>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-40 rounded-xl border border-ink-600 bg-ink-800 px-5 py-4">
      <p className="text-xs text-ink-400">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-white">
        {value}
      </p>
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-3 text-base font-semibold text-white">{children}</h2>
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-ink-600 bg-ink-800 px-4 py-6 text-center text-sm text-ink-400">
      {children}
    </div>
  )
}

// =============================================================================
// Trades table: one row per trade-relevant decision, joined with live prices
// =============================================================================

const TRADE_KINDS = new Set([
  'risk_rejected',
  'pending_approval',
  'submitted',
  'execution_failed',
])

function TradesTable({
  decisions,
  positions,
}: {
  decisions: Decision[]
  positions: PerformanceRow[]
}) {
  const trades = decisions.filter((d) => TRADE_KINDS.has(d.kind))

  if (trades.length === 0) {
    return <EmptyState>No trades yet.</EmptyState>
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-ink-600 bg-ink-800">
      <table className="w-full text-left text-sm tabular-nums">
        <thead className="text-xs text-ink-400">
          <tr>
            <Th>Ticker</Th>
            <Th>Side</Th>
            <Th>Qty</Th>
            <Th>Strike / Expiry</Th>
            <Th>Entry</Th>
            <Th>Live %</Th>
            <Th>Outcome</Th>
          </tr>
        </thead>
        <tbody>
          {trades.map((d) => (
            <TradeRow
              key={`${d.messageId}-${d.at}`}
              decision={d}
              position={matchPosition(d, positions)}
            />
          ))}
        </tbody>
      </table>
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

function TradeRow({
  decision,
  position,
}: {
  decision: Decision
  position: PerformanceRow | undefined
}) {
  const { order } = decision
  const ticker = order?.symbol ?? decision.ticker ?? '—'
  const side = order?.side ?? decision.action ?? '—'
  const option = order?.option ?? null
  const qty = order?.quantity
  const entry = order?.limitPrice ?? null
  const pct = position?.pctChange ?? null

  return (
    <tr className="border-t border-ink-600 transition-colors hover:bg-ink-700/40">
      <Td className="font-medium text-white">{ticker}</Td>
      <Td>
        <SideChip side={side} />
      </Td>
      <Td>{qty ?? '—'}</Td>
      <Td>
        {option
          ? `$${option.strike} ${option.optionType} ${option.expiration}`
          : '—'}
      </Td>
      <Td>{entry !== null ? `$${entry.toFixed(2)}` : '—'}</Td>
      <Td
        className={
          pct === null ? 'text-ink-500' : pct >= 0 ? 'text-gain' : 'text-loss'
        }
      >
        {pct !== null ? `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%` : '—'}
      </Td>
      <Td>
        <Outcome decision={decision} />
      </Td>
    </tr>
  )
}

function SideChip({ side }: { side: string }) {
  if (side !== 'buy' && side !== 'sell')
    return <span className="text-ink-500">{side}</span>
  const tone =
    side === 'buy' ? 'bg-gain/10 text-gain' : 'bg-loss/10 text-loss'
  return (
    <span
      className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium uppercase ${tone}`}
    >
      {side}
    </span>
  )
}

const chipClass =
  'inline-flex max-w-full items-center truncate rounded-md px-2 py-0.5 text-xs font-medium'

function Outcome({ decision }: { decision: Decision }) {
  // Machine code from the trader (e.g. cooldown_active); older log entries predate it.
  const code = decision.code ? ` [${decision.code}]` : ''
  switch (decision.kind) {
    case 'submitted':
      return <span className={`${chipClass} bg-gain/10 text-gain`}>executed</span>
    case 'pending_approval':
      return (
        <span className={`${chipClass} bg-warn/10 text-warn`}>
          approval pending
        </span>
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
    default:
      return (
        <span className={`${chipClass} bg-ink-700 text-ink-400`}>
          {decision.kind}
        </span>
      )
  }
}

const Th = ({ children }: { children: React.ReactNode }) => (
  <th className="px-4 py-3 font-medium">{children}</th>
)

const Td = ({
  children,
  className = '',
}: {
  children: React.ReactNode
  className?: string
}) => <td className={`px-4 py-3 ${className}`}>{children}</td>

// =============================================================================
// Callout feed
// =============================================================================

/** Every callout the pipeline saw, newest-first, with this user's outcome. */
function FeedList({ callouts }: { callouts: CalloutItem[] }) {
  if (callouts.length === 0) {
    return <EmptyState>No callouts yet.</EmptyState>
  }
  return (
    <div className="flex flex-col gap-3">
      {callouts.map((callout) => (
        <CalloutFeedCard key={callout.messageId} callout={callout} />
      ))}
    </div>
  )
}

function CalloutFeedCard({ callout }: { callout: CalloutItem }) {
  const { decision } = callout
  return (
    <CalloutCard
      authorName={callout.authorName}
      channelName={callout.channelName}
      timestamp={callout.timestamp}
      content={callout.content}
      embeds={callout.embeds}
      dashed={decision === null}
      footer={
        decision ? (
          <>
            <Outcome decision={decision} />
            {decision.kind === 'submitted' && (
              <span className="text-ink-400">{decision.reason}</span>
            )}
          </>
        ) : (
          <SharedOutcome parseStatus={callout.parseStatus} />
        )
      }
    />
  )
}

/**
 * What the feed shows when this account has no decision for a callout. The
 * pipeline records nothing per user for channel chatter or a failed parse,
 * because the outcome is the same for everyone and already on the shared row.
 */
function SharedOutcome({ parseStatus }: { parseStatus: CalloutItem['parseStatus'] }) {
  switch (parseStatus) {
    case 'not_callout':
      return <span className={`${chipClass} bg-ink-700 text-ink-400`}>not a callout</span>
    case 'failed':
      return <span className={`${chipClass} bg-loss/10 text-loss`}>parse failed</span>
    default:
      // 'parsed' with no decision, or 'skipped': the callout predates this
      // account's connection, so nothing was ever run for it.
      return <span className={`${chipClass} bg-ink-700 text-ink-500`}>not traded</span>
  }
}
