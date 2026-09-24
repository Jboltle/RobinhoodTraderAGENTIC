// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { ConnectBanner } from './ConnectBanner'
import { ConnectDialog } from './ConnectDialog'
import type { BrokerConnectResult, BrokerStatus } from '../lib/api'

const { fetchBrokerStatus, connectBroker, submitBrokerRedirect } = vi.hoisted(() => ({
  fetchBrokerStatus: vi.fn<() => Promise<BrokerStatus>>(),
  connectBroker: vi.fn<(options: { force: boolean }) => Promise<BrokerConnectResult>>(),
  submitBrokerRedirect: vi.fn<(url: string) => Promise<void>>(),
}))
vi.mock('../lib/api', () => ({ fetchBrokerStatus, connectBroker, submitBrokerRedirect }))

const AUTH_URL = 'https://robinhood.com/mcp/trading?state=abc'

/** TanStack Query passes a context object after the variables; ignore it. */
const submittedUrls = (): string[] =>
  submitBrokerRedirect.mock.calls.map((call) => call[0])

const disconnected: BrokerStatus = {
  connected: false,
  authUrl: null,
  tokenState: 'missing',
  executionMode: 'immediate',
}

function renderBanner() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <ConnectBanner />
      </QueryClientProvider>,
    ),
  }
}

/** jsdom's <dialog> is incomplete; showModal/close must flip the open flag. */
function stubDialog() {
  const proto = HTMLDialogElement.prototype
  if (!proto.showModal || proto.showModal.toString().includes('not implemented')) {
    proto.showModal = function showModal() {
      this.setAttribute('open', '')
    }
  }
  if (!proto.close || proto.close.toString().includes('not implemented')) {
    proto.close = function close() {
      this.removeAttribute('open')
      this.dispatchEvent(new Event('close'))
    }
  }
}

async function openConnectDialog(
  utils: ReturnType<typeof renderBanner>,
): Promise<void> {
  fireEvent.click(await utils.findByRole('button', { name: 'Connect Robinhood' }))
  await utils.findByRole('dialog')
}

beforeEach(() => {
  vi.clearAllMocks()
  submitBrokerRedirect.mockResolvedValue(undefined)
  connectBroker.mockResolvedValue({ connected: false, authUrl: AUTH_URL })
  vi.stubGlobal('open', vi.fn())
  stubDialog()
})

// The suite runs without `globals`, so Testing Library's auto-cleanup never
// registers and each render would otherwise pile up in the same document.
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('slim banner hides the warnings until the dialog opens', async () => {
  fetchBrokerStatus.mockResolvedValue(disconnected)
  const { container, findByRole } = renderBanner()

  await waitFor(() =>
    expect(container.textContent).toContain('Robinhood not connected'),
  )
  const dialog = container.querySelector('dialog')
  expect(dialog).not.toBeNull()
  expect(dialog!.open).toBe(false)

  fireEvent.click(await findByRole('button', { name: 'Connect Robinhood' }))
  await waitFor(() => expect(dialog!.open).toBe(true))
  expect(dialog!.textContent).toContain('can’t reach this page')
  expect(dialog!.textContent).toContain('127.0.0.1')
  expect(dialog!.textContent).toContain('Claude Code')
})

test('Connect opens the dialog without popping Robinhood; Authorize does', async () => {
  fetchBrokerStatus.mockResolvedValue(disconnected)
  const utils = renderBanner()

  await openConnectDialog(utils)
  expect(window.open).not.toHaveBeenCalled()

  await waitFor(() =>
    expect(utils.container.querySelector(`a[href="${AUTH_URL}"]`)).not.toBeNull(),
  )
  fireEvent.click(utils.container.querySelector(`a[href="${AUTH_URL}"]`)!)
  expect(window.open).toHaveBeenCalledWith(AUTH_URL, '_blank', 'noopener')
  expect(utils.container.querySelector('input')).not.toBeNull()
})

test('a pasted redirect URL is submitted to the trader', async () => {
  fetchBrokerStatus.mockResolvedValue({ ...disconnected, authUrl: AUTH_URL })
  const utils = renderBanner()

  await openConnectDialog(utils)
  await waitFor(() => expect(utils.container.querySelector('input')).not.toBeNull())
  const pasted = 'http://127.0.0.1:8788/oauth/callback?code=the-code&state=s'
  fireEvent.change(utils.container.querySelector('input')!, { target: { value: pasted } })
  fireEvent.click(await utils.findByRole('button', { name: 'Finish connecting' }))

  await waitFor(() => expect(submittedUrls()).toEqual([pasted]))
})

