// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { ConnectBanner } from './ConnectBanner'
import { ConnectDialog } from './ConnectDialog'
import type {
  AccountSummary,
  AccountsResponse,
  BrokerConnectResult,
  BrokerStatus,
  SnapTradeAccountSummary,
  SnapTradeSyncResult,
} from '../lib/api'

const api = vi.hoisted(() => ({
  fetchBrokerStatus: vi.fn<() => Promise<BrokerStatus>>(),
  connectBroker: vi.fn<(options: { force: boolean }) => Promise<BrokerConnectResult>>(),
  submitBrokerRedirect: vi.fn<(url: string) => Promise<void>>(),
  fetchAccounts: vi.fn<() => Promise<AccountsResponse>>(),
  fetchSnapTradeLink: vi.fn<(accountId: string, reconnect?: string) => Promise<string>>(),
  syncSnapTrade: vi.fn<(accountId: string) => Promise<SnapTradeSyncResult>>(),
}))
vi.mock('../lib/api', () => api)

// The real SnapTradePortal wrapper, over a stand-in for the modal: buttons
// that report what SnapTrade's page would. (SnapTradePortal.test.tsx renders
// the real modal.)
vi.mock('snaptrade-react', () => ({
  SnapTradeReact: (props: {
    loginLink: string
    close: () => void
    onSuccess: (authorizationId: string) => void
    onError: (error: { statusCode: string; detail: string }) => void
  }) => (
    <div data-testid="snaptrade-modal" data-link={props.loginLink}>
      <button type="button" onClick={() => props.onSuccess('authorization-1')}>
        portal: connected
      </button>
      <button
        type="button"
        onClick={() => props.onError({ statusCode: '400', detail: 'the broker refused the login' })}
      >
        portal: failed
      </button>
      <button type="button" onClick={props.close}>
        portal: closed
      </button>
    </div>
  ),
}))

const PORTAL_URL = 'https://app.snaptrade.com/snapTrade/redeemToken?token=one-time'
const AUTH_URL = 'https://robinhood.com/mcp/trading?state=abc'
const READ_ONLY_REFUSAL =
  'Robinhood cannot be connected from this environment (TRADE_EXECUTION_MODE=read_only)'

const robinhood: AccountSummary = {
  id: 'account-robinhood',
  label: 'Robinhood',
  institution: 'robinhood',
  isPaper: false,
  connected: false,
  needsReconnect: false,
  executionMode: 'immediate',
  followedCallerCount: 1,
}
const paper: SnapTradeAccountSummary = {
  ...robinhood,
  id: 'account-paper',
  label: 'Alpaca Paper · Individual (…1234)',
  institution: 'alpaca-paper',
  isPaper: true,
  connected: true,
  executionMode: 'approval',
  externalAccountId: 'snaptrade-account-1',
  connectionId: 'connection-1',
}

interface ListOptions {
  canConnectSnapTrade: boolean
  robinhoodConnected?: boolean
  /** The owner's SnapTrade account, when they have one; `viewed` makes it the one shown. */
  paper?: SnapTradeAccountSummary
  viewed?: string
}
const accountList = (options: ListOptions): AccountsResponse => ({
  selectedAccountId: options.viewed ?? robinhood.id,
  brokers: [
    { adapter: 'robinhood', account: { ...robinhood, connected: options.robinhoodConnected ?? false } },
    ...(options.paper
      ? [{ adapter: 'snaptrade' as const, accounts: { [options.paper.id]: options.paper } }]
      : []),
  ],
  canConnectSnapTrade: options.canConnectSnapTrade,
})
const OWNER = accountList({ canConnectSnapTrade: true })

const synced = (result: Partial<SnapTradeSyncResult>): SnapTradeSyncResult => ({
  added: 0,
  updated: 0,
  disconnected: 0,
  skippedReadOnlyConnections: 0,
  skippedSandboxConnections: 0,
  connectionsAwaitingAccounts: 0,
  ...result,
})

