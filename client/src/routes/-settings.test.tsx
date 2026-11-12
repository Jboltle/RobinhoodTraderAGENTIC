// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { ViewedAccountContext } from '../lib/accounts'
import type {
  AccountSummary,
  AccountsResponse,
  BrokerConnectResult,
  BrokerStatus,
  SnapTradeAccountSummary,
  TradeSettings,
} from '../lib/api'
import { Route } from './settings'

const api = vi.hoisted(() => ({
  fetchAccounts: vi.fn<() => Promise<AccountsResponse>>(),
  fetchBrokerStatus: vi.fn<() => Promise<BrokerStatus>>(),
  fetchSettings: vi.fn<() => Promise<TradeSettings>>(),
  fetchCallers: vi.fn(async () => []),
  fetchPortfolio: vi.fn(async () => ({ portfolioValueUsd: 1000, buyingPowerUsd: 500, openPositions: 0 })),
  connectBroker: vi.fn<(options: { force: boolean }) => Promise<BrokerConnectResult>>(),
  submitBrokerRedirect: vi.fn(),
  disconnectBroker: vi.fn(),
  fetchSnapTradeLink: vi.fn<(accountId: string, reconnect?: string) => Promise<string>>(),
  syncSnapTrade: vi.fn(),
}))
vi.mock('../lib/api', () => api)
// Reached through AccountMenu (the page borrows its AccountBadge); it reads
// the stored session as it loads.
vi.mock('../lib/auth', () => ({
  signOut: vi.fn(),
  useAuth: () => ({ email: 'owner@example.com', isLoading: false, session: null }),
}))
// The portal's own modal is covered by SnapTradePortal.test.tsx.
vi.mock('snaptrade-react', () => ({
  SnapTradeReact: (props: { loginLink: string }) => (
    <div data-testid="snaptrade-modal" data-link={props.loginLink} />
  ),
}))

const SETTINGS: TradeSettings = {
  executionMode: 'approval',
  equitySmallPct: 1,
  equityMediumPct: 2,
  equityFullPct: 3,
  optionsSmallPct: 1,
  optionsMediumPct: 2,
  optionsFullPct: 3,
  optionsLottoPct: 1,
  maxSingleContractPct: 5,
  maxTradesPerDay: 5,
  cooldownSeconds: 0,
  allowedTickers: [],
  blockedTickers: [],
  minConfidence: 0.5,
  regularHoursOnly: true,
  allowLottoTrades: false,
  followedCallerIds: null,
  maxLossPct: null,
  maxLossUsd: null,
  exitMode: 'caller',
  trimLevels: [],
}

const robinhood: AccountSummary = {
  id: 'account-robinhood',
  label: 'Robinhood',
  institution: 'robinhood',
  isPaper: false,
  connected: false,
  needsReconnect: false,
  executionMode: 'approval',
  followedCallerCount: 1,
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

interface Viewing {
  canConnectSnapTrade: boolean
  /** The SnapTrade account's state when it is the one viewed; Robinhood is viewed otherwise. */
  paper?: Pick<AccountSummary, 'connected' | 'needsReconnect'>
}
const list = ({ canConnectSnapTrade, paper: paperState }: Viewing): AccountsResponse => ({
  selectedAccountId: paperState ? paper.id : robinhood.id,
  brokers: [
    { adapter: 'robinhood', account: robinhood },
    { adapter: 'snaptrade', accounts: { [paper.id]: { ...paper, ...paperState } } },
  ],
  canConnectSnapTrade,
})

const GONE = { connected: false, needsReconnect: false }
const BROKEN = { connected: false, needsReconnect: true }
const CONNECTED = { connected: true, needsReconnect: false }

/** What the status route says of any account without stored credentials. */
const noCredentials: BrokerStatus = {
  connected: false,
  authUrl: null,
  tokenState: 'missing',
  executionMode: 'approval',
}

const SettingsPage = Route.options.component!

async function renderSettings(viewing: Viewing, status: BrokerStatus = noCredentials) {
  const accounts = list(viewing)
  api.fetchAccounts.mockResolvedValue(accounts)
  api.fetchBrokerStatus.mockResolvedValue(status)
  // The router plugin splits a route's component into its own chunk.
  await SettingsPage.preload?.()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <ViewedAccountContext value={accounts.selectedAccountId}>
        <SettingsPage />
      </ViewedAccountContext>
    </QueryClientProvider>,
  )
  const heading = await utils.findByText(/ connection$/)
  await waitFor(() => expect(api.fetchBrokerStatus).toHaveBeenCalled())
  const card = heading.closest('section') ?? heading.parentElement!
  await waitFor(() => expect(card.textContent).not.toContain('Checking…'))
  return {
    ...utils,
    card,
    /** The names of the card's own buttons, in order; its dialog's are not the card's. */
    controls: () =>
      Array.from(card.querySelectorAll('button'))
        .filter((button) => button.closest('dialog') === null)
        .map((button) => button.textContent),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  api.fetchSettings.mockResolvedValue(SETTINGS)
  api.connectBroker.mockResolvedValue({ connected: false, authUrl: null })
  api.fetchSnapTradeLink.mockResolvedValue('https://app.snaptrade.com/snapTrade/redeemToken?token=one-time')
  const proto = HTMLDialogElement.prototype
  proto.showModal = function showModal() {
    this.setAttribute('open', '')
  }
  proto.close = function close() {
    this.removeAttribute('open')
  }
})

