import { createFileRoute } from '@tanstack/react-router'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'

import { CalloutCard } from '../components/CalloutCard'
import { Outcome, TradesTable, chipClass } from '../components/TradesTable'
import { ClosedRow } from '../components/book/ClosedRow'
import { KpiGrid } from '../components/book/KpiGrid'
import { PeriodToggle } from '../components/book/PeriodToggle'
import { PositionCard, type Density } from '../components/book/PositionCard'
import {
  fetchBook,
  fetchCallers,
  fetchCallouts,
  fetchPortfolio,
  fetchSettings,
} from '../lib/api'
import type {
  BookPeriod,
  BookResponse,
  Caller,
  CalloutItem,
  Decision,
  PerformanceRow,
  PortfolioSummary,
  StageEvent,
  TradeSettings,
} from '../lib/api'
import { filterByCaller, summarizeBook, type CallerSelection } from '../lib/book'

export const Route = createFileRoute('/')({ component: Dashboard, ssr: false })

const FEED_POLL_MS = 60_000
/** Fallback cadence; the SSE `book` frame invalidates this query on every change. */
const BOOK_POLL_MS = 60_000

const CLOSED_HEADING: Record<BookPeriod, string> = {
  today: 'Closed today',
  week: 'Closed this week',
  all: 'Closed',
}

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
  // Following drives what the feed DISPLAYS; the trade gate is server-side.
  const settings = useQuery<TradeSettings>({
    queryKey: ['settings'],
    queryFn: fetchSettings,
    retry: false,
  })
  const callers = useQuery<Caller[]>({
    queryKey: ['callers'],
    queryFn: fetchCallers,
    retry: false,
  })

  // null (or settings still loading) = show everyone. Callouts stored before
  // author identity was kept (authorId null) stay visible.
  const followedCallerIds = settings.data?.followedCallerIds ?? null
  const visibleCallouts = (callouts.data ?? []).filter(
    (c) =>
      followedCallerIds === null ||
      c.authorId == null ||
      followedCallerIds.includes(c.authorId),
  )

  // This account's outcome per callout message, for the badge on each card.
  // ponytail: both sources are the most recent page (50 decisions, 100
  // callouts), so an older open entry can read "not traded" after a busy day.
  // Upgrade path: a decisions lookup by message ids on /api/book.
  const decisionByMessageId = useMemo(() => {
    const map = new Map<string, Decision>()
    for (const item of callouts.data ?? []) if (item.decision) map.set(item.messageId, item.decision)
    for (const decision of decisions.data ?? []) map.set(decision.messageId, decision)
    return map
  }, [callouts.data, decisions.data])

  const pending = (decisions.data ?? []).filter((d) => d.kind === 'pending_approval')

  return (
    <div className="flex flex-col gap-8">
      <LiveStageBanner />
      {pending.length > 0 && <PendingApprovals decisions={pending} />}

      <Book
        callers={callers.data ?? []}
        followedCallerIds={followedCallerIds}
        decisionByMessageId={decisionByMessageId}
      />

      <section>
        <SectionTitle>My trades</SectionTitle>
        <div className="flex flex-col gap-4">
          <PortfolioSummaryBar />
          {performance.isError && (
            <p className="inline-flex self-start rounded-md bg-warn/10 px-3 py-1.5 text-xs text-warn">
              Live prices unavailable ({(performance.error as Error).message})
            </p>
          )}
          <TradesTable
            decisions={decisions.data ?? []}
            positions={performance.data ?? []}
            callouts={callouts.data ?? []}
            callers={callers.data ?? []}
          />
        </div>
      </section>

      <section>
        <SectionTitle>Callout feed</SectionTitle>
        {callouts.isError && (
          <EmptyState>
            Callout feed unavailable ({(callouts.error as Error).message})
          </EmptyState>
        )}
        {callouts.isPending && <EmptyState>Loading…</EmptyState>}
        {callouts.isSuccess && <FeedList callouts={visibleCallouts} />}
      </section>
    </div>
  )
}

// =============================================================================
// Pending approvals — one row per parked trade, each with its own controls
// =============================================================================

function PendingApprovals({ decisions }: { decisions: Decision[] }) {
  return (
    <section className="rounded-2xl border border-warn/40 bg-warn/8 px-5 py-3">
      <p className="mb-2 text-sm font-medium text-white">
        {decisions.length} trade{decisions.length === 1 ? '' : 's'} awaiting your approval
      </p>
      <ul className="flex flex-col gap-2">
        {decisions.map((decision) => (
          <li key={decision.messageId} className="flex flex-wrap items-center gap-3 text-sm">
            <span className="font-semibold text-white">{decision.ticker ?? '—'}</span>
            <span className="min-w-0 flex-1 truncate text-xs text-ink-400" title={decision.reason}>
              {decision.reason}
            </span>
            <Outcome decision={decision} />
          </li>
        ))}
      </ul>
    </section>
  )
}

// =============================================================================
// The book — every followed Caller's entries, priced live
// =============================================================================

