// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  accountState,
  connectsThroughRobinhood,
  institutionName,
  listAccounts,
  selectedAccount,
  useAccounts,
  useResetOnAccountSwitch,
} from './accounts'
import type { AccountSummary, AccountsResponse, SnapTradeAccountSummary } from './api'

const fetchAccounts = vi.hoisted(() => vi.fn<() => Promise<AccountsResponse>>())
vi.mock('./api', () => ({ fetchAccounts }))

const robinhood: AccountSummary = {
  id: 'account-robinhood',
  label: 'Robinhood',
  institution: 'robinhood',
  isPaper: false,
  connected: true,
  needsReconnect: false,
  executionMode: 'immediate',
  followedCallerCount: 2,
}
const paper: SnapTradeAccountSummary = {
  ...robinhood,
  id: 'account-paper',
  label: 'Alpaca Paper',
  institution: 'alpaca-paper',
  isPaper: true,
  externalAccountId: 'snaptrade-account-1',
  connectionId: 'connection-1',
}
const accounts = (selectedAccountId: string): AccountsResponse => ({
  selectedAccountId,
  brokers: [
    { adapter: 'robinhood', account: robinhood },
    { adapter: 'snaptrade', accounts: { [paper.id]: paper } },
  ],
})

describe('reading the account list', () => {
  test('flattens the brokers in the server order, each account with its adapter', () => {
    expect(listAccounts(accounts(robinhood.id)).map(({ id, adapter }) => ({ id, adapter }))).toEqual([
      { id: robinhood.id, adapter: 'robinhood' },
      { id: paper.id, adapter: 'snaptrade' },
    ])
    expect(listAccounts(undefined)).toEqual([])
  })

  test('picks out the viewed account', () => {
    expect(selectedAccount(accounts(paper.id))?.label).toBe('Alpaca Paper')
    expect(selectedAccount(accounts('gone'))).toBeUndefined()
    expect(selectedAccount(undefined)).toBeUndefined()
  })

  test('the Robinhood login is offered for Robinhood, and when the list could not be read', () => {
    expect(connectsThroughRobinhood(selectedAccount(accounts(robinhood.id)))).toBe(true)
    expect(connectsThroughRobinhood(selectedAccount(accounts(paper.id)))).toBe(false)
    expect(connectsThroughRobinhood(undefined)).toBe(true)
  })

  test('names what an account is doing, most pressing first', () => {
    expect(accountState(robinhood)).toBe('Immediate')
    expect(accountState({ ...robinhood, executionMode: 'approval' })).toBe('Approval')
    expect(accountState({ ...robinhood, followedCallerCount: 0 })).toBe('Following no one')
    expect(accountState({ ...robinhood, followedCallerCount: 0, connected: false })).toBe('Not connected')
    expect(accountState({ ...robinhood, connected: false, needsReconnect: true })).toBe('Reconnect needed')
  })

  test('spells an institution out', () => {
    expect(institutionName('alpaca-paper')).toBe('Alpaca Paper')
    expect(institutionName('robinhood')).toBe('Robinhood')
  })
})

describe('useResetOnAccountSwitch', () => {
  /** What GET /api/settings answers: the settings of whichever account is selected. */
  const fetchSettings = vi.fn<() => Promise<string>>()

  function Screen() {
    const list = useAccounts()
    useResetOnAccountSwitch(list.data?.selectedAccountId)
    const settings = useQuery({ queryKey: ['settings'], queryFn: fetchSettings })
    // Filled by the live stream, never fetched: like the decisions feed.
    const decisions = useQuery<string>({ queryKey: ['decisions'], enabled: false })
    return (
      <p>
        {settings.data ?? 'no settings'} / {decisions.data ?? 'no decisions'}
      </p>
    )
  }

  function renderScreen() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const utils = render(
      <QueryClientProvider client={queryClient}>
        <Screen />
      </QueryClientProvider>,
    )
    return { queryClient, ...utils }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    fetchAccounts.mockResolvedValue(accounts(robinhood.id))
    fetchSettings.mockResolvedValue('robinhood settings')
  })

  afterEach(() => {
    cleanup()
  })

  test('the first load of the account list resets nothing', async () => {
    const { queryClient, container } = renderScreen()
    queryClient.setQueryData(['decisions'], 'robinhood decisions')

    await waitFor(() =>
      expect(container.textContent).toBe('robinhood settings / robinhood decisions'),
    )
    expect(queryClient.getQueryData(['accounts'])).toEqual(accounts(robinhood.id))
    expect(fetchSettings).toHaveBeenCalledTimes(1)
  })

  test('a switch empties what the previous account filled and refetches for the new one', async () => {
    const { queryClient, container } = renderScreen()
    queryClient.setQueryData(['decisions'], 'robinhood decisions')
    await waitFor(() =>
      expect(container.textContent).toBe('robinhood settings / robinhood decisions'),
    )

    let answerForPaper: (settings: string) => void = () => {}
    fetchSettings.mockReturnValue(
      new Promise<string>((resolve) => {
        answerForPaper = resolve
      }),
    )
    queryClient.setQueryData(['accounts'], accounts(paper.id))

    // Nothing of the Robinhood account is left on screen while paper's loads.
    await waitFor(() => expect(container.textContent).toBe('no settings / no decisions'))
    expect(fetchSettings).toHaveBeenCalledTimes(2)

    answerForPaper('paper settings')
    await waitFor(() => expect(container.textContent).toBe('paper settings / no decisions'))
    // The list that announced the switch is not fetched again.
    expect(fetchAccounts).toHaveBeenCalledTimes(1)
    expect(queryClient.getQueryData<AccountsResponse>(['accounts'])?.selectedAccountId).toBe(paper.id)
  })

  test('a refetched list that names the same account resets nothing', async () => {
    const { queryClient, container } = renderScreen()
    queryClient.setQueryData(['decisions'], 'robinhood decisions')
    await waitFor(() =>
      expect(container.textContent).toBe('robinhood settings / robinhood decisions'),
    )

    await queryClient.invalidateQueries({ queryKey: ['accounts'] })

    expect(fetchAccounts).toHaveBeenCalledTimes(2)
    expect(fetchSettings).toHaveBeenCalledTimes(1)
    expect(container.textContent).toBe('robinhood settings / robinhood decisions')
  })
})
