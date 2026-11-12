// @vitest-environment jsdom
// The real snaptrade-react modal (antd underneath), rendered under this app's
// React: it mounts, frames the link, and reports what SnapTrade's page posts.
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import SnapTradePortal from './SnapTradePortal'

const PORTAL_ORIGIN = 'https://app.snaptrade.com'
const LOGIN_LINK = `${PORTAL_ORIGIN}/snapTrade/redeemToken?token=one-time`

const fromPortal = (data: unknown, origin = PORTAL_ORIGIN): void => {
  window.dispatchEvent(new MessageEvent('message', { data, origin }))
}

function renderPortal() {
  const handlers = { onSuccess: vi.fn(), onError: vi.fn(), onExit: vi.fn() }
  return { handlers, ...render(<SnapTradePortal loginLink={LOGIN_LINK} {...handlers} />) }
}

// snaptrade-react keeps a timestamp in localStorage, which this jsdom lacks.
beforeEach(() => {
  const stored = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('frames the portal link in a labelled iframe', async () => {
  renderPortal()

  const frame = await waitFor(() => {
    const found = document.querySelector<HTMLIFrameElement>('iframe[title="Connect your broker"]')
    expect(found).not.toBeNull()
    return found!
  })
  const src = new URL(frame.src)
  expect(src.origin).toBe(PORTAL_ORIGIN)
  expect(src.searchParams.get('token')).toBe('one-time')
})

test('reports success, failure and closing as SnapTrade posts them', () => {
  const { handlers } = renderPortal()

  fromPortal({ status: 'SUCCESS', authorizationId: 'authorization-1' })
  expect(handlers.onSuccess).toHaveBeenCalledTimes(1)

  fromPortal({ status: 'ERROR', statusCode: '400', detail: 'the broker refused the login' })
  expect(handlers.onError).toHaveBeenCalledExactlyOnceWith('the broker refused the login')

  expect(handlers.onExit).not.toHaveBeenCalled()
  fromPortal('CLOSE_MODAL')
  expect(handlers.onExit).toHaveBeenCalled()
})

test('ignores a message that does not come from SnapTrade', () => {
  const { handlers } = renderPortal()

  fromPortal({ status: 'SUCCESS' }, 'https://elsewhere.example')

  expect(handlers.onSuccess).not.toHaveBeenCalled()
})

test('can always be left: its own Close button, and Escape', () => {
  const { handlers, getByRole } = renderPortal()

  fireEvent.click(getByRole('button', { name: 'Close broker connection' }))
  expect(handlers.onExit).toHaveBeenCalledTimes(1)

  fireEvent.keyDown(document, { key: 'Escape' })
  expect(handlers.onExit).toHaveBeenCalledTimes(2)
})