test('prompts in approval mode too — the default for new users', async () => {
  fetchBrokerStatus.mockResolvedValue({ ...disconnected, executionMode: 'approval' })
  const { container } = renderBanner()

  await waitFor(() =>
    expect(container.textContent).toContain('Robinhood not connected'),
  )
})

test('renders nothing once connected', async () => {
  fetchBrokerStatus.mockResolvedValue({ ...disconnected, connected: true })
  const { container } = renderBanner()

  await waitFor(() => expect(fetchBrokerStatus).toHaveBeenCalled())
  expect(container.textContent).toBe('')
})

test('clipboard polling auto-submits a copied callback URL', async () => {
  fetchBrokerStatus.mockResolvedValue({ ...disconnected, authUrl: AUTH_URL })
  const pasted = 'http://127.0.0.1:8788/oauth/callback?code=auto-detected&state=s'
  vi.stubGlobal('isSecureContext', true)
  vi.stubGlobal('navigator', {
    ...navigator,
    clipboard: { readText: vi.fn().mockResolvedValue(pasted) },
  })

  const utils = renderBanner()
  await openConnectDialog(utils)

  await waitFor(() => expect(submittedUrls()).toEqual([pasted]), { timeout: 4000 })
})

test('falls back to the paste box when clipboard permission is denied', async () => {
  fetchBrokerStatus.mockResolvedValue({ ...disconnected, authUrl: AUTH_URL })
  const readText = vi.fn().mockRejectedValue(new Error('permission denied'))
  vi.stubGlobal('isSecureContext', true)
  vi.stubGlobal('navigator', { ...navigator, clipboard: { readText } })

  const utils = renderBanner()
  await openConnectDialog(utils)

  await waitFor(() => expect(readText).toHaveBeenCalled(), { timeout: 4000 })
  expect(utils.container.querySelector('input')).not.toBeNull()
  expect(submitBrokerRedirect).not.toHaveBeenCalled()
})

test('flashes Connected then closes the dialog', async () => {
  fetchBrokerStatus.mockResolvedValue(disconnected)
  const utils = renderBanner()
  await openConnectDialog(utils)

  fetchBrokerStatus.mockResolvedValue({ ...disconnected, connected: true })
  await utils.queryClient.invalidateQueries({ queryKey: ['broker-status'] })

  await waitFor(() =>
    expect(utils.container.textContent).toContain('Robinhood is connected.'),
  )

  await waitFor(() => expect(utils.container.textContent).toBe(''), { timeout: 3000 })
})

test('the banner connect flow does not force a session teardown', async () => {
  fetchBrokerStatus.mockResolvedValue(disconnected)
  const utils = renderBanner()

  await openConnectDialog(utils)
  await waitFor(() =>
    expect(connectBroker).toHaveBeenCalledWith({ force: false }, expect.anything()),
  )
})

test('the settings Reconnect dialog forces a fresh session', async () => {
  fetchBrokerStatus.mockResolvedValue({ ...disconnected, connected: true })
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <ConnectDialog open force onClose={() => {}} />
    </QueryClientProvider>,
  )

  await waitFor(() =>
    expect(connectBroker).toHaveBeenCalledWith({ force: true }, expect.anything()),
  )
})

// The client half of the stale-data fix: once the server reports the stored
// connection gone, account numbers and live prices must vanish rather than
// freeze at their last-known values.
test('a disconnected status clears cached portfolio and performance data', async () => {
  fetchBrokerStatus.mockResolvedValue(disconnected)
  const utils = renderBanner()
  utils.queryClient.setQueryData(['portfolio'], {
    portfolioValueUsd: 2137.2,
    buyingPowerUsd: 483,
    openPositions: 2,
  })
  utils.queryClient.setQueryData(['performance'], [{ symbol: 'AAPL' }])

  await waitFor(() =>
    expect(utils.queryClient.getQueryData(['portfolio'])).toBeUndefined(),
  )
  expect(utils.queryClient.getQueryData(['performance'])).toBeUndefined()
})
