import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import {
  authHeaders,
  fetchAccounts,
  fetchSettings,
  selectAccount,
  setAccessTokenSource,
  setAccountChangedHandler,
} from './api'

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
