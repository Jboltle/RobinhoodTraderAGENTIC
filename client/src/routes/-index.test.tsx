// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { AccountGate } from '../components/AccountGate'
import type {
  AccountsResponse,
  BookResponse,
  Decision,
  TrackedPosition,
  TradeSettings,
} from '../lib/api'
import { Route } from './index'

const listViewing = (selectedAccountId: string): AccountsResponse => ({
  selectedAccountId,
  brokers: [],
  canConnectSnapTrade: false,
})

const api = vi.hoisted(() => ({
  fetchAccounts: vi.fn<() => Promise<AccountsResponse>>(),
  setAccountChangedHandler: vi.fn(),
  fetchBook: vi.fn<() => Promise<BookResponse>>(),
  fetchCallers: vi.fn(async () => []),
  fetchCallouts: vi.fn(async () => []),
  fetchPortfolio: vi.fn(async () => ({ portfolioValueUsd: 1000, openPositions: 0 })),
  fetchSettings: vi.fn<() => Promise<Pick<TradeSettings, 'followedCallerIds'>>>(async () => ({
    followedCallerIds: null,
  })),
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

const position = (overrides: Partial<TrackedPosition>): TrackedPosition => ({
  messageId: 'm',
  authorId: 'harvey',
  ticker: 'SPY',
  option: { optionType: 'call', strike: 680, expiration: '2026-11-13' },
  entryPrice: 1,
  nominalQty: 50,
  openedAt: '2026-11-11T14:00:00.000Z',
  closedAt: null,
  closedBy: null,
  exitPrice: null,
  lastMark: null,
  lastMarkAt: null,
  highestPct: null,
  highestPrice: null,
  ladder: [],
  fills: [],
  result: null,
  remainingQty: 50,
  realizedPnl: 0,
  unrealizedPnl: null,
  pctNow: null,
  ...overrides,
})

/**
 * Two Callers' entries; the account follows harvey only.
 * Following: Open 1, nothing closed, Day P&L -$100.
 * Everyone:  Open 2, one close,      Day P&L -$500.
 */
const TWO_CALLER_BOOK: BookResponse = {
  ...EMPTY_BOOK,
  open: [
    position({ messageId: 'harvey-open', authorId: 'harvey', ticker: 'QQQ', unrealizedPnl: -100 }),
    position({ messageId: 'swift-open', authorId: 'swift', ticker: 'TSLA', unrealizedPnl: -900 }),
  ],
  closed: [
    position({
      messageId: 'swift-closed',
      authorId: 'swift',
      ticker: 'NVDA',
      closedAt: '2026-11-11T15:00:00.000Z',
      result: 'win',
      realizedPnl: 500,
    }),
  ],
}

function expectBookPlaceholders(container: HTMLElement): void {
  const text = container.textContent ?? ''
  for (const label of ['Day P&L', 'Winners', 'Losers', 'Win rate']) {
    expect(kpiValue(container, label), label).toBe('—')
  }
  expect(text).toContain('Open —')
  expect(text).toContain('Closed today —')
  // No entry of any Caller is listed.
  for (const ticker of ['QQQ', 'TSLA', 'NVDA']) expect(text, ticker).not.toContain(ticker)
}

function expectEveryonesBook(container: HTMLElement): void {
  const text = container.textContent ?? ''
  expect(kpiValue(container, 'Day P&L')).toBe('-$500')
  expect(text).toContain('Open 2')
  expect(text).toContain('Closed today 1')
  for (const ticker of ['QQQ', 'TSLA', 'NVDA']) expect(text, ticker).toContain(ticker)
}

const chooseBook = (container: HTMLElement, whose: 'following' | 'all'): void => {
  fireEvent.change(container.querySelector('select')!, { target: { value: whose } })
}

test("the Following book waits for the account's settings; everyone's figures never stand in", async () => {
  const answerBook = pendingBook()
  let answerSettings: (settings: Pick<TradeSettings, 'followedCallerIds'>) => void = () => {}
  api.fetchSettings.mockImplementationOnce(() => new Promise((resolve) => (answerSettings = resolve)))
  const { container } = await renderDashboard()
  await waitFor(() => {
    expect(api.fetchBook).toHaveBeenCalledTimes(1)
    expect(api.fetchSettings).toHaveBeenCalledTimes(1)
  })

  // The book has answered; whom the account follows is not known yet.
  await act(async () => answerBook(TWO_CALLER_BOOK))
  await waitFor(() => expect(container.textContent).toContain('marks as of'))
  expectBookPlaceholders(container)
  expect(container.textContent).toContain('Loading…')

  // Everyone's book does not depend on the settings: it shows at once, and
  // going back to Following is back to placeholders.
  chooseBook(container, 'all')
  expectEveryonesBook(container)
  chooseBook(container, 'following')
  expectBookPlaceholders(container)

  await act(async () => answerSettings({ followedCallerIds: ['harvey'] }))
  await waitFor(() => expect(container.textContent).toContain('Open 1'))
  expect(kpiValue(container, 'Day P&L')).toBe('-$100')
  expect(container.textContent).toContain('Closed today 0')
  expect(container.textContent).toContain('QQQ')
  expect(container.textContent).not.toContain('TSLA')
})

test('settings that cannot be read leave the Following book as placeholders and say why', async () => {
  const answerBook = pendingBook()
  api.fetchSettings.mockImplementationOnce(async () => {
    throw new Error('trader unreachable')
  })
  const { container } = await renderDashboard()
  await waitFor(() => expect(api.fetchBook).toHaveBeenCalledTimes(1))
  await act(async () => answerBook(TWO_CALLER_BOOK))

  await waitFor(() =>
    expect(container.textContent).toContain('Followed Callers unavailable (trader unreachable)'),
  )
  expectBookPlaceholders(container)

  chooseBook(container, 'all')
  expectEveryonesBook(container)
  expect(container.textContent).not.toContain('Followed Callers unavailable')
})
