/**
 * Live dashboard updates over SSE (GET /api/stream on the trader). Events are
 * written into the TanStack Query cache under the same keys the routes already
 * read, so components consume them through their existing useQuery calls.
 *
 * Read with fetch rather than EventSource: EventSource cannot set an
 * Authorization header, and the alternative — putting the access token in the
 * query string — writes a live credential into every access log between here
 * and the server. The cost is that reconnection is ours to handle, which is
 * the retry loop below; the server re-sends a full snapshot on connect, so
 * there is no catch-up logic beyond reconnecting.
 */
import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'

import {
  TRADER_URL,
  authHeaders,
  type Decision,
  type PerformanceRow,
  type StageEvent,
} from './api'

const RECONNECT_DELAY_MS = 3000

interface PerformanceEvent {
  positions: PerformanceRow[] | null
  error: string | null
}

export function useTraderStream(enabled: boolean): void {
  const queryClient = useQueryClient()

  useEffect(() => {
    if (!enabled) return
    const abort = new AbortController()
    void streamUntilAborted(queryClient, abort.signal)
    return () => abort.abort()
  }, [queryClient, enabled])
}

async function streamUntilAborted(
  queryClient: QueryClient,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const response = await fetch(`${TRADER_URL}/api/stream`, {
        headers: { ...authHeaders(), accept: 'text/event-stream' },
        signal,
      })
      if (!response.ok || !response.body) {
        throw new Error(`stream failed: ${response.status}`)
      }
      await readFrames(response.body, (event, data) =>
        applyEvent(queryClient, event, data),
      )
    } catch {
      // Server restart, sleep, token refresh mid-flight: retry until unmounted.
    }
    if (signal.aborted) return
    await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS))
  }
}

/** Split an SSE byte stream into (event, data) pairs on blank-line boundaries. */
async function readFrames(
  body: ReadableStream<Uint8Array>,
  onFrame: (event: string, data: string) => void,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  for (;;) {
    const { value, done } = await reader.read()
    if (done) return
    buffer += decoder.decode(value, { stream: true })

    let boundary = buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      boundary = buffer.indexOf('\n\n')

      let event = 'message'
      const dataLines: string[] = []
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice('event:'.length).trim()
        else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim())
        // Anything else is a comment (the server's heartbeat) — ignore it.
      }
      if (dataLines.length > 0) onFrame(event, dataLines.join('\n'))
    }
  }
}

function applyEvent(queryClient: QueryClient, event: string, data: string): void {
  switch (event) {
    case 'decisions':
      queryClient.setQueryData<Decision[]>(['decisions'], JSON.parse(data) as Decision[])
      return
    case 'stage': {
      const stage = JSON.parse(data) as StageEvent
      // 'done' clears the banner; the decisions frame that follows carries the
      // outcome. Only the latest in-flight trade is tracked.
      queryClient.setQueryData<StageEvent | null>(
        ['trade-stage'],
        stage.stage === 'done' ? null : stage,
      )
      return
    }
    case 'performance': {
      const { positions } = JSON.parse(data) as PerformanceEvent
      // ponytail: error-shaped events (Robinhood down/unauthed) keep the last
      // good snapshot rather than surfacing an error. Upgrade path: mirror the
      // error field into the cache if the dashboard needs to display it.
      if (positions) {
        queryClient.setQueryData<PerformanceRow[]>(['performance'], positions)
      }
      return
    }
  }
}
