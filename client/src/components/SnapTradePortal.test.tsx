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

test('reports success and failure as SnapTrade posts them', () => {
  const { handlers } = renderPortal()

  fromPortal({ status: 'SUCCESS', authorizationId: 'authorization-1' })
  expect(handlers.onSuccess).toHaveBeenCalledTimes(1)

  fromPortal({ status: 'ERROR', statusCode: '400', detail: 'the broker refused the login' })
  expect(handlers.onError).toHaveBeenCalledExactlyOnceWith('the broker refused the login')

  expect(handlers.onExit).not.toHaveBeenCalled()
})

// SnapTrade's own "x" posts CLOSE_MODAL: snaptrade-react answers it by calling
// `close` and then `onExit`. An abandoned sign-in tab posts CLOSED: `onExit`
// alone. Both props are this component's one way out.
test('closing from inside SnapTrade lands in the same handler as the Close button', () => {
  const { handlers } = renderPortal()

  fromPortal('CLOSE_MODAL')
  expect(handlers.onExit).toHaveBeenCalledTimes(2)

  fromPortal('CLOSED')
  expect(handlers.onExit).toHaveBeenCalledTimes(3)
})

test('ignores a message that does not come from SnapTrade', () => {
  const { handlers } = renderPortal()

  fromPortal({ status: 'SUCCESS' }, 'https://elsewhere.example')

  expect(handlers.onSuccess).not.toHaveBeenCalled()
})

const portalFrame = (): HTMLIFrameElement | null =>
  document.querySelector<HTMLIFrameElement>('iframe[title="Connect your broker"]')

test('its Close button is part of the modal, ahead of the portal page for the keyboard', async () => {
  const { handlers, findByRole } = renderPortal()

  const close = await findByRole('button', { name: 'Close broker connection' })
  const frame = portalFrame()!
  const panel = frame.closest('.ant-modal-content')!
  // On the panel that holds the page, and before it: Tab reaches the button
  // first, from the page, without going through SnapTrade's iframe.
  expect(panel.contains(close)).toBe(true)
  expect(close.compareDocumentPosition(frame) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(close.tagName).toBe('BUTTON')
  expect(close.textContent).toBe('Close')

  fireEvent.click(close)
  expect(handlers.onExit).toHaveBeenCalledTimes(1)
})

test('Escape closes it wherever in the page the keyboard is, the modal included', async () => {
  const { handlers, findByRole } = renderPortal()
  const close = await findByRole('button', { name: 'Close broker connection' })

  fireEvent.keyDown(document.body, { key: 'Escape', keyCode: 27 })
  expect(handlers.onExit).toHaveBeenCalledTimes(1)

  // antd's modal handles Escape itself and lets it go no further.
  const modal = portalFrame()!.closest('.ant-modal-wrap')!
  fireEvent.keyDown(modal, { key: 'Escape', keyCode: 27 })
  expect(handlers.onExit).toHaveBeenCalledTimes(2)

  fireEvent.keyDown(close, { key: 'Escape', keyCode: 27 })
  expect(handlers.onExit).toHaveBeenCalledTimes(3)

  fireEvent.keyDown(document.body, { key: 'Enter', keyCode: 13 })
  expect(handlers.onExit).toHaveBeenCalledTimes(3)
})

test('unmounted, it leaves nothing of its own behind', async () => {
  const { findByRole, unmount } = renderPortal()
  await findByRole('button', { name: 'Close broker connection' })

  unmount()

  expect(document.querySelector('button[aria-label="Close broker connection"]')).toBeNull()
})
