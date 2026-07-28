// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { ConnectBanner } from './ConnectBanner'
import type { BrokerConnectResult, BrokerStatus } from '../lib/api'

const { fetchBrokerStatus, connectBroker, submitBrokerRedirect } = vi.hoisted(() => ({
  fetchBrokerStatus: vi.fn<() => Promise<BrokerStatus>>(),
  connectBroker: vi.fn<() => Promise<BrokerConnectResult>>(),
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
  return render(
    <QueryClientProvider client={queryClient}>
      <ConnectBanner />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  submitBrokerRedirect.mockResolvedValue(undefined)
  vi.stubGlobal('open', vi.fn())
})

// The suite runs without `globals`, so Testing Library's auto-cleanup never
// registers and each render would otherwise pile up in the same document.
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('warns about the dead-end page and the Claude Code slot before connecting', async () => {
  fetchBrokerStatus.mockResolvedValue(disconnected)
  const { container } = renderBanner()

  await waitFor(() =>
    expect(container.textContent).toContain('Robinhood not connected'),
  )
  expect(container.textContent).toContain('can’t reach this page')
  expect(container.textContent).toContain('127.0.0.1')
  expect(container.textContent).toContain('Claude Code')
})

test('connecting opens the authorization URL and reveals the paste fallback', async () => {
  fetchBrokerStatus.mockResolvedValue(disconnected)
  connectBroker.mockResolvedValue({ connected: false, authUrl: AUTH_URL })
  const { container, findByRole } = renderBanner()

  fireEvent.click(await findByRole('button', { name: 'Connect Robinhood' }))

  await waitFor(() =>
    expect(container.querySelector(`a[href="${AUTH_URL}"]`)).not.toBeNull(),
  )
  expect(window.open).toHaveBeenCalledWith(AUTH_URL, '_blank', 'noopener')
  expect(container.querySelector('input')).not.toBeNull()
})

test('a pasted redirect URL is submitted to the trader', async () => {
  fetchBrokerStatus.mockResolvedValue({ ...disconnected, authUrl: AUTH_URL })
  const { container, findByRole } = renderBanner()

  await waitFor(() => expect(container.querySelector('input')).not.toBeNull())
  const pasted = 'http://127.0.0.1:8788/oauth/callback?code=the-code&state=s'
  fireEvent.change(container.querySelector('input')!, { target: { value: pasted } })
  fireEvent.click(await findByRole('button', { name: 'Finish connecting' }))

  await waitFor(() => expect(submittedUrls()).toEqual([pasted]))
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

  renderBanner()

  await waitFor(() => expect(submittedUrls()).toEqual([pasted]), { timeout: 4000 })
})

test('falls back to the paste box when clipboard permission is denied', async () => {
  fetchBrokerStatus.mockResolvedValue({ ...disconnected, authUrl: AUTH_URL })
  const readText = vi.fn().mockRejectedValue(new Error('permission denied'))
  vi.stubGlobal('isSecureContext', true)
  vi.stubGlobal('navigator', { ...navigator, clipboard: { readText } })

  const { container } = renderBanner()

  await waitFor(() => expect(readText).toHaveBeenCalled(), { timeout: 4000 })
  // The manual path is still there and nothing was auto-submitted.
  expect(container.querySelector('input')).not.toBeNull()
  expect(submitBrokerRedirect).not.toHaveBeenCalled()
})
