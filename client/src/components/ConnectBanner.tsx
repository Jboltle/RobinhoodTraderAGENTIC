import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ExternalLink } from 'lucide-react'

import { connectBroker, fetchBrokerStatus, submitBrokerRedirect } from '../lib/api'
import type { BrokerStatus } from '../lib/api'

const STATUS_POLL_MS = 5000
const CLIPBOARD_POLL_MS = 1000
/** A pasted callback URL always has this; anything else in the clipboard isn't one. */
const CALLBACK_URL_RE = /^https?:\/\/\S*[?&]code=[^&\s]+/

/**
 * Robinhood connect flow.
 *
 * Robinhood pins redirect URIs per client and only allowlists loopback, so
 * after consent the browser lands on the user's own 127.0.0.1 with nothing
 * listening. There is no way to read that URL back — the user has to copy it.
 * Clipboard polling makes the copy the last thing they do; the paste box stays
 * as the fallback for when clipboard permission is denied, the page isn't in a
 * secure context, or the browser simply refuses.
 */
export function ConnectBanner() {
  const queryClient = useQueryClient()
  const status = useQuery<BrokerStatus>({
    queryKey: ['broker-status'],
    queryFn: fetchBrokerStatus,
    refetchInterval: STATUS_POLL_MS,
    retry: false,
  })

  const [redirectUrl, setRedirectUrl] = useState('')
  const [authUrl, setAuthUrl] = useState<string | null>(null)

  const submit = useMutation({
    mutationFn: submitBrokerRedirect,
    onSuccess: () => {
      setRedirectUrl('')
      void queryClient.invalidateQueries({ queryKey: ['broker-status'] })
    },
  })

  const connect = useMutation({
    mutationFn: connectBroker,
    onSuccess: (result) => {
      setAuthUrl(result.authUrl)
      if (result.authUrl) window.open(result.authUrl, '_blank', 'noopener')
      void queryClient.invalidateQueries({ queryKey: ['broker-status'] })
    },
  })

  const data = status.data
  const pendingUrl = authUrl ?? data?.authUrl ?? null
  const awaitingPaste = pendingUrl !== null && !submit.isSuccess

  const clipboard = useClipboardCallback(awaitingPaste, (url) => {
    if (!submit.isPending) submit.mutate(url)
  })

  if (!data || data.connected || data.executionMode !== 'immediate') return null

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-warn/40 bg-warn/10 px-5 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="size-2 animate-pulse rounded-full bg-warn" />
        <span className="text-sm font-medium text-white">Robinhood not connected</span>
        {!pendingUrl && (
          <button
            type="button"
            onClick={() => connect.mutate()}
            disabled={connect.isPending}
            className="rounded-md bg-warn/20 px-3 py-1.5 text-xs font-medium text-warn transition-colors hover:bg-warn/30 disabled:opacity-50"
          >
            {connect.isPending ? 'Starting…' : 'Connect Robinhood'}
          </button>
        )}
      </div>

      <BeforeYouStart />

      {connect.isError && (
        <p className="text-xs text-loss">{(connect.error as Error).message}</p>
      )}

      {pendingUrl && (
        <div className="flex flex-col gap-3">
          <a
            href={pendingUrl}
            target="_blank"
            rel="noopener"
            className="inline-flex w-fit items-center gap-1.5 rounded-md bg-warn/20 px-3 py-1.5 text-xs font-medium text-warn transition-colors hover:bg-warn/30"
          >
            Authorize in Robinhood
            <ExternalLink className="size-3.5" />
          </a>

          <p className="text-xs text-ink-400">
            {clipboard.watching
              ? 'Waiting for you to approve — copy the address from the error page and it will be picked up automatically.'
              : 'After approving, copy the 127.0.0.1 address from your browser and paste it below.'}
          </p>

          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (redirectUrl.trim()) submit.mutate(redirectUrl.trim())
            }}
          >
            <input
              type="text"
              value={redirectUrl}
              onChange={(e) => setRedirectUrl(e.target.value)}
              placeholder="http://127.0.0.1:8788/oauth/callback?code=…"
              className="w-full max-w-xl rounded-lg border border-ink-600 bg-ink-800 px-3 py-2 text-sm text-white placeholder:text-ink-400 focus:border-brand focus:outline-none"
            />
            <button
              type="submit"
              disabled={submit.isPending || !redirectUrl.trim()}
              className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-ink-900 transition-opacity disabled:opacity-50"
            >
              {submit.isPending ? 'Connecting…' : 'Finish connecting'}
            </button>
          </form>

          {submit.isPending && (
            <span className="text-xs text-ink-400">Exchanging the code for tokens…</span>
          )}
          {submit.isSuccess && (
            <span className="text-xs text-ink-400">
              Code submitted — waiting for the connection to come up…
            </span>
          )}
          {submit.isError && (
            <span className="text-xs text-loss">{(submit.error as Error).message}</span>
          )}
        </div>
      )}
    </div>
  )
}

/** The two things that surprise people, said before they hit the button. */
function BeforeYouStart() {
  return (
    <ul className="flex flex-col gap-2 text-xs text-ink-400">
      <li className="flex gap-2">
        <AlertTriangle className="mt-px size-3.5 shrink-0 text-warn" />
        <span>
          After you approve, your browser will show{' '}
          <span className="text-white">“can’t reach this page”</span>. That is
          expected — Robinhood redirects to <code>127.0.0.1</code> on your own
          machine, where nothing is listening. The address bar still holds what
          we need.
        </span>
      </li>
      <li className="flex gap-2">
        <AlertTriangle className="mt-px size-3.5 shrink-0 text-warn" />
        <span>
          Connecting uses up this Robinhood account’s{' '}
          <span className="text-white">Claude Code</span> agent slot — the app
          authorizes under that name. If you use Claude Code with this Robinhood
          account, connecting here will collide with it.
        </span>
      </li>
    </ul>
  )
}

/**
 * Poll the clipboard for the pasted callback URL while a flow is pending.
 *
 * Reading the clipboard needs both a secure context and permission, and
 * browsers may reject it at any point (or only while the tab is unfocused).
 * Any refusal stops the polling for good and leaves the paste box as the way
 * through, rather than retrying into a wall of permission prompts.
 */
function useClipboardCallback(
  enabled: boolean,
  onFound: (url: string) => void,
): { watching: boolean } {
  const [watching, setWatching] = useState(false)
  const onFoundRef = useRef(onFound)
  onFoundRef.current = onFound

  useEffect(() => {
    if (!enabled || !window.isSecureContext || !navigator.clipboard?.readText) {
      setWatching(false)
      return
    }

    let stopped = false
    let lastSeen = ''
    setWatching(true)

    const poll = async (): Promise<void> => {
      if (stopped || document.visibilityState !== 'visible') return
      try {
        const text = (await navigator.clipboard.readText()).trim()
        if (text === lastSeen) return
        lastSeen = text
        if (CALLBACK_URL_RE.test(text)) {
          stopped = true
          setWatching(false)
          onFoundRef.current(text)
        }
      } catch {
        // Denied, dismissed, or unsupported: the paste box is the fallback.
        stopped = true
        setWatching(false)
      }
    }

    const timer = setInterval(() => void poll(), CLIPBOARD_POLL_MS)
    return () => {
      stopped = true
      clearInterval(timer)
      setWatching(false)
    }
  }, [enabled])

  return { watching }
}
