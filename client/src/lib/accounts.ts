/**
 * The user's brokerage accounts and the one the screens show.
 *
 * The server holds the selection (GET /api/accounts names it) and every
 * per-account route acts on it, so nothing here passes an account id along
 * with a request. What the client owes in return is to drop everything it
 * cached for the previous account the moment the selection moves.
 */
import { useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'

import { fetchAccounts } from './api'
import type { AccountSummary, AccountsResponse, BrokerEntry } from './api'

export const ACCOUNTS_QUERY_KEY = ['accounts'] as const

/** An account together with the adapter it is reached through. */
export interface ListedAccount extends AccountSummary {
  adapter: BrokerEntry['adapter']
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
    retry: false,
    ...options,
  })
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
 * it: the menu here, or another tab. Queries on screen refetch for the new
 * account; the ones the stream fills (decisions, performance, trade stage)
 * empty out until the reopened stream sends that account's snapshot.
 *
 * ponytail: this also refetches the shared queries (book, callers, recaps),
 * one extra request each per switch, rather than keeping a list of which
 * keys are per-account that a new query could be left off. Upgrade path: a
 * common key prefix for per-account queries.
 */
export function useResetOnAccountSwitch(viewedAccountId: string | undefined): void {
  const queryClient = useQueryClient()
  const previous = useRef(viewedAccountId)

  useEffect(() => {
    if (viewedAccountId === undefined) return
    const switched = previous.current !== undefined && previous.current !== viewedAccountId
    previous.current = viewedAccountId
    if (!switched) return
    // The account list itself is what just told us; it is already current.
    void queryClient.resetQueries({
      predicate: (query) => query.queryKey[0] !== ACCOUNTS_QUERY_KEY[0],
    })
  }, [queryClient, viewedAccountId])
}