const disconnected: BrokerStatus = {
  connected: false,
  authUrl: null,
  tokenState: 'missing',
  executionMode: 'immediate',
}

/** jsdom's <dialog> is incomplete; showModal/close must flip the open flag. */
function stubDialog() {
  const proto = HTMLDialogElement.prototype
  proto.showModal = function showModal() {
    this.setAttribute('open', '')
  }
  proto.close = function close() {
    this.removeAttribute('open')
    this.dispatchEvent(new Event('close'))
  }
}

function renderDialog(props: { repairConnectionId?: string } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onClose = vi.fn()
  const tree = (open: boolean) => (
    <QueryClientProvider client={queryClient}>
      <ConnectDialog open={open} force={false} onClose={onClose} {...props} />
    </QueryClientProvider>
  )
  const utils = render(tree(true))
  return {
    ...utils,
    onClose,
    dialog: () => utils.container.querySelector('dialog')!,
    /** Close or reopen it, as its parent does. */
    setOpen: (open: boolean) => utils.rerender(tree(open)),
  }
}

type Rendered = ReturnType<typeof renderDialog>

const chooseOther = async (utils: Rendered): Promise<void> => {
  fireEvent.click(await utils.findByRole('button', { name: /^Other broker/ }))
}
const inPortal = async (utils: Rendered, name: string): Promise<void> => {
  fireEvent.click(await utils.findByRole('button', { name }))
}

