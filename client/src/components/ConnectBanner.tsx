import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { fetchAuthStatus, submitAuthRedirect } from '../lib/api'
import type { AuthStatus } from '../lib/api'

const AUTH_STATUS_POLL_MS = 5000

/**
 * Robinhood OAuth connect banner for deployed dashboards. Robinhood only
 * allowlists loopback redirect URIs, so after consent the browser dead-ends on
 * the user's own 127.0.0.1 — the user copies that URL from the address bar and
 * pastes it here to complete the token exchange on the server.
 */
export function ConnectBanner() {
  const queryClient = useQueryClient()
  const status = useQuery<AuthStatus>({
    queryKey: ['auth-status'],
    queryFn: fetchAuthStatus,
    refetchInterval: AUTH_STATUS_POLL_MS,
    retry: false,
  })
  const [redirectUrl, setRedirectUrl] = useState('')
  const submit = useMutation({
    mutationFn: submitAuthRedirect,
    onSuccess: () => {
      setRedirectUrl('')
      void queryClient.invalidateQueries({ queryKey: ['auth-status'] })
    },
  })

  const data = status.data
  if (!data || data.connected || data.executionMode !== 'immediate') return null

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-warn/40 bg-warn/10 px-5 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="size-2 animate-pulse rounded-full bg-warn" />
        <span className="text-sm font-medium text-white">
          Robinhood not connected
        </span>
        {data.authUrl ? (
          <a
            href={data.authUrl}
            target="_blank"
            rel="noopener"
            className="rounded-md bg-warn/20 px-3 py-1.5 text-xs font-medium text-warn transition-colors hover:bg-warn/30"
          >
            Authorize Robinhood ↗
          </a>
        ) : (
          <span className="text-xs text-ink-400">
            Waiting for the server to start the authorization flow…
          </span>
        )}
      </div>
      {data.authUrl && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (redirectUrl.trim()) submit.mutate(redirectUrl)
          }}
        >
          <input
            type="text"
            value={redirectUrl}
            onChange={(e) => setRedirectUrl(e.target.value)}
            placeholder="After approving, paste the 127.0.0.1 URL from your address bar"
            className="w-full max-w-xl rounded-lg border border-ink-600 bg-ink-800 px-3 py-2 text-sm text-white placeholder:text-ink-400 focus:border-brand focus:outline-none"
          />
          <button
            type="submit"
            disabled={submit.isPending || !redirectUrl.trim()}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white transition-opacity disabled:opacity-50"
          >
            {submit.isPending ? 'Submitting…' : 'Connect'}
          </button>
          {submit.isSuccess && (
            <span className="text-xs text-ink-400">
              Code submitted — waiting for connection…
            </span>
          )}
          {submit.isError && (
            <span className="text-xs text-loss">
              {(submit.error as Error).message}
            </span>
          )}
        </form>
      )}
    </div>
  )
}
