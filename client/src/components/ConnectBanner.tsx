import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { fetchBrokerStatus } from '../lib/api'
import type { BrokerStatus } from '../lib/api'
import { ConnectDialog } from './ConnectDialog'

const STATUS_POLL_MS = 5000

/**
 * The app's Robinhood connection watchdog, mounted on every signed-in page.
 *
 * Prompts to connect whenever this user has no connection on record,
 * regardless of execution mode: approval-mode trades also need Robinhood to
 * submit, and the pipeline only fans out to users with a stored connection.
 *
 * It also keeps the dashboard honest: the moment the server reports
 * disconnected, the broker-derived caches are dropped so account numbers and
 * live prices vanish instead of freezing at their last-known values (the
 * server refuses to serve them anyway once the stored connection is gone).
 */
export function ConnectBanner() {
  const queryClient = useQueryClient()
  const status = useQuery<BrokerStatus>({
    queryKey: ['broker-status'],
    queryFn: fetchBrokerStatus,
    refetchInterval: STATUS_POLL_MS,
    retry: false,
  })

  const [dialogOpen, setDialogOpen] = useState(false)

  const data = status.data
  const connected = data?.connected

  useEffect(() => {
    if (connected === false) {
      queryClient.removeQueries({ queryKey: ['portfolio'] })
      queryClient.removeQueries({ queryKey: ['performance'] })
    }
    if (connected === true) {
      // Fresh numbers right after (re)connecting instead of on the next poll.
      void queryClient.invalidateQueries({ queryKey: ['portfolio'] })
    }
  }, [connected, queryClient])

  if (!data) return null
  if (connected && !dialogOpen) return null

  return (
    <>
      {!connected && (
        <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-warn/40 bg-warn/10 px-5 py-4">
          <span className="size-2 animate-pulse rounded-full bg-warn" />
          <span className="text-sm font-medium text-white">Robinhood not connected</span>
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            className="rounded-md bg-warn/20 px-3 py-1.5 text-xs font-medium text-warn transition-colors hover:bg-warn/30"
          >
            Connect Robinhood
          </button>
        </div>
      )}

      <ConnectDialog
        open={dialogOpen}
        force={false}
        onClose={() => setDialogOpen(false)}
      />
    </>
  )
}
