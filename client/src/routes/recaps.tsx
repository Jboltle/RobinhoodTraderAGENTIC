import { createFileRoute } from '@tanstack/react-router'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'

import { SessionDetail } from '../components/recaps/SessionDetail'
import { SessionsKpis } from '../components/recaps/SessionsKpis'
import { SessionsList } from '../components/recaps/SessionsList'
import { fetchBook, fetchCallers, fetchCallouts, fetchRecapPerformance } from '../lib/api'
import type { BookResponse, Caller, CalloutItem, Decision, RecapPerformanceResponse } from '../lib/api'
import { buildSessions, sessionsKpis } from '../lib/sessions'

/** `?d=YYYY-MM-DD` opens one session; anything else is the list. */
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

export const Route = createFileRoute('/recaps')({
  component: RecapsPage,
  ssr: false,
  validateSearch: (search: Record<string, unknown>): { d?: string } =>
    typeof search.d === 'string' && ISO_DAY.test(search.d) ? { d: search.d } : {},
})

/** Widest recap window the server offers; the fallback for pre-tracking days. */
const RECAP_FALLBACK_DAYS = 365
const REFRESH_MS = 60_000

function RecapsPage() {
  const { d } = Route.useSearch()
  const book = useQuery<BookResponse>({
    queryKey: ['book', 'all'],
    queryFn: () => fetchBook('all'),
    refetchInterval: REFRESH_MS,
    placeholderData: keepPreviousData,
    retry: false,
  })
  const recaps = useQuery<RecapPerformanceResponse>({
    queryKey: ['recap-performance', RECAP_FALLBACK_DAYS],
    queryFn: () => fetchRecapPerformance(RECAP_FALLBACK_DAYS),
    retry: false,
  })
  const callers = useQuery<Caller[]>({ queryKey: ['callers'], queryFn: fetchCallers, retry: false })
  const decisions = useQuery<Decision[]>({ queryKey: ['decisions'], enabled: false })
  const callouts = useQuery<CalloutItem[]>({ queryKey: ['callouts'], queryFn: fetchCallouts, retry: false })

  const sessions = useMemo(
    () => buildSessions(book.data, recaps.data?.performance.trades),
    [book.data, recaps.data],
  )
  const decisionByMessageId = useMemo(() => {
    const map = new Map<string, Decision>()
    for (const item of callouts.data ?? []) if (item.decision) map.set(item.messageId, item.decision)
    for (const decision of decisions.data ?? []) map.set(decision.messageId, decision)
    return map
  }, [callouts.data, decisions.data])

  const selected = d ? sessions.find((s) => s.date === d) : undefined
  const loading = book.isPending && recaps.isPending

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-xl font-semibold text-white">Recaps</h1>
        <p className="mt-1 text-xs text-ink-400">
          Every Caller entry, priced and settled; one session per trading day.
          {book.isError && ` Book unavailable (${(book.error as Error).message}).`}
          {recaps.isError && ` Posted recaps unavailable (${(recaps.error as Error).message}).`}
        </p>
      </header>

      {loading && <EmptyState>Loading…</EmptyState>}

      {!loading && d && !selected && <EmptyState>No session on {d}.</EmptyState>}

      {selected && (
        <SessionDetail
          session={selected}
          callers={callers.data ?? []}
          decisionByMessageId={decisionByMessageId}
        />
      )}

      {!loading && !d && (
        <>
          <SessionsKpis kpis={sessionsKpis(sessions)} />
          {sessions.length === 0 ? (
            <EmptyState>
              No sessions yet. Tracked entries appear here as they close; days before tracking began
              fall back to the Callers’ posted recaps.
            </EmptyState>
          ) : (
            <SessionsList sessions={sessions} />
          )}
        </>
      )}
    </div>
  )
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-ink-600 bg-ink-800 px-4 py-6 text-center text-sm text-ink-400">
      {children}
    </div>
  )
}