beforeEach(() => {
  vi.clearAllMocks()
  api.fetchBrokerStatus.mockResolvedValue(disconnected)
  api.connectBroker.mockResolvedValue({ connected: false, authUrl: AUTH_URL })
  api.submitBrokerRedirect.mockResolvedValue(undefined)
  api.fetchAccounts.mockResolvedValue(OWNER)
  api.fetchSnapTradeLink.mockResolvedValue(PORTAL_URL)
  api.syncSnapTrade.mockResolvedValue(synced({ added: 1 }))
  vi.stubGlobal('open', vi.fn())
  stubDialog()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// ---- The choice ---------------------------------------------------------------

test('a sign-in that may connect other brokers chooses first, and nothing starts until it does', async () => {
  const utils = renderDialog()

  const robinhoodChoice = await utils.findByRole('button', { name: /^Robinhood/ })
  const otherChoice = utils.getByRole('button', { name: /^Other broker/ })
  expect(utils.getByRole('group', { name: 'What to connect' }).contains(otherChoice)).toBe(true)
  expect(utils.dialog().getAttribute('aria-label')).toBe('Connect an account')
  // Keyboard: focus lands on the first choice, and both are plain buttons.
  expect(document.activeElement).toBe(robinhoodChoice)

  expect(api.connectBroker).not.toHaveBeenCalled()
  expect(api.fetchSnapTradeLink).not.toHaveBeenCalled()
})

test('everyone else goes straight to the Robinhood login, with no choice shown', async () => {
  api.fetchAccounts.mockResolvedValue(accountList({ canConnectSnapTrade: false }))
  const utils = renderDialog()

  await waitFor(() => expect(api.connectBroker).toHaveBeenCalledWith({ force: false }, expect.anything()))
  expect(utils.queryByRole('button', { name: /^Other broker/ })).toBeNull()
  expect(utils.dialog().getAttribute('aria-label')).toBe('Connect Robinhood')
  expect(api.fetchSnapTradeLink).not.toHaveBeenCalled()
})

test('an account list that cannot be read also goes straight to Robinhood', async () => {
  api.fetchAccounts.mockRejectedValue(new Error('trader unreachable'))
  renderDialog()

  await waitFor(() => expect(api.connectBroker).toHaveBeenCalled())
})

// ---- Robinhood, after choosing it ----------------------------------------------

test('choosing Robinhood runs the Robinhood login as before', async () => {
  const utils = renderDialog()

  fireEvent.click(await utils.findByRole('button', { name: /^Robinhood/ }))

  await waitFor(() => expect(api.connectBroker).toHaveBeenCalledWith({ force: false }, expect.anything()))
  await waitFor(() => expect(utils.container.querySelector(`a[href="${AUTH_URL}"]`)).not.toBeNull())
  expect(utils.container.textContent).toContain('Authorize in Robinhood')
  expect(api.fetchSnapTradeLink).not.toHaveBeenCalled()
})

test('the Robinhood choice reads Reconnect when Robinhood is already connected', async () => {
  api.fetchAccounts.mockResolvedValue(accountList({ canConnectSnapTrade: true, robinhoodConnected: true }))
  const utils = renderDialog()

  expect(await utils.findByRole('button', { name: /^Reconnect Robinhood/ })).not.toBeNull()
})

test('on a deployment that refuses the Robinhood login, choosing it shows that refusal', async () => {
  api.connectBroker.mockRejectedValue(new Error(READ_ONLY_REFUSAL))
  const utils = renderDialog()

  fireEvent.click(await utils.findByRole('button', { name: /^Robinhood/ }))

  await waitFor(() => expect(utils.container.textContent).toContain(READ_ONLY_REFUSAL))
})

// ---- Another broker --------------------------------------------------------------

test('Other broker asks for the link only then, opens the portal, and syncs once it reports success', async () => {
  const utils = renderDialog()
  await utils.findByRole('button', { name: /^Other broker/ })
  expect(api.fetchSnapTradeLink).not.toHaveBeenCalled()

  await chooseOther(utils)

  const modal = await utils.findByTestId('snaptrade-modal')
  expect(modal.getAttribute('data-link')).toBe(PORTAL_URL)
  expect(api.fetchSnapTradeLink).toHaveBeenCalledExactlyOnceWith(robinhood.id, undefined)
  // The portal is a modal of its own: this dialog steps aside without ending the flow.
  expect(utils.dialog().open).toBe(false)
  expect(utils.onClose).not.toHaveBeenCalled()
  expect(api.syncSnapTrade).not.toHaveBeenCalled()

  const listReadsBefore = api.fetchAccounts.mock.calls.length
  api.fetchAccounts.mockResolvedValue(accountList({ canConnectSnapTrade: true, paper }))
  await inPortal(utils, 'portal: connected')

  await waitFor(() => expect(utils.container.textContent).toContain('Added 1 account'))
  expect(api.syncSnapTrade).toHaveBeenCalledExactlyOnceWith(robinhood.id)
  // The list is read again, so the menu has the new account.
  expect(api.fetchAccounts.mock.calls.length).toBeGreaterThan(listReadsBefore)
  expect(utils.queryByTestId('snaptrade-modal')).toBeNull()
  expect(utils.dialog().open).toBe(true)
  expect(utils.container.textContent).toContain('approval mode')

  fireEvent.click(utils.getByRole('button', { name: 'Done' }))
  expect(utils.onClose).toHaveBeenCalled()
})

test('accounts SnapTrade does not list yet are reported as that, with a way to sync again', async () => {
  api.syncSnapTrade.mockResolvedValueOnce(synced({ connectionsAwaitingAccounts: 1 }))
  const utils = renderDialog()
  await chooseOther(utils)
  await inPortal(utils, 'portal: connected')

  await waitFor(() => expect(utils.container.textContent).toContain('does not list its accounts yet'))
  expect(utils.container.textContent).not.toContain('Added')

  fireEvent.click(utils.getByRole('button', { name: 'Sync again' }))

  await waitFor(() => expect(utils.container.textContent).toContain('Added 1 account'))
  expect(api.syncSnapTrade).toHaveBeenCalledTimes(2)
  expect(utils.queryByRole('button', { name: 'Sync again' })).toBeNull()
})

test('a sync that fails says the broker is connected but its accounts were not added', async () => {
  api.syncSnapTrade.mockRejectedValueOnce(new Error('SnapTrade could not be read. Nothing was changed. Try again.'))
  const utils = renderDialog()
  await chooseOther(utils)
  await inPortal(utils, 'portal: connected')

  expect((await utils.findByRole('alert')).textContent).toContain('could not be added')
  expect(utils.getByRole('button', { name: 'Sync again' })).not.toBeNull()
})

test.each([
  ['portal: failed', 'the broker refused the login'],
  ['portal: closed', 'Nothing was connected'],
])('%s returns to the choice with the reason, and syncs nothing', async (button, reason) => {
  const utils = renderDialog()
  await chooseOther(utils)
  await inPortal(utils, button)

  expect((await utils.findByRole('alert')).textContent).toContain(reason)
  expect(utils.getByRole('button', { name: /^Other broker/ })).not.toBeNull()
  expect(utils.queryByTestId('snaptrade-modal')).toBeNull()
  expect(utils.dialog().open).toBe(true)
  expect(api.syncSnapTrade).not.toHaveBeenCalled()
  expect(utils.onClose).not.toHaveBeenCalled()

  // Trying again asks for a new link: the first one may have expired.
  await chooseOther(utils)
  await utils.findByTestId('snaptrade-modal')
  expect(api.fetchSnapTradeLink).toHaveBeenCalledTimes(2)
})

test('a link that cannot be issued returns to the choice with the reason', async () => {
  api.fetchSnapTradeLink.mockRejectedValueOnce(new Error('SnapTrade did not issue a connection link.'))
  const utils = renderDialog()
  await chooseOther(utils)

  expect((await utils.findByRole('alert')).textContent).toContain('did not issue a connection link')
  expect(utils.queryByTestId('snaptrade-modal')).toBeNull()
})

test('a link that arrives after the dialog was closed opens nothing, then or at the next opening', async () => {
  let deliver: (url: string) => void = () => {}
  api.fetchSnapTradeLink.mockReturnValueOnce(new Promise((resolve) => (deliver = resolve)))
  const utils = renderDialog()
  await chooseOther(utils)
  await waitFor(() => expect(api.fetchSnapTradeLink).toHaveBeenCalled())

  utils.setOpen(false)
  deliver(PORTAL_URL)
  await waitFor(() => expect(utils.dialog().open).toBe(false))
  utils.setOpen(true)

  await utils.findByRole('button', { name: /^Other broker/ })
  expect(utils.queryByTestId('snaptrade-modal')).toBeNull()
})

// ---- Repairing one connection ---------------------------------------------------

const brokenPaper: SnapTradeAccountSummary = { ...paper, connected: false, needsReconnect: true }

test('a repair opens the portal for that connection directly, and stays on its result', async () => {
  api.fetchAccounts.mockResolvedValue(
    accountList({ canConnectSnapTrade: true, paper: brokenPaper, viewed: brokenPaper.id }),
  )
  api.syncSnapTrade.mockResolvedValue(synced({ updated: 1 }))
  const utils = renderDialog({ repairConnectionId: brokenPaper.connectionId })

  await utils.findByTestId('snaptrade-modal')
  expect(api.fetchSnapTradeLink).toHaveBeenCalledExactlyOnceWith(brokenPaper.id, brokenPaper.connectionId)

  await inPortal(utils, 'portal: connected')
  await waitFor(() => expect(utils.container.textContent).toContain('up to date'))
  expect(api.syncSnapTrade).toHaveBeenCalledExactlyOnceWith(brokenPaper.id)
})

function renderBanner() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <ConnectBanner />
    </QueryClientProvider>,
  )
  return { queryClient, ...utils }
}

