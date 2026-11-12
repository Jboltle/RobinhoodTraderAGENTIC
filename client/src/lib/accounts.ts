/**
 * The user's brokerage accounts and the one the screens show.
 *
 * The server holds the selection (GET /api/accounts names it) and every
 * per-account route acts on it. What the client owes in return is to drop
 * everything it cached for the previous account the moment the selection
 * moves, and to say with each change it asks for which account the control
 * was rendered under (useViewedAccountId), so the server can refuse one made
 * from a screen that has fallen behind.
 */
import { createContext, useContext, useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'

import { fetchAccounts, setAccountChangedHandler } from './api'
import type { AccountSummary, AccountsResponse, BrokerEntry, BrokerStatus } from './api'

export const ACCOUNTS_QUERY_KEY = ['accounts'] as const

/** An account together with the adapter it is reached through. */
export interface ListedAccount extends AccountSummary {
  adapter: BrokerEntry['adapter']
  /** The SnapTrade connection the account came from; absent on a Robinhood account. */
  connectionId?: string
}

interface AccountsQueryOptions {
  enabled?: boolean
  refetchInterval?: number | false
}

export function useAccounts(
  options: AccountsQueryOptions = {},
): UseQueryResult<AccountsResponse> {
  return useQuery({
    queryKey: ACCOUNTS_QUERY_KEY,
    queryFn: fetchAccounts,
    // No silent retries: until the list loads nothing of an account is shown
    // (AccountGate), and that screen says so at once and offers the retry. A
    // list that fails to re-read later keeps the one already loaded.
    retry: false,
    ...options,
  })
}

/** The account the screens inside AccountGate are rendered for. */
export const ViewedAccountContext = createContext<string | null>(null)

/**
 * The account this control is rendered under, to send with the change it asks
 * for. Read here rather than from what api.ts last heard: that moves to the
 * new account as soon as the list arrives, a moment before the previous
 * account's rows leave the screen.
 */
export function useViewedAccountId(): string {
  const accountId = useContext(ViewedAccountContext)
  if (accountId === null) throw new Error('useViewedAccountId used outside AccountGate')
  return accountId
}

/** Every account in the response as one flat list, in the server's order. */
export function listAccounts(response: AccountsResponse | undefined): ListedAccount[] {
  return (response?.brokers ?? []).flatMap((entry): ListedAccount[] => {
    switch (entry.adapter) {
      case 'robinhood':
        return [{ ...entry.account, adapter: entry.adapter }]
      case 'snaptrade':
        return Object.values(entry.accounts).map((account) => ({
          ...account,
          adapter: entry.adapter,
        }))
    }
  })
}

/** The account the screens show; undefined until the list has loaded. */
export function selectedAccount(response: AccountsResponse | undefined): ListedAccount | undefined {
  return listAccounts(response).find((account) => account.id === response?.selectedAccountId)
}

export function useSelectedAccount(): ListedAccount | undefined {
  return selectedAccount(useAccounts().data)
}

/**
 * Whether the Robinhood login (ConnectDialog) is how the viewed account gets
 * connected. An account list that could not be read counts as yes: every
 * user has a Robinhood account and the login only ever acts on that one.
 */
export function connectsThroughRobinhood(account: ListedAccount | undefined): boolean {
  return account === undefined || account.adapter === 'robinhood'
}

/**
 * The SnapTrade connection to repair for the viewed account: set when its
 * brokerage login broke and this sign-in may open the portal to fix it.
 */
export function connectionToRepair(response: AccountsResponse | undefined): string | undefined {
  const account = selectedAccount(response)
  return response?.canConnectSnapTrade && account?.needsReconnect ? account.connectionId : undefined
}

/**
 * What the banner and the Settings card offer for the viewed account:
 *   repair    open the portal for its broken SnapTrade connection
 *   chooser   open the dialog on its first step, Robinhood or another broker
 *   robinhood open the Robinhood login, the only thing this sign-in can connect
 */
export type ConnectControl = 'repair' | 'chooser' | 'robinhood'

export function connectControl(response: AccountsResponse | undefined): ConnectControl | null {
  if (connectionToRepair(response) !== undefined) return 'repair'
  if (response?.canConnectSnapTrade) return 'chooser'
  return connectsThroughRobinhood(selectedAccount(response)) ? 'robinhood' : null
}

/** On a button that opens the chooser: it must not name one broker. */
export const CONNECT_A_BROKER_LABEL = 'Connect a broker'

/**
 * A SnapTrade account whose connection a sync no longer found at SnapTrade.
 * There is nothing to repair; the way back is to connect the broker again.
 */
export function connectionGone(account: ListedAccount | undefined): boolean {
  return account?.adapter === 'snaptrade' && !account.connected && !account.needsReconnect
}

export const CONNECTION_GONE_NOTICE = 'This connection no longer exists at the broker.'

/**
 * Whether the viewed account is connected; undefined while unknown. The
 * account list answers for a SnapTrade account: it stores no credentials,
 * which is all the status route looks at, and its state only moves on a sync,
 * which reads the list again. Robinhood keeps the status poll, which notices
 * a disconnect made elsewhere.
 */
export function viewedAccountConnected(
  response: AccountsResponse | undefined,
  status: BrokerStatus | undefined,
): boolean | undefined {
  const account = selectedAccount(response)
  return account?.adapter === 'snaptrade' ? account.connected : status?.connected
}

/** What an account is doing with callouts right now, in the menu's words. */
export function accountState(account: AccountSummary): string {
  if (account.needsReconnect) return 'Reconnect needed'
  if (!account.connected) return 'Not connected'
  if (account.followedCallerCount === 0) return 'Following no one'
  return account.executionMode === 'immediate' ? 'Immediate' : 'Approval'
}

/** 'alpaca-paper' -> 'Alpaca Paper'. */
export function institutionName(institution: string): string {
  return institution
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/**
 * Drop every cached answer when the viewed account changes, whatever changed
 * it: the menu here, or a switch made in another tab (which this one learns
 * of when the account list is read again, on returning to the tab or on a
 * request the server refuses). Queries on screen refetch for the new
 * account; the ones the stream fills (decisions, performance, trade stage)
 * empty out until the reopened stream sends that account's snapshot.
 *
 * Returns the account the caches now belong to. It trails `viewedAccountId`
 * by one render on a switch, and AccountGate shows no account's screens for
 * that render: they would be the new account's, over the previous one's data.
 *
 * ponytail: this also refetches the shared queries (book, callers, recaps),
 * one extra request each per switch, rather than keeping a list of which
 * keys are per-account that a new query could be left off. Upgrade path: a
 * common key prefix for per-account queries.
 */
export function useResetOnAccountSwitch(viewedAccountId: string | undefined): string | undefined {
  const queryClient = useQueryClient()
  const [cachedForAccountId, setCachedForAccountId] = useState(viewedAccountId)

  useEffect(() => {
    if (viewedAccountId === undefined || viewedAccountId === cachedForAccountId) return
    if (cachedForAccountId !== undefined) {
      // The account list itself is what just told us; it is already current.
      void queryClient.resetQueries({
        predicate: (query) => query.queryKey[0] !== ACCOUNTS_QUERY_KEY[0],
      })
    }
    setCachedForAccountId(viewedAccountId)
  }, [queryClient, viewedAccountId, cachedForAccountId])

  // A switch made in another tab reaches this one as a refused request: read
  // the list again, and the effect above takes it from there.
  useEffect(() => {
    setAccountChangedHandler(
      () => void queryClient.invalidateQueries({ queryKey: ACCOUNTS_QUERY_KEY }),
    )
    return () => setAccountChangedHandler(() => {})
  }, [queryClient])

  return cachedForAccountId
}
