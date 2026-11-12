// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, configure, fireEvent, render, waitFor, within } from '@testing-library/react'
import type { ComponentProps, ReactNode } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { AccountMenu } from './AccountMenu'
import type {
  AccountSummary,
  AccountsResponse,
  BrokerConnectResult,
  BrokerStatus,
  SnapTradeAccountSummary,
  UnusableAccount,
} from '../lib/api'

const api = vi.hoisted(() => ({
  fetchAccounts: vi.fn<() => Promise<AccountsResponse>>(),
  selectAccount: vi.fn<(accountId: string) => Promise<string>>(),
  fetchBrokerStatus: vi.fn<() => Promise<BrokerStatus>>(),
  connectBroker: vi.fn<(options: { force: boolean }) => Promise<BrokerConnectResult>>(),
  submitBrokerRedirect: vi.fn<(url: string) => Promise<void>>(),
}))
const signOut = vi.hoisted(() => vi.fn<() => Promise<void>>())

vi.mock('../lib/api', () => api)
vi.mock('../lib/auth', () => ({
  signOut,
  useAuth: () => ({ email: 'owner@example.com', isLoading: false, session: null }),
}))
// The menu only needs a link that goes to Settings, not a router.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode } & ComponentProps<'a'>) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}))

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
  id: 'account-paper',
  label: 'Alpaca Paper',
  institution: 'alpaca-paper',
  isPaper: true,
  connected: false,
  needsReconnect: false,
  executionMode: 'approval',
  followedCallerCount: 0,
  externalAccountId: 'snaptrade-account-1',
  connectionId: 'connection-1',
}
/** A row the server could not read: listed, with none of what a usable account reports. */
const unreadable: UnusableAccount = {
  id: 'account-unreadable',
  label: 'Alpaca Paper (staging test)',
  institution: 'alpaca-paper',
  isPaper: true,
}
const accounts = (selectedAccountId: string): AccountsResponse => ({
  selectedAccountId,
  brokers: [
    { adapter: 'robinhood', account: robinhood },
    { adapter: 'snaptrade', accounts: { [paper.id]: paper } },
  ],
  canConnectSnapTrade: false,
})

// jsdom hides a popover like a browser does but cannot open one, so role
// queries here look at hidden elements too.
configure({ defaultHidden: true })

/** jsdom has no popover: hidePopover must exist and report the close as a browser does. */
const hidePopover = vi.fn(function hidePopover(this: HTMLElement) {
  this.dispatchEvent(Object.assign(new Event('toggle'), { newState: 'closed' }))
})

function openMenu(menu: HTMLElement): void {
  fireEvent(menu, Object.assign(new Event('toggle'), { newState: 'open' }))
}

function renderMenu() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <AccountMenu />
    </QueryClientProvider>,
  )
  return { queryClient, ...utils }
}

/** The menu once the account list has loaded. */
async function loadedMenu(utils: ReturnType<typeof renderMenu>): Promise<HTMLElement> {
  const menu = utils.getByRole('menu')
  await waitFor(() => expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(2))
  return menu
}

beforeEach(() => {
  vi.clearAllMocks()
  api.fetchAccounts.mockResolvedValue(accounts(robinhood.id))
  api.selectAccount.mockImplementation(async (accountId) => accountId)
  api.fetchBrokerStatus.mockResolvedValue({
    connected: true,
    authUrl: null,
    tokenState: 'valid',
    executionMode: 'immediate',
  })
  api.connectBroker.mockResolvedValue({ connected: true, authUrl: null })
  HTMLElement.prototype.hidePopover = hidePopover
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open')
  }
})

afterEach(() => {
  cleanup()
})