test('the banner offers Reconnect for a SnapTrade account whose brokerage login broke', async () => {
  api.fetchAccounts.mockResolvedValue(
    accountList({ canConnectSnapTrade: true, paper: brokenPaper, viewed: brokenPaper.id }),
  )
  const utils = renderBanner()

  fireEvent.click(await utils.findByRole('button', { name: `Reconnect ${brokenPaper.label}` }))

  await utils.findByTestId('snaptrade-modal')
  expect(api.fetchSnapTradeLink).toHaveBeenCalledExactlyOnceWith(brokenPaper.id, brokenPaper.connectionId)
  expect(api.connectBroker).not.toHaveBeenCalled()

  // Repaired: the account no longer needs it, and the dialog keeps its result on screen.
  api.syncSnapTrade.mockResolvedValue(synced({ updated: 1 }))
  api.fetchAccounts.mockResolvedValue(
    accountList({ canConnectSnapTrade: true, paper: { ...paper, connected: true }, viewed: paper.id }),
  )
  fireEvent.click(await utils.findByRole('button', { name: 'portal: connected' }))

  await waitFor(() => expect(utils.container.textContent).toContain('up to date'))
  expect(utils.queryByRole('button', { name: /^Other broker/ })).toBeNull()
  expect(utils.queryByRole('button', { name: /Reconnect/ })).toBeNull()
})

