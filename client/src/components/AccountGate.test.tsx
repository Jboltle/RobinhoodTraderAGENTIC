// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { AccountGate } from './AccountGate'
import { Outcome } from './TradesTable'
import { useViewedAccountId } from '../lib/accounts'
import { authHeaders, fetchAccounts, fetchSettings, setAccessTokenSource } from '../lib/api'
import type { AccountsResponse, Decision } from '../lib/api'

// The real api module over a stubbed network: what is asserted here is what
// the page actually sends, and under which account's name.

const VIEWED_ACCOUNT_HEADER = 'x-viewed-account'
const ROBINHOOD = 'account-robinhood'
const PAPER = 'account-paper'

const listViewing = (selectedAccountId: string): AccountsResponse => ({
  selectedAccountId,
  brokers: [],
  canConnectSnapTrade: false,
})

const pendingOn = (accountId: string): Decision => ({
  at: '2026-11-12T15:00:00.000Z',
  messageId: 'callout-1',
  kind: 'pending_approval',
  code: null,
  reason: `parked on ${accountId}`,
  ticker: 'QQQ',
  action: 'buy',
  order: null,
})

/** One request the page made: its path and the account it named, if any. */
interface SentRequest {
  path: string
  viewedAccount: string | undefined
}

let sent: SentRequest[]
/** What GET /api/accounts answers next; the last one keeps answering. */
let accountAnswers: Array<() => Response | Promise<Response>>
/** What an approve answers. */
let approveAnswer: () => Response

const pathsSent = (): string[] => sent.map((request) => request.path)

/** A stream that stays open and says nothing, like an idle /api/stream. */
const idleStream = (): Response => new Response(new ReadableStream<Uint8Array>(), { status: 200 })