afterEach(() => {
  cleanup()
})

test('a sign-in that cannot connect other brokers sees the Robinhood card as it always was', async () => {
  const disconnected = await renderSettings({ canConnectSnapTrade: false })
  expect(disconnected.card.textContent).toContain('Not connected')
  expect(disconnected.controls()).toEqual(['Connect'])
  fireEvent.click(disconnected.getByRole('button', { name: 'Connect' }))
  await waitFor(() => expect(api.connectBroker).toHaveBeenCalledWith({ force: true }, expect.anything()))
  cleanup()

  const connected = await renderSettings(
    { canConnectSnapTrade: false },
    { ...noCredentials, connected: true, tokenState: 'valid' },
  )
  expect(connected.card.textContent).toContain('Connected')
  expect(connected.controls()).toEqual(['Reconnect', 'Disconnect'])
})

test('one that can is offered the choice from a Robinhood account that is not connected', async () => {
  const utils = await renderSettings({ canConnectSnapTrade: true })
  expect(utils.controls()).toEqual(['Connect a broker'])

  fireEvent.click(utils.getByRole('button', { name: 'Connect a broker' }))

  await utils.findByRole('group', { name: 'What to connect' })
  expect(api.connectBroker).not.toHaveBeenCalled()
})

test('a SnapTrade account whose connection is gone says so and offers the choice, not a repair', async () => {
  const utils = await renderSettings({ canConnectSnapTrade: true, paper: GONE })
  expect(utils.card.textContent).toContain('Not connected. This connection no longer exists at the broker.')
  expect(utils.controls()).toEqual(['Connect a broker'])

  fireEvent.click(utils.getByRole('button', { name: 'Connect a broker' }))

  await utils.findByRole('group', { name: 'What to connect' })
  expect(api.fetchSnapTradeLink).not.toHaveBeenCalled()
})

test('the same account, for a sign-in that may not use SnapTrade: said, with nothing to press', async () => {
  const utils = await renderSettings({ canConnectSnapTrade: false, paper: GONE })
  expect(utils.card.textContent).toContain('This connection no longer exists at the broker.')
  expect(utils.controls()).toEqual([])
})

test('a SnapTrade account whose brokerage login broke gets Reconnect, straight to its portal', async () => {
  const utils = await renderSettings({ canConnectSnapTrade: true, paper: BROKEN })
  expect(utils.card.textContent).not.toContain('no longer exists')
  expect(utils.controls()).toEqual(['Reconnect'])

  fireEvent.click(utils.getByRole('button', { name: 'Reconnect' }))

  await utils.findByTestId('snaptrade-modal')
  expect(api.fetchSnapTradeLink).toHaveBeenCalledExactlyOnceWith(paper.id, paper.connectionId)
})

test('a connected SnapTrade account reads Connected, whatever the status route says', async () => {
  const utils = await renderSettings({ canConnectSnapTrade: true, paper: CONNECTED })
  expect(utils.card.textContent).toContain('Connected')
  expect(utils.card.textContent).not.toContain('Not connected')
  // Nothing to connect, and Disconnect is the Robinhood credentials' control.
  expect(utils.controls()).toEqual([])
})
