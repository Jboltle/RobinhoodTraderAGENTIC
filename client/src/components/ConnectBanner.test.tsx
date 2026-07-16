// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'

import { ConnectBanner } from './ConnectBanner'
import type { AuthStatus } from '../lib/api'

const { fetchAuthStatus } = vi.hoisted(() => ({
  fetchAuthStatus: vi.fn<() => Promise<AuthStatus>>(),
}))
vi.mock('../lib/api', () => ({
  fetchAuthStatus,
  submitAuthRedirect: vi.fn(),
}))

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

test('shows authorize link and paste form while disconnected', async () => {
  fetchAuthStatus.mockResolvedValue({
    connected: false,
    authUrl: 'https://robinhood.com/mcp/trading?state=abc',
    executionMode: 'immediate',
  })
  const { container } = renderBanner()

  await waitFor(() =>
    expect(container.textContent).toContain('Robinhood not connected'),
  )
  const link = container.querySelector(
    'a[href="https://robinhood.com/mcp/trading?state=abc"]',
  )
  expect(link?.getAttribute('target')).toBe('_blank')
  expect(link?.getAttribute('rel')).toBe('noopener')
  expect(container.querySelector('input')).not.toBeNull()
})

test('renders nothing once connected', async () => {
  fetchAuthStatus.mockResolvedValue({
    connected: true,
    authUrl: null,
    executionMode: 'immediate',
  })
  const { container } = renderBanner()

  await waitFor(() => expect(fetchAuthStatus).toHaveBeenCalled())
  expect(container.textContent).toBe('')
})
