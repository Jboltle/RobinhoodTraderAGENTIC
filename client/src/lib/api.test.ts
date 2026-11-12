import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import {
  approveTrade,
  authHeaders,
  disconnectBroker,
  fetchAccounts,
  fetchSettings,
  rejectTrade,
  selectAccount,
  setAccessTokenSource,
  setAccountChangedHandler,
} from './api'
import { saveSettings } from './settingsSync'

const VIEWED_ACCOUNT_HEADER = 'x-viewed-account'

let token: string
let answers: Response[]

beforeEach(() => {
  token = 'first-session'
  answers = []
  setAccessTokenSource(() => token)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => answers.shift() ?? Response.json({})),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  setAccountChangedHandler(() => {})
})

/** The x-viewed-account header of each request made so far, in order. */
const viewedAccountsSent = (): Array<string | undefined> =>
  vi
    .mocked(fetch)
    .mock.calls.map(
      ([, init]) => (init?.headers as Record<string, string>)[VIEWED_ACCOUNT_HEADER],
    )

test('every request names the account the server last said is selected', async () => {
  answers.push(Response.json({ selectedAccountId: 'account-robinhood', brokers: [] }))
  await fetchAccounts()
  await fetchSettings().catch(() => {})

  answers.push(Response.json({ selectedAccountId: 'account-paper' }))
  await selectAccount('account-paper')
  await fetchSettings().catch(() => {})

  expect(viewedAccountsSent()).toEqual([
    // Nothing is known before the first list arrives, so nothing is claimed.
    undefined,
    'account-robinhood',
    'account-robinhood',
    'account-paper',
  ])
})

test('the account named for one session is not sent on another', async () => {
  answers.push(Response.json({ selectedAccountId: 'account-robinhood', brokers: [] }))
  await fetchAccounts()
  expect(authHeaders()[VIEWED_ACCOUNT_HEADER]).toBe('account-robinhood')

  token = 'someone-else-signed-in'

  expect(authHeaders()).toEqual({ authorization: 'Bearer someone-else-signed-in' })
})

test('a change names the account its control was rendered under, not the one last heard of', async () => {
  // The list has just said paper is selected; the Robinhood account's
  // controls are still on screen.
  answers.push(Response.json({ selectedAccountId: 'account-paper', brokers: [] }))
  await fetchAccounts()
  expect(authHeaders()[VIEWED_ACCOUNT_HEADER]).toBe('account-paper')

  answers.push(Response.json({ decision: {} }), Response.json({ decision: {} }))
  await approveTrade('callout-1', 'account-robinhood')
  await rejectTrade('callout-1', 'account-robinhood')
  await disconnectBroker('account-robinhood')
  answers.push(Response.json({ settings: {} }))
  await saveSettings({}, 'account-robinhood')

  const pathsSent = vi.mocked(fetch).mock.calls.map(([url]) => new URL(String(url)).pathname)
  expect(pathsSent.slice(1)).toEqual([
    '/api/trades/callout-1/approve',
    '/api/trades/callout-1/reject',
    '/api/broker/disconnect',
    '/api/settings',
  ])
  expect(viewedAccountsSent().slice(1)).toEqual([
    'account-robinhood',
    'account-robinhood',
    'account-robinhood',
    'account-robinhood',
  ])
})

test('a refusal for naming no account is handled like one for a stale account', async () => {
  const onAccountChanged = vi.fn()
  setAccountChangedHandler(onAccountChanged)

  answers.push(
    Response.json(
      { error: 'This page is out of date. Reload it and try again.', code: 'account_not_named' },
      { status: 409 },
    ),
  )
  await expect(approveTrade('callout-1', 'account-robinhood')).rejects.toThrow('Reload it')
  expect(onAccountChanged).toHaveBeenCalledTimes(1)
})

test('only a refusal for a stale account reports that the account changed', async () => {
  const onAccountChanged = vi.fn()
  setAccountChangedHandler(onAccountChanged)

  answers.push(Response.json({ error: 'Robinhood is not connected' }, { status: 409 }))
  await expect(fetchSettings()).rejects.toThrow('Robinhood is not connected')
  expect(onAccountChanged).not.toHaveBeenCalled()

  answers.push(
    Response.json({ error: 'The selected account changed', code: 'account_changed' }, { status: 409 }),
  )
  await expect(fetchSettings()).rejects.toThrow('The selected account changed')
  expect(onAccountChanged).toHaveBeenCalledTimes(1)
})
