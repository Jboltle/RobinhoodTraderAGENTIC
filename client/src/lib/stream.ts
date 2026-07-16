/**
 * Live dashboard updates over SSE (GET /api/stream on the trader), replacing
 * per-query refetchInterval polling. Events are written into the TanStack
 * Query cache under the same keys the routes already read, so components
 * consume them through their existing useQuery calls unchanged.
 *
 * Reconnects are handled by EventSource itself; the server re-sends a full
 * snapshot on every (re)connect, so no client-side catch-up logic is needed.
 */
import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import {
  TRADER_URL,
  type Decision,
  type PerformanceRow,
  type StageEvent,
} from './api'

interface PerformanceEvent {
  positions: PerformanceRow[] | null
  error: string | null
}

export function useTraderStream(): void {
  const queryClient = useQueryClient()

  useEffect(() => {
    const source = new EventSource(`${TRADER_URL}/api/stream`)

    source.addEventListener('decisions', (event) => {
      queryClient.setQueryData<Decision[]>(
        ['decisions'],
        JSON.parse(event.data) as Decision[],
      )
    })

    source.addEventListener('stage', (event) => {
      const stage = JSON.parse(event.data) as StageEvent
      // 'done' clears the banner; the decisions frame that follows carries the
      // outcome. Only the latest in-flight trade is tracked (single pipeline).
      queryClient.setQueryData<StageEvent | null>(
        ['trade-stage'],
        stage.stage === 'done' ? null : stage,
      )
    })

    source.addEventListener('performance', (event) => {
      const { positions } = JSON.parse(event.data) as PerformanceEvent
      // ponytail: error-shaped events (Robinhood down/unauthed) keep the last
      // good snapshot rather than surfacing an error. Upgrade path: mirror the
      // error field into the cache if the dashboard needs to display it.
      if (positions) {
        queryClient.setQueryData<PerformanceRow[]>(['performance'], positions)
      }
    })

    return () => source.close()
  }, [queryClient])
}