function Book({
  callers,
  followedCallerIds,
  decisionByMessageId,
}: {
  callers: Caller[]
  followedCallerIds: string[] | null
  decisionByMessageId: Map<string, Decision>
}) {
  const [period, setPeriod] = useState<BookPeriod>('today')
  const [selection, setSelection] = useState<CallerSelection>('following')
  const [tickerFilter, setTickerFilter] = useState('')
  const [density, setDensity] = useState<Density>('normal')

  const book = useQuery<BookResponse>({
    queryKey: ['book', period],
    queryFn: () => fetchBook(period),
    refetchInterval: BOOK_POLL_MS,
    placeholderData: keepPreviousData,
    retry: false,
  })

  const callerById = useMemo(() => new Map(callers.map((c) => [c.authorId, c])), [callers])
  const open = filterByCaller(book.data?.open ?? [], selection, followedCallerIds)
  const closed = filterByCaller(book.data?.closed ?? [], selection, followedCallerIds)
  const summary = summarizeBook(open, closed)
  const needle = tickerFilter.trim().toUpperCase()
  const visibleOpen = needle ? open.filter((p) => p.ticker.includes(needle)) : open

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <PeriodToggle value={period} onChange={setPeriod} />
        <label className="flex items-center gap-2 text-xs text-ink-400">
          Whose book
          <select
            value={selectionKey(selection)}
            onChange={(e) => setSelection(selectionFromKey(e.target.value))}
            className="rounded-lg border border-ink-600 bg-ink-800 px-3 py-2 text-sm text-white focus:border-brand focus:outline-none"
          >
            <option value="following">Following</option>
            <option value="all">Everyone</option>
            {callers.map((caller) => (
              <option key={caller.authorId} value={`caller:${caller.authorId}`}>
                {caller.displayName}
              </option>
            ))}
          </select>
        </label>
        {book.isError && (
          <p className="rounded-md bg-warn/10 px-3 py-1.5 text-xs text-warn">
            Book unavailable ({(book.error as Error).message})
          </p>
        )}
        {book.data && (
          <span className="ml-auto text-xs text-ink-500">
            marks as of {new Date(book.data.asOf).toLocaleTimeString()}
          </span>
        )}
      </div>

      <KpiGrid summary={summary} period={period} />

      <div>
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <SectionTitle inline>Open {open.length}</SectionTitle>
          <input
            type="search"
            value={tickerFilter}
            onChange={(e) => setTickerFilter(e.target.value)}
            placeholder="Filter ticker"
            className="w-36 rounded-lg border border-ink-600 bg-ink-800 px-3 py-1.5 text-xs text-white placeholder:text-ink-500 focus:border-brand focus:outline-none"
          />
          <div className="ml-auto flex rounded-lg border border-ink-600 bg-ink-800 p-0.5">
            {(['normal', 'compact'] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setDensity(option)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors ${
                  density === option ? 'bg-ink-700 text-white' : 'text-ink-400 hover:text-white'
                }`}
              >
                {option}
              </button>
            ))}
          </div>
        </div>
        {book.isPending && <EmptyState>Loading…</EmptyState>}
        {book.isSuccess && visibleOpen.length === 0 && (
          <EmptyState>
            {open.length === 0
              ? 'No open entries. A Caller’s next Buy shows up here, priced every 15 s during market hours.'
              : 'No open entries match that ticker.'}
          </EmptyState>
        )}
        {visibleOpen.length > 0 && (
          <div className={`grid gap-3 ${density === 'compact' ? 'lg:grid-cols-3' : 'lg:grid-cols-2'}`}>
            {visibleOpen.map((position) => (
              <PositionCard
                key={position.messageId}
                position={position}
                caller={callerById.get(position.authorId)}
                decision={decisionByMessageId.get(position.messageId)}
                density={density}
              />
            ))}
          </div>
        )}
      </div>

      <div>
        <SectionTitle>
          {CLOSED_HEADING[period]} {closed.length}
        </SectionTitle>
        {book.isSuccess && closed.length === 0 && <EmptyState>Nothing closed in this period.</EmptyState>}
        {closed.length > 0 && (
          <ul className="flex flex-col gap-2">
            {closed.map((position) => (
              <ClosedRow
                key={position.messageId}
                position={position}
                caller={callerById.get(position.authorId)}
                decision={decisionByMessageId.get(position.messageId)}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

const selectionKey = (selection: CallerSelection): string =>
  typeof selection === 'string' ? selection : `caller:${selection.authorId}`

const selectionFromKey = (key: string): CallerSelection =>
  key === 'following' || key === 'all' ? key : { authorId: key.slice('caller:'.length) }

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
  // Polled: totals aren't on the SSE stream, and a minute is fresh enough.
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

function SectionTitle({ children, inline = false }: { children: React.ReactNode; inline?: boolean }) {
  return <h2 className={`text-base font-semibold text-white ${inline ? '' : 'mb-3'}`}>{children}</h2>
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-ink-600 bg-ink-800 px-4 py-6 text-center text-sm text-ink-400">
      {children}
    </div>
  )
}

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
            {(decision.kind === 'submitted' || decision.kind === 'max_loss_exit') && (
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