beforeEach(() => {
  sent = []
  accountAnswers = [() => Response.json(listViewing(ROBINHOOD))]
  approveAnswer = () => Response.json({ decision: { ...pendingOn(ROBINHOOD), kind: 'submitted' } })
  setAccessTokenSource(() => 'a-session')
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const path = new URL(url, 'http://trader.test').pathname
      sent.push({
        path,
        viewedAccount: (init.headers as Record<string, string>)[VIEWED_ACCOUNT_HEADER],
      })
      if (path === '/api/accounts') {
        const answer = accountAnswers.length > 1 ? accountAnswers.shift()! : accountAnswers[0]
        return answer()
      }
      if (path === '/api/stream') return idleStream()
      if (path === '/api/settings') return Response.json({ settings: { maxTradesPerDay: 3 } })
      if (path.endsWith('/approve')) return approveAnswer()
      return Response.json({})
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** Every render of the account's screen: the account it was for, and what it showed. */
interface ScreenRender {
  accountId: string
  decisions: string[]
}
let renders: ScreenRender[]

/**
 * What an account-scoped route looks like to the gate: it reads the account's
 * settings, shows the decisions the stream filled in, and offers Approve.
 */
function AccountScreen() {
  const accountId = useViewedAccountId()
  const settings = useQuery({ queryKey: ['settings'], queryFn: fetchSettings })
  const decisions = useQuery<Decision[]>({ queryKey: ['decisions'], enabled: false })
  renders.push({ accountId, decisions: (decisions.data ?? []).map((decision) => decision.reason) })
  return (
    <section aria-label="account screen">
      <p>
        screen of {accountId}, settings {settings.isSuccess ? 'loaded' : 'loading'}
      </p>
      {(decisions.data ?? []).map((decision) => (
        <Outcome key={decision.messageId} decision={decision} />
      ))}
    </section>
  )
}

function renderGate() {
  renders = []
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <AccountGate>
        <AccountScreen />
      </AccountGate>
    </QueryClientProvider>,
  )
  return { queryClient, ...utils }
}

test('a list that cannot be read shows an error with a retry, and nothing of any account', async () => {
  accountAnswers = [
    () => Response.json({ error: 'trader unreachable' }, { status: 502 }),
    () => Response.json(listViewing(ROBINHOOD)),
  ]
  const utils = renderGate()

  const alert = await utils.findByRole('alert')
  expect(alert.textContent).toContain('Could not load your accounts: trader unreachable')
  // No stream opened, no account-scoped request sent, no screen rendered.
  expect(pathsSent()).toEqual(['/api/accounts'])
  expect(utils.queryByLabelText('account screen')).toBeNull()
  expect(renders).toEqual([])

  fireEvent.click(utils.getByRole('button', { name: 'Try again' }))

  await waitFor(() =>
    expect(utils.getByLabelText('account screen').textContent).toContain(
      `screen of ${ROBINHOOD}, settings loaded`,
    ),
  )
  expect(utils.queryByRole('alert')).toBeNull()
  // Everything sent once the list was known names the account it is for.
  await waitFor(() => expect(pathsSent()).toContain('/api/stream'))
  expect(sent.slice(2).map((request) => request.viewedAccount)).toEqual(
    sent.slice(2).map(() => ROBINHOOD),
  )
  expect(pathsSent().slice(2).sort()).toEqual(['/api/settings', '/api/stream'])
})

test('nothing is asked for while the list is still loading', async () => {
  let answerList: (response: Response) => void = () => {}
  const list = new Promise<Response>((resolve) => (answerList = resolve))
  accountAnswers = [() => list]
  const utils = renderGate()

  await waitFor(() => expect(pathsSent()).toEqual(['/api/accounts']))
  expect(utils.container.textContent).toBe('Loading…')
  expect(renders).toEqual([])

  answerList(Response.json(listViewing(ROBINHOOD)))
  await utils.findByLabelText('account screen')
  await waitFor(() => expect(pathsSent()).toContain('/api/stream'))
})

// The reviewer's probe. api.ts hears of the new account when the list
// arrives; the previous account's card is on screen until React re-renders.
test("an Approve clicked on the previous account's card names that account, not the new one", async () => {
  const { queryClient, ...utils } = renderGate()
  await utils.findByLabelText('account screen')
  queryClient.setQueryData<Decision[]>(['decisions'], [pendingOn(ROBINHOOD)])
  const approve = await utils.findByRole('button', { name: 'Approve' })

  // The list answers with the other account selected, and React has not
  // rendered since: read outside the query, exactly that gap.
  accountAnswers = [() => Response.json(listViewing(PAPER))]
  await fetchAccounts()
  expect(authHeaders()[VIEWED_ACCOUNT_HEADER]).toBe(PAPER)
  expect(renders.at(-1)).toEqual({ accountId: ROBINHOOD, decisions: [`parked on ${ROBINHOOD}`] })

  // The server refuses a request that names an account no longer selected.
  approveAnswer = () =>
    Response.json({ error: 'The selected account changed', code: 'account_changed' }, { status: 409 })
  fireEvent.click(approve)

  await waitFor(() => expect(pathsSent()).toContain('/api/trades/callout-1/approve'))
  const approval = sent.find((request) => request.path === '/api/trades/callout-1/approve')
  expect(approval?.viewedAccount).toBe(ROBINHOOD)

  // The refusal makes the page read the list again and follow the switch.
  await waitFor(() =>
    expect(utils.getByLabelText('account screen').textContent).toContain(`screen of ${PAPER}`),
  )
  expect(utils.queryByRole('button', { name: 'Approve' })).toBeNull()
})

test("the new account's screen never renders over what the previous account cached", async () => {
  const { queryClient, ...utils } = renderGate()
  await utils.findByLabelText('account screen')
  queryClient.setQueryData<Decision[]>(['decisions'], [pendingOn(ROBINHOOD)])
  await utils.findByRole('button', { name: 'Approve' })

  queryClient.setQueryData<AccountsResponse>(['accounts'], listViewing(PAPER))

  await waitFor(() =>
    expect(utils.getByLabelText('account screen').textContent).toContain(
      `screen of ${PAPER}, settings loaded`,
    ),
  )
  const rendersForPaper = renders.filter((screen) => screen.accountId === PAPER)
  expect(rendersForPaper.length).toBeGreaterThan(0)
  for (const screen of rendersForPaper) expect(screen.decisions).toEqual([])
  expect(utils.queryByRole('button', { name: 'Approve' })).toBeNull()
})