test('lists each account with its institution, PAPER or LIVE and what it is doing', async () => {
  const utils = renderMenu()
  const menu = await loadedMenu(utils)

  const [first, second] = within(menu).getAllByRole('menuitemradio')
  expect(first.textContent).toContain('Robinhood')
  expect(first.textContent).toContain('LIVE')
  expect(first.textContent).toContain('Immediate')
  expect(second.textContent).toContain('Alpaca Paper')
  expect(second.textContent).toContain('PAPER')
  expect(second.textContent).toContain('Not connected')

  // The viewed account is the checked one, and the button says so.
  expect(first.getAttribute('aria-checked')).toBe('true')
  expect(second.getAttribute('aria-checked')).toBe('false')
  expect(utils.getByRole('button', { name: 'Account menu, viewing Robinhood' })).toBeTruthy()

  expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
    'Connect account',
    'Settings',
    'Sign out',
  ])
  expect(within(menu).getByRole('menuitem', { name: 'Settings' }).getAttribute('href')).toBe('/settings')
})

test('the button is tied to the popover and reports whether it is open', async () => {
  const utils = renderMenu()
  const menu = await loadedMenu(utils)
  const button = utils.getByRole('button', { name: /^Account menu/ })

  expect(button.getAttribute('popovertarget')).toBe(menu.id)
  expect(button.getAttribute('aria-controls')).toBe(menu.id)
  expect(button.getAttribute('aria-haspopup')).toBe('menu')
  expect(menu.getAttribute('popover')).toBe('auto')
  expect(button.getAttribute('aria-expanded')).toBe('false')

  openMenu(menu)
  await waitFor(() => expect(button.getAttribute('aria-expanded')).toBe('true'))
})

test('choosing another account selects it, marks it viewed and closes the menu', async () => {
  const utils = renderMenu()
  const menu = await loadedMenu(utils)
  openMenu(menu)

  fireEvent.click(within(menu).getByRole('menuitemradio', { name: /Alpaca Paper/ }))

  await waitFor(() => expect(api.selectAccount.mock.calls.map((call) => call[0])).toEqual([paper.id]))
  await waitFor(() =>
    expect(
      within(menu).getByRole('menuitemradio', { name: /Alpaca Paper/ }).getAttribute('aria-checked'),
    ).toBe('true'),
  )
  expect(utils.queryClient.getQueryData<AccountsResponse>(['accounts'])?.selectedAccountId).toBe(paper.id)
  expect(utils.getByRole('button', { name: 'Account menu, viewing Alpaca Paper' })).toBeTruthy()
  expect(hidePopover).toHaveBeenCalledTimes(1)
})

test('choosing the account already viewed only closes the menu', async () => {
  const utils = renderMenu()
  const menu = await loadedMenu(utils)

  fireEvent.click(within(menu).getByRole('menuitemradio', { name: /Robinhood/ }))

  expect(api.selectAccount).not.toHaveBeenCalled()
  expect(hidePopover).toHaveBeenCalledTimes(1)
})

test('a refused switch says so and leaves the viewed account as it was', async () => {
  api.selectAccount.mockRejectedValue(new Error('no such account'))
  const utils = renderMenu()
  const menu = await loadedMenu(utils)

  fireEvent.click(within(menu).getByRole('menuitemradio', { name: /Alpaca Paper/ }))

  const alert = await within(menu).findByRole('alert')
  expect(alert.textContent).toContain('no such account')
  expect(within(menu).getByRole('menuitemradio', { name: /Robinhood/ }).getAttribute('aria-checked')).toBe('true')
  expect(hidePopover).not.toHaveBeenCalled()
})

test('opening moves focus to the viewed account, and the arrow keys walk the items', async () => {
  api.fetchAccounts.mockResolvedValue(accounts(paper.id))
  const utils = renderMenu()
  const menu = await loadedMenu(utils)
  const items = Array.from(menu.querySelectorAll<HTMLElement>('[role^="menuitem"]'))
  expect(items).toHaveLength(5)
  // Out of the tab order: the arrow keys move between them.
  expect(items.every((item) => item.getAttribute('tabindex') === '-1')).toBe(true)

  openMenu(menu)
  expect(document.activeElement).toBe(items[1])

  fireEvent.keyDown(menu, { key: 'ArrowDown' })
  expect(document.activeElement).toBe(items[2])
  fireEvent.keyDown(menu, { key: 'End' })
  expect(document.activeElement).toBe(items[4])
  fireEvent.keyDown(menu, { key: 'ArrowDown' })
  expect(document.activeElement).toBe(items[0])
  fireEvent.keyDown(menu, { key: 'ArrowUp' })
  expect(document.activeElement).toBe(items[4])
  fireEvent.keyDown(menu, { key: 'Home' })
  expect(document.activeElement).toBe(items[0])
})

