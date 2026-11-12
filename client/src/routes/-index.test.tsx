// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { AccountGate } from '../components/AccountGate'
import type { AccountsResponse, BookResponse, Decision } from '../lib/api'
import { Route } from './index'

const listViewing = (selectedAccountId: string): AccountsResponse => ({
  selectedAccountId,
  brokers: [],
})

const api = vi.hoisted(() => ({
  fetchAccounts: vi.fn<() => Promise<AccountsResponse>>(),
  setAccountChangedHandler: vi.fn(),
  fetchBook: vi.fn<() => Promise<BookResponse>>(),
  fetchCallers: vi.fn(async () => []),
  fetchCallouts: vi.fn(async () => []),
  fetchPortfolio: vi.fn(async () => ({ portfolioValueUsd: 1000, openPositions: 0 })),
  fetchSettings: vi.fn(async () => ({ followedCallerIds: null })),
  approveTrade: vi.fn(),
  rejectTrade: vi.fn(),
}))
vi.mock('../lib/api', () => api)
// The test plays the stream's part by writing the caches it fills.
vi.mock('../lib/stream', () => ({ useTraderStream: vi.fn() }))

const EMPTY_BOOK: BookResponse = {
  period: 'today',
  today: '2026-11-11',
  asOf: '2026-11-11T15:00:00.000Z',
  open: [],
  closed: [],
}

/** What an account with nothing in it reads as once it HAS loaded. */
const REAL_ZEROS = ['Open 0', 'Closed today 0', 'no closes yet', '+$0', 'No trades yet.']

const Dashboard = Route.options.component!

async function renderDashboard() {
  // The router plugin splits a route's component into its own chunk; the
  // router loads it before rendering, and so does this.
  await Dashboard.preload?.()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <AccountGate>
        <Dashboard />
      </AccountGate>
    </QueryClientProvider>,
  )
  return { queryClient, ...utils }
}

/** The book request, left unanswered until the test answers it. */
function pendingBook(): (book: BookResponse) => void {
  let answer: (book: BookResponse) => void = () => {}
  api.fetchBook.mockImplementation(() => new Promise<BookResponse>((resolve) => (answer = resolve)))
  return (book) => answer(book)
}

const kpiValue = (container: HTMLElement, label: string): string | null | undefined =>
  Array.from(container.querySelectorAll('p'))
    .find((p) => p.textContent === label)
    ?.nextElementSibling?.textContent

function expectPlaceholders(container: HTMLElement): void {
  const text = container.textContent ?? ''
  for (const zero of REAL_ZEROS) expect(text, zero).not.toContain(zero)
  for (const label of ['Day P&L', 'Winners', 'Losers', 'Win rate']) {
    expect(kpiValue(container, label), label).toBe('—')
  }
  expect(text).toContain('Open —')
  expect(text).toContain('Closed today —')
  // The open entries and My trades each say they are loading.
  expect(text.match(/Loading…/g)?.length).toBeGreaterThanOrEqual(2)
}

beforeEach(() => {
  vi.clearAllMocks()
  api.fetchAccounts.mockResolvedValue(listViewing('account-robinhood'))
})

afterEach(() => {
  cleanup()
})

test('figures that have not loaded read as placeholders, on first load and after an account switch', async () => {
  let answerBook = pendingBook()
  const { container, queryClient } = await renderDashboard()

  // First load: the account list has answered and nothing else has yet. The
  // book has been asked for by then, so the answer below has someone waiting.
  await waitFor(() => {
    expectPlaceholders(container)
    expect(api.fetchBook).toHaveBeenCalledTimes(1)
  })

  // The book answers and the stream delivers its first snapshot: an account
  // with nothing in it now reads as real zeros.
  await act(async () => {
    answerBook(EMPTY_BOOK)
    queryClient.setQueryData<Decision[]>(['decisions'], [])
  })
  await waitFor(() => expect(container.textContent).toContain('Open 0'))
  for (const zero of REAL_ZEROS) expect(container.textContent, zero).toContain(zero)

  // The account list names another account: AccountGate empties every cache
  // (useResetOnAccountSwitch), so it is back to placeholders until the new
  // account's figures arrive.
  answerBook = pendingBook()
  await act(async () => {
    queryClient.setQueryData<AccountsResponse>(['accounts'], listViewing('account-paper'))
  })
  await waitFor(() => {
    expectPlaceholders(container)
    expect(api.fetchBook).toHaveBeenCalledTimes(2)
  })

  await act(async () => {
    answerBook(EMPTY_BOOK)
    queryClient.setQueryData<Decision[]>(['decisions'], [])
  })
  await waitFor(() => expect(container.textContent).toContain('Open 0'))
  expect(container.textContent).toContain('No trades yet.')
})