test('the banner offers no Reconnect to a sign-in that may not use SnapTrade', async () => {
  api.fetchAccounts.mockResolvedValue(
    accountList({ canConnectSnapTrade: false, paper: brokenPaper, viewed: brokenPaper.id }),
  )
  const utils = renderBanner()

  await waitFor(() => expect(utils.container.textContent).toContain(`${brokenPaper.label} not connected`))
  expect(utils.queryByRole('button', { name: /Reconnect/ })).toBeNull()
})

// ---- Where the banner starts a new connection -----------------------------------

/** What a sync leaves of an account whose connection SnapTrade no longer has. */
const gonePaper: SnapTradeAccountSummary = { ...paper, connected: false, needsReconnect: false }
const GONE_NOTICE = `${gonePaper.label} not connected. This connection no longer exists at the broker.`

test('the banner opens the choice for a sign-in that may connect other brokers, under a name that fits it', async () => {
  const utils = renderBanner()

  fireEvent.click(await utils.findByRole('button', { name: 'Connect a broker' }))

  await utils.findByRole('group', { name: 'What to connect' })
  expect(utils.queryByRole('button', { name: 'Connect Robinhood' })).toBeNull()
  expect(api.connectBroker).not.toHaveBeenCalled()
  expect(api.fetchSnapTradeLink).not.toHaveBeenCalled()
})

test('a connection that is gone at the broker is called that, with the choice and no repair', async () => {
  api.fetchAccounts.mockResolvedValue(
    accountList({ canConnectSnapTrade: true, paper: gonePaper, viewed: gonePaper.id }),
  )
  const utils = renderBanner()

  fireEvent.click(await utils.findByRole('button', { name: 'Connect a broker' }))

  await utils.findByRole('group', { name: 'What to connect' })
  expect(utils.container.textContent).toContain(GONE_NOTICE)
  expect(utils.queryByRole('button', { name: /Reconnect/ })).toBeNull()
  // The choice, not the portal for a connection that cannot be repaired.
  expect(api.fetchSnapTradeLink).not.toHaveBeenCalled()
})

test('a sign-in that may not use SnapTrade is told the same and offered nothing', async () => {
  api.fetchAccounts.mockResolvedValue(
    accountList({ canConnectSnapTrade: false, paper: gonePaper, viewed: gonePaper.id }),
  )
  const utils = renderBanner()

  await waitFor(() => expect(utils.container.textContent).toContain(GONE_NOTICE))
  expect(utils.queryByRole('button')).toBeNull()
})

test('the banner believes the account list about a SnapTrade account, not the status', async () => {
  // The status route only knows stored credentials: it says "not connected" throughout.
  api.fetchAccounts.mockResolvedValue(
    accountList({ canConnectSnapTrade: true, paper: gonePaper, viewed: gonePaper.id }),
  )
  const utils = renderBanner()
  await waitFor(() => expect(utils.container.textContent).toContain(GONE_NOTICE))

  api.fetchAccounts.mockResolvedValue(
    accountList({ canConnectSnapTrade: true, paper, viewed: paper.id }),
  )
  await utils.queryClient.invalidateQueries({ queryKey: ['accounts'] })

  await waitFor(() => expect(utils.container.textContent).toBe(''))
})