test('Tab closes the menu', async () => {
  const utils = renderMenu()
  const menu = await loadedMenu(utils)
  openMenu(menu)

  fireEvent.keyDown(menu, { key: 'Tab' })

  expect(hidePopover).toHaveBeenCalledTimes(1)
})

test('Connect account closes the menu and opens the Robinhood dialog, never forced', async () => {
  const utils = renderMenu()
  const menu = await loadedMenu(utils)
  const dialog = utils.container.querySelector('dialog')!
  expect(dialog.open).toBe(false)

  fireEvent.click(within(menu).getByRole('menuitem', { name: 'Connect account' }))

  await waitFor(() => expect(dialog.open).toBe(true))
  expect(hidePopover).toHaveBeenCalledTimes(1)
  await waitFor(() =>
    expect(api.connectBroker).toHaveBeenCalledWith({ force: false }, expect.anything()),
  )
})

test('Sign out signs out', async () => {
  const utils = renderMenu()
  const menu = await loadedMenu(utils)

  fireEvent.click(within(menu).getByRole('menuitem', { name: 'Sign out' }))

  expect(signOut).toHaveBeenCalledTimes(1)
})

test('still offers Settings and Sign out when the account list cannot be read', async () => {
  api.fetchAccounts.mockRejectedValue(new Error('trader unreachable'))
  const utils = renderMenu()
  const menu = utils.getByRole('menu')

  await waitFor(() => expect(menu.textContent).toContain('Accounts unavailable (trader unreachable)'))
  expect(within(menu).queryAllByRole('menuitemradio')).toHaveLength(0)
  expect(within(menu).getAllByRole('menuitem')).toHaveLength(3)
  // Its closed connect dialog asks for no account's status without a list.
  expect(api.fetchBrokerStatus).not.toHaveBeenCalled()
})

test('an account that cannot be read is listed as unavailable and cannot be chosen', async () => {
  api.fetchAccounts.mockResolvedValue({ ...accounts(robinhood.id), unusableAccounts: [unreadable] })
  const utils = renderMenu()
  const menu = utils.getByRole('menu')
  await waitFor(() => expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(3))

  const [first, second, unusable] = within(menu).getAllByRole('menuitemradio')
  expect(unusable.textContent).toContain(unreadable.label)
  expect(unusable.textContent).toContain('PAPER')
  expect(unusable.textContent).toContain('Alpaca Paper · Unavailable')
  expect(unusable.getAttribute('aria-disabled')).toBe('true')
  expect(unusable.getAttribute('aria-checked')).toBe('false')
  // The accounts that can be chosen are not disabled by it.
  expect(first.getAttribute('aria-disabled')).toBe('false')
  expect(second.getAttribute('aria-disabled')).toBe('false')

  openMenu(menu)
  fireEvent.click(unusable)

  expect(api.selectAccount).not.toHaveBeenCalled()
  expect(hidePopover).not.toHaveBeenCalled()
  expect(first.getAttribute('aria-checked')).toBe('true')

  // The arrow keys still reach it, so it is announced rather than skipped.
  expect(document.activeElement).toBe(first)
  fireEvent.keyDown(menu, { key: 'ArrowDown' })
  fireEvent.keyDown(menu, { key: 'ArrowDown' })
  expect(document.activeElement).toBe(unusable)
})

test('a label too long for its row can be read in full', async () => {
  api.fetchAccounts.mockResolvedValue({ ...accounts(robinhood.id), unusableAccounts: [unreadable] })
  const utils = renderMenu()
  const menu = utils.getByRole('menu')

  await waitFor(() => expect(within(menu).getByTitle(unreadable.label).textContent).toBe(unreadable.label))
  expect(within(menu).getByTitle(paper.label).textContent).toBe(paper.label)
})
