import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import {
  CONNECTION_GONE_NOTICE,
  CONNECT_A_BROKER_LABEL,
  connectControl,
  connectionGone,
  connectionToRepair,
  selectedAccount,
  useAccounts,
  viewedAccountConnected,
} from '../lib/accounts'
import type { ConnectControl, ListedAccount } from '../lib/accounts'
import { fetchBrokerStatus } from '../lib/api'
import type { BrokerStatus } from '../lib/api'
import { ConnectDialog } from './ConnectDialog'

const UNKNOWN_ACCOUNT_LABEL = 'Account'
/** What the Robinhood login connects, whichever account is viewed. */
const ROBINHOOD_LABEL = 'Robinhood'

function controlLabel(control: ConnectControl, account: ListedAccount | undefined): string {
  switch (control) {
    case 'chooser':
      return CONNECT_A_BROKER_LABEL
    case 'repair':
      return `Reconnect ${account?.label}`
    case 'robinhood':
      return `Connect ${account?.label ?? ROBINHOOD_LABEL}`
  }
}

// Idle watchdog cadence. A disconnect made in this app invalidates the query
// at once, and ConnectDialog polls fast while a connect is in flight, so this
// only bounds how late a disconnect made elsewhere shows.
const STATUS_POLL_MS = 30_000

/**
 * The viewed account's connection watchdog, mounted on every signed-in page.
 *
 * Prompts to connect whenever that account has no connection on record,
 * regardless of execution mode: approval-mode trades also need the broker to
 * submit, and the pipeline only fans out to accounts with a stored connection.
 *
 * Its one button depends on the sign-in (connectControl). One that may connect
 * other brokers gets the chooser from whichever account is not connected, or
 * the portal straight away when the viewed account's brokerage login broke.
 * Any other gets the Robinhood login while the Robinhood account is the one
 * being viewed, and the notice alone otherwise.
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
  const accounts = useAccounts()
  // Undefined when the account list could not be read: the notice then names
  // no account, and the button still says what it does.
  const account = selectedAccount(accounts.data)
  const repairConnectionId = connectionToRepair(accounts.data)
  const control = connectControl(accounts.data)

  const connected = viewedAccountConnected(accounts.data, status.data)

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

  // Waits for the account list too, so the notice never names the wrong account.
  if (connected === undefined || accounts.isPending) return null
  if (connected && !dialogOpen) return null

  return (
    <>
      {!connected && (
        <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-warn/40 bg-warn/10 px-5 py-4">
          <span className="size-2 animate-pulse rounded-full bg-warn" />
          <span className="text-sm font-medium text-white">
            {account?.label ?? UNKNOWN_ACCOUNT_LABEL} not connected
            {connectionGone(account) && `. ${CONNECTION_GONE_NOTICE}`}
          </span>
          {control !== null && (
            <button
              type="button"
              onClick={() => setDialogOpen(true)}
              className="rounded-md bg-warn/20 px-3 py-1.5 text-xs font-medium text-warn transition-colors hover:bg-warn/30"
            >
              {controlLabel(control, account)}
            </button>
          )}
        </div>
      )}

      <ConnectDialog
        open={dialogOpen}
        force={false}
        onClose={() => setDialogOpen(false)}
        repairConnectionId={repairConnectionId}
      />
    </>
  )
}
