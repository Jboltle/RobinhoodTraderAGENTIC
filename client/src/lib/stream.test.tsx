// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { useTraderStream } from './stream'

vi.mock('./api', () => ({
  TRADER_URL: '',
  authHeaders: () => ({ authorization: 'Bearer a-token' }),
}))

/** One GET /api/stream the hook opened: its abort signal and a way to push frames into it. */
interface OpenedStream {
  signal: AbortSignal
  push(frame: string): void
}

let opened: OpenedStream[]

beforeEach(() => {
  opened = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const encoder = new TextEncoder()
      let controller!: ReadableStreamDefaultController<Uint8Array>
      const body = new ReadableStream<Uint8Array>({
        start(streamController) {
          controller = streamController
        },
      })
      opened.push({
        signal: init.signal!,
        push: (frame) => controller.enqueue(encoder.encode(frame)),
      })
      return new Response(body, { status: 200 })
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const decisionsFrame = (decisions: unknown[]): string =>
  `event: decisions\ndata: ${JSON.stringify(decisions)}\n\n`

interface StreamProps {
  enabled: boolean
  viewedAccountId: string | undefined
}

function renderStream(initialProps: StreamProps) {
  const queryClient = new QueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  const hook = renderHook(
    ({ enabled, viewedAccountId }: StreamProps) => useTraderStream(enabled, viewedAccountId),
    { wrapper, initialProps },
  )
  return { queryClient, ...hook }
}

test('opens nothing until it is enabled', async () => {
  const { rerender } = renderStream({ enabled: false, viewedAccountId: undefined })
  expect(opened).toHaveLength(0)

  rerender({ enabled: true, viewedAccountId: 'account-robinhood' })
  await waitFor(() => expect(opened).toHaveLength(1))
})

test('a switch closes the stream and opens one for the new account', async () => {
  const { queryClient, rerender } = renderStream({
    enabled: true,
    viewedAccountId: 'account-robinhood',
  })
  await waitFor(() => expect(opened).toHaveLength(1))
  opened[0].push(decisionsFrame([{ messageId: 'robinhood-trade' }]))
  await waitFor(() =>
    expect(queryClient.getQueryData(['decisions'])).toEqual([{ messageId: 'robinhood-trade' }]),
  )

  rerender({ enabled: true, viewedAccountId: 'account-paper' })

  expect(opened[0].signal.aborted).toBe(true)
  await waitFor(() => expect(opened).toHaveLength(2))
  expect(opened[1].signal.aborted).toBe(false)
  opened[1].push(decisionsFrame([{ messageId: 'paper-trade' }]))
  await waitFor(() =>
    expect(queryClient.getQueryData(['decisions'])).toEqual([{ messageId: 'paper-trade' }]),
  )
})

test('a frame still arriving on the closed stream never reaches the cache', async () => {
  const { queryClient, rerender } = renderStream({
    enabled: true,
    viewedAccountId: 'account-robinhood',
  })
  await waitFor(() => expect(opened).toHaveLength(1))

  rerender({ enabled: true, viewedAccountId: 'account-paper' })
  await waitFor(() => expect(opened).toHaveLength(2))
  // The previous account's stream delivers one last frame after the switch.
  opened[0].push(decisionsFrame([{ messageId: 'robinhood-trade' }]))
  opened[1].push(`event: stage\ndata: ${JSON.stringify({ messageId: 'm', ticker: 'TSLA', stage: 'parsing', at: 'now' })}\n\n`)

  // The new stream's frame has been applied, so the old one has been read too.
  await waitFor(() => expect(queryClient.getQueryData(['trade-stage'])).toMatchObject({ ticker: 'TSLA' }))
  expect(queryClient.getQueryData(['decisions'])).toBeUndefined()
})

test('rerendering with the same account keeps the stream open', async () => {
  const { rerender } = renderStream({ enabled: true, viewedAccountId: 'account-robinhood' })
  await waitFor(() => expect(opened).toHaveLength(1))

  rerender({ enabled: true, viewedAccountId: 'account-robinhood' })

  expect(opened[0].signal.aborted).toBe(false)
  expect(opened).toHaveLength(1)
})
