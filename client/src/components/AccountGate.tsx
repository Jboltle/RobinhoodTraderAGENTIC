import type { ReactNode } from 'react'

import { ViewedAccountContext, useAccounts, useResetOnAccountSwitch } from '../lib/accounts'
import { useTraderStream } from '../lib/stream'

const noticeClass =
  'rounded-xl border border-ink-600 bg-ink-800 px-4 py-6 text-center text-sm'

/**
 * Everything that shows or changes one account's data renders inside this,
 * and only once the page knows which account that is.
 *
 * Until the account list has loaded there are no screens and no live stream:
 * a page that does not know its account cannot say which one an Approve or a
 * Save is meant for. A list that cannot be read is an error with a retry, not
 * an empty dashboard.
 *
 * On a switch the previous account's screens are taken down in the same
 * render that learns of the new account, and the new ones go up only after
 * the caches have been emptied (useResetOnAccountSwitch). So a control on
 * screen always belongs to the account ViewedAccountContext names.
 */
export function AccountGate({ children }: { children: ReactNode }) {
  const accounts = useAccounts()
  const viewedAccountId = accounts.data?.selectedAccountId
  const cachedForAccountId = useResetOnAccountSwitch(viewedAccountId)
  // Opens once the account is known, and a switch reopens it on the new one.
  useTraderStream(viewedAccountId !== undefined, viewedAccountId)

  if (viewedAccountId === undefined && accounts.isError) {
    return (
      <div role="alert" className={`${noticeClass} text-loss`}>
        <p>Could not load your accounts: {accounts.error.message}</p>
        <button
          type="button"
          disabled={accounts.isFetching}
          onClick={() => void accounts.refetch()}
          className="mt-4 rounded-lg border border-ink-600 px-4 py-2 text-sm text-white transition-colors hover:border-brand disabled:opacity-50"
        >
          {accounts.isFetching ? 'Trying again…' : 'Try again'}
        </button>
      </div>
    )
  }
  if (viewedAccountId === undefined || cachedForAccountId !== viewedAccountId) {
    return <div className={`${noticeClass} text-ink-400`}>Loading…</div>
  }
  return <ViewedAccountContext value={viewedAccountId}>{children}</ViewedAccountContext>
}
