// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  accountState,
  connectControl,
  connectionGone,
  connectsThroughRobinhood,
  institutionName,
  listAccounts,
  selectedAccount,
  useAccounts,
  useResetOnAccountSwitch,
  viewedAccountConnected,
} from './accounts'
import type { ListedAccount } from './accounts'
import type {
  AccountSummary,
  AccountsResponse,
  BrokerStatus,
  SnapTradeAccountSummary,
} from './api'

const { fetchAccounts, setAccountChangedHandler } = vi.hoisted(() => ({
  fetchAccounts: vi.fn<() => Promise<AccountsResponse>>(),
  setAccountChangedHandler: vi.fn<(handler: () => void) => void>(),
}))
vi.mock('./api', () => ({ fetchAccounts, setAccountChangedHandler }))

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
  canConnectSnapTrade: false,
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

  test('what a not-connected notice offers depends on the sign-in and the viewed account', () => {
    const owner = (selectedAccountId: string, paperState: Partial<AccountSummary> = {}): AccountsResponse => ({
      ...accounts(selectedAccountId),
      brokers: [
        { adapter: 'robinhood', account: robinhood },
        { adapter: 'snaptrade', accounts: { [paper.id]: { ...paper, ...paperState } } },
      ],
      canConnectSnapTrade: true,
    })
    const broken = { connected: false, needsReconnect: true }

    // A sign-in that may connect other brokers: the choice from any account,
    // except the portal for a viewed account whose brokerage login broke.
    expect(connectControl(owner(robinhood.id))).toBe('chooser')
    expect(connectControl(owner(paper.id, { connected: false }))).toBe('chooser')
    expect(connectControl(owner(paper.id, broken))).toBe('repair')
    expect(connectControl(owner(robinhood.id, broken))).toBe('chooser')
    // Everyone else: the Robinhood login for Robinhood, nothing for another broker.
    expect(connectControl(accounts(robinhood.id))).toBe('robinhood')
    expect(connectControl(accounts(paper.id))).toBeNull()
    expect(connectControl({ ...owner(paper.id, broken), canConnectSnapTrade: false })).toBeNull()
    expect(connectControl(undefined)).toBe('robinhood')
  })

  test('a SnapTrade account that is neither connected nor repairable has lost its connection', () => {
    const viewed = (state: Partial<AccountSummary>): ListedAccount => ({ ...paper, ...state, adapter: 'snaptrade' })
    expect(connectionGone(viewed({ connected: false }))).toBe(true)
    expect(connectionGone(viewed({ connected: true }))).toBe(false)
    expect(connectionGone(viewed({ connected: false, needsReconnect: true }))).toBe(false)
    expect(connectionGone({ ...robinhood, connected: false, adapter: 'robinhood' })).toBe(false)
    expect(connectionGone(undefined)).toBe(false)
  })

  test('the account list says whether a SnapTrade account is connected; the status poll says it for Robinhood', () => {
    const status = (connected: boolean): BrokerStatus => ({
      connected,
      authUrl: null,
      tokenState: connected ? 'valid' : 'missing',
      executionMode: 'immediate',
    })
    // `paper` is connected in the list, `robinhood` too.
    expect(viewedAccountConnected(accounts(paper.id), status(false))).toBe(true)
    expect(viewedAccountConnected(accounts(paper.id), undefined)).toBe(true)
    expect(viewedAccountConnected(accounts(robinhood.id), status(false))).toBe(false)
    expect(viewedAccountConnected(accounts(robinhood.id), undefined)).toBeUndefined()
    // No list: the status is all there is.
    expect(viewedAccountConnected(undefined, status(true))).toBe(true)
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

  // The server refuses a request made for an account that is no longer
  // selected; api.ts reports that through the handler registered here.
  test('a refusal for a stale account reads the list again and follows the switch', async () => {
    const { queryClient, container } = renderScreen()
    queryClient.setQueryData(['decisions'], 'robinhood decisions')
    await waitFor(() =>
      expect(container.textContent).toBe('robinhood settings / robinhood decisions'),
    )
    const onAccountChanged = setAccountChangedHandler.mock.calls.at(-1)![0]

    // Another tab has switched to paper by the time the refusal arrives.
    fetchAccounts.mockResolvedValue(accounts(paper.id))
    fetchSettings.mockResolvedValue('paper settings')
    onAccountChanged()

    await waitFor(() => expect(container.textContent).toBe('paper settings / no decisions'))
    expect(fetchAccounts).toHaveBeenCalledTimes(2)
  })
})
