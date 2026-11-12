import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ExternalLink, X } from 'lucide-react'

import { ACCOUNTS_QUERY_KEY, listAccounts, useAccounts } from '../lib/accounts'
import {
  connectBroker,
  fetchBrokerStatus,
  fetchSnapTradeLink,
  submitBrokerRedirect,
  syncSnapTrade,
} from '../lib/api'
import type { BrokerStatus, SnapTradeSyncResult } from '../lib/api'

const STATUS_POLL_MS = 5000
const CLIPBOARD_POLL_MS = 1000
const SUCCESS_CLOSE_MS = 1500
/** A pasted callback URL always has this; anything else in the clipboard isn't one. */
const CALLBACK_URL_RE = /^https?:\/\/\S*[?&]code=[^&\s]+/

const ROBINHOOD_TITLE = 'Connect Robinhood'
const CHOICE_TITLE = 'Connect an account'
const OTHER_BROKER_TITLE = 'Connect another broker'
const PORTAL_CLOSED_NOTICE = 'You closed the broker connection. No account was added.'
const PORTAL_FAILED_NOTICE = 'The broker connection did not finish:'
const NO_ACCOUNT_LIST_NOTICE = 'Your accounts could not be read, so nothing was started. Try again.'

/** Why the dialog is back at the choice. Closing the portal oneself is not a failure. */
interface Notice {
  message: string
  isError: boolean
}
const failure = (message: string): Notice => ({ message, isError: true })

/**
 * What the open dialog shows. `loading` waits for the account list, which
 * says whether there is a choice to offer.
 */
type Step = 'loading' | 'choose' | 'robinhood' | 'other'

/** The portal's code and a link for it, fetched together as the portal opens. */
interface OpenPortal {
  Portal: typeof import('./SnapTradePortal').default
  url: string
}

/**
 * The connect/reconnect dialog, shared by the dashboard's ConnectBanner, the
 * settings page's connection section and the account menu.
 *
 * A sign-in that may connect other brokers (the account list says so) first
 * chooses between Robinhood and another broker; everyone else goes straight
 * to Robinhood. Another broker is connected in SnapTrade's Connection Portal
 * (SnapTradePortal); once it reports success the accounts are synced in and
 * the account list is read again. `repairConnectionId` opens that portal
 * directly, to repair one SnapTrade connection.
 *
 * The Robinhood flow connects the user's direct Robinhood account whichever
 * account is being viewed; the server's connect and callback routes do the
 * same.
 *
 * Choosing it starts the flow: with `force` the server tears down the current
 * session first, so a wedged-but-"connected" session gets a real retry.
 * Robinhood itself cannot be framed (X-Frame-Options: SAMEORIGIN), so the user
 * opens the consent page in a new tab from a button inside the dialog — a
 * fresh click, so the popup is not blocked.
 *
 * Robinhood pins redirect URIs per client and only allowlists loopback, so
 * after consent the browser lands on the user's own 127.0.0.1 with nothing
 * listening. There is no way to read that URL back — the user has to copy it.
 * Clipboard polling makes the copy the last thing they do; the paste box stays
 * as the fallback for when clipboard permission is denied, the page isn't in a
 * secure context, or the browser simply refuses.
 */
export function ConnectDialog({
  open,
  force,
  onClose,
  repairConnectionId,
}: {
  open: boolean
  force: boolean
  onClose: () => void
  /** Open straight into the portal, to repair this SnapTrade connection. */
  repairConnectionId?: string
}) {
  const queryClient = useQueryClient()
  const accounts = useAccounts({ refetchInterval: open ? STATUS_POLL_MS : false })

  const [chosen, setChosen] = useState<Step | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [portal, setPortal] = useState<OpenPortal | null>(null)

  // An account list that could not be read offers no choice: every user has a
  // Robinhood account, and that login is what this dialog always was.
  const firstStep: Step =
    accounts.isPending
      ? 'loading'
      : repairConnectionId !== undefined
        ? 'other'
        : accounts.data?.canConnectSnapTrade
          ? 'choose'
          : 'robinhood'
  const step = open ? (chosen ?? firstStep) : null
  const robinhoodOpen = step === 'robinhood'
  const otherOpen = step === 'other'

  // Mounted closed on every page via ConnectBanner, so it polls only while
  // open: that is when `connected` flipping after the paste closes the flow.
  const status = useQuery<BrokerStatus>({
    queryKey: ['broker-status'],
    queryFn: fetchBrokerStatus,
    refetchInterval: robinhoodOpen ? STATUS_POLL_MS : false,
    retry: false,
    // The account menu mounts this outside AccountGate: closed, it asks for
    // no account's status before the list has said which account is viewed.
    enabled: open || accounts.data !== undefined,
  })

  const [redirectUrl, setRedirectUrl] = useState('')
  const [authUrl, setAuthUrl] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  // Parents pass inline closures; a ref keeps effect deps to `open`/`connected`.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

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
      void queryClient.invalidateQueries({ queryKey: ['broker-status'] })
    },
  })

  // Reaching the Robinhood step is the "start connecting" gesture.
  const startConnect = useRef(connect.mutate)
  startConnect.current = connect.mutate
  useEffect(() => {
    if (robinhoodOpen) startConnect.current({ force })
  }, [robinhoodOpen, force])

  // ---- Another broker, through SnapTrade --------------------------------------

  // The account the screens show: a new account copies its settings.
  const viewedAccountId = accounts.data?.selectedAccountId

  const backToChoice = (reason: Notice | null): void => {
    setPortal(null)
    setChosen('choose')
    setNotice(reason)
  }
  // A link that arrives after the dialog was closed opens nothing, then or
  // at the next opening: it would be a stale one.
  const openRef = useRef(open)
  openRef.current = open

  const openPortal = useMutation({
    // The link lives five minutes, so it is asked for only now, together
    // with the portal's code: antd is not in the bundle everyone downloads.
    mutationFn: async (accountId: string): Promise<OpenPortal> => {
      const [module, url] = await Promise.all([
        import('./SnapTradePortal'),
        fetchSnapTradeLink(accountId, repairConnectionId),
      ])
      return { Portal: module.default, url }
    },
    onSuccess: (opened) => {
      if (openRef.current) setPortal(opened)
    },
    onError: (error: Error) => {
      if (openRef.current) backToChoice(failure(error.message))
    },
  })

  const sync = useMutation({
    mutationFn: (accountId: string) => syncSnapTrade(accountId),
    // Done only once the list is read again: the menu then has the new accounts.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ACCOUNTS_QUERY_KEY }),
  })

  const startOther = useRef<() => void>(() => {})
  startOther.current = () => {
    sync.reset()
    if (viewedAccountId === undefined) backToChoice(failure(NO_ACCOUNT_LIST_NOTICE))
    else openPortal.mutate(viewedAccountId)
  }
  useEffect(() => {
    if (!otherOpen) return
    // Held as a choice: a repair that succeeds clears `repairConnectionId`,
    // and the dialog must stay on its result rather than fall back to step one.
    setChosen('other')
    startOther.current()
  }, [otherOpen])

  // Closed, it forgets the choice: the next opening starts from the beginning.
  useEffect(() => {
    if (open) return
    setChosen(null)
    setNotice(null)
    setPortal(null)
  }, [open])

  // The portal is a modal of its own; this dialog steps aside while it shows.
  const dialogShown = open && portal === null
  useEffect(() => {
    const el = dialogRef.current
    if (!el) return
    if (dialogShown && !el.open) el.showModal()
    if (!dialogShown && el.open) el.close()
  }, [dialogShown])

  const firstChoiceRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (step === 'choose' && dialogShown) firstChoiceRef.current?.focus()
  }, [step, dialogShown])

  // This dialog always connects the user's direct Robinhood account, and the
  // status above describes whichever account is being viewed. While that is
  // another account, Robinhood's state is read from the account list instead.
  const robinhood = listAccounts(accounts.data).find((account) => account.adapter === 'robinhood')
  const viewingRobinhood =
    robinhood === undefined || robinhood.id === accounts.data?.selectedAccountId

  const data = status.data
  const pendingUrl = authUrl ?? data?.authUrl ?? null
  const connected = viewingRobinhood ? data?.connected === true : robinhood.connected
  const awaitingPaste = robinhoodOpen && !connected && pendingUrl !== null && !submit.isSuccess

  useEffect(() => {
    if (!connected || !robinhoodOpen) return
    // The account menu lists this connection too.
    void queryClient.invalidateQueries({ queryKey: ACCOUNTS_QUERY_KEY })
    const timer = setTimeout(() => onCloseRef.current(), SUCCESS_CLOSE_MS)
    return () => clearTimeout(timer)
  }, [connected, robinhoodOpen, queryClient])

  const clipboard = useClipboardCallback(awaitingPaste, (url) => {
    if (!submit.isPending) submit.mutate(url)
  })

  // Back is offered only where there was a choice to come from. It forgets
  // what this step had on screen. An authorization already started stays
  // pending at the trader, exactly as when the dialog is closed, and choosing
  // Robinhood again is handed that same link: the trader starts no second one.
  const canGoBack = robinhoodOpen && firstStep === 'choose'
  const backFromRobinhood = (): void => {
    connect.reset()
    submit.reset()
    setAuthUrl(null)
    setRedirectUrl('')
    backToChoice(null)
  }

  const title =
    step === 'other'
      ? OTHER_BROKER_TITLE
      : step === 'choose' || step === 'loading'
        ? CHOICE_TITLE
        : ROBINHOOD_TITLE
  const showsRobinhood = step === null || robinhoodOpen

  return (
    <>
    <dialog
      ref={dialogRef}
      aria-label={title}
      // Stepping aside for the portal closes the element, not the flow.
      onClose={() => {
        if (portal === null) onClose()
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-xl rounded-xl border border-warn/40 bg-ink-800 p-5 text-white backdrop:bg-black/60"
    >
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-sm font-medium text-white">
          {showsRobinhood && connected ? 'Connected' : title}
        </h2>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="rounded-md p-1 text-ink-400 transition-colors hover:bg-ink-700 hover:text-white"
        >
          <X className="size-4" />
        </button>
      </div>

      {step === 'loading' && (
        <p role="status" className="mt-3 text-xs text-ink-400">
          Loading your accounts…
        </p>
      )}

      {step === 'choose' && (
        <>
          <div role="group" aria-label="What to connect" className="mt-4 grid gap-3 sm:grid-cols-2">
            <button
              ref={firstChoiceRef}
              type="button"
              onClick={() => setChosen('robinhood')}
              className={choiceClass}
            >
              <span className="text-sm font-medium text-white">
                {robinhood?.connected ? 'Reconnect Robinhood' : 'Robinhood'}
              </span>
              <span className="text-xs text-ink-400">Sign in to your Robinhood account.</span>
            </button>
            <button type="button" onClick={() => setChosen('other')} className={choiceClass}>
              <span className="text-sm font-medium text-white">Other broker</span>
              <span className="text-xs text-ink-400">
                Pick your broker in the list (search for it if it is not shown) and sign in
                to it through SnapTrade. {NEW_ACCOUNT_NOTE}
              </span>
            </button>
          </div>
          {notice !== null && (
            <p
              role={notice.isError ? 'alert' : 'status'}
              className={`mt-3 text-xs ${notice.isError ? 'text-loss' : 'text-ink-400'}`}
            >
              {notice.message}
            </p>
          )}
        </>
      )}

      {otherOpen && (
        <div className="mt-4 flex flex-col gap-3">
          {openPortal.isPending && (
            <p role="status" className="text-xs text-ink-400">
              Opening the broker connection…
            </p>
          )}
          {sync.isPending && (
            <p role="status" className="text-xs text-ink-400">
              Broker connected. Adding its accounts…
            </p>
          )}
          {sync.isError && (
            <p role="alert" className="text-xs text-loss">
              The broker is connected, but its accounts could not be added:{' '}
              {(sync.error as Error).message}
            </p>
          )}
          {sync.isSuccess && (
            <p role="status" className="text-sm text-ink-400">
              {syncSummary(sync.data)}
            </p>
          )}
          {(sync.isError || sync.isSuccess) && (
            <div className="flex flex-wrap items-center gap-3">
              {(sync.isError || sync.data?.added === 0) && viewedAccountId !== undefined && (
                <button
                  type="button"
                  onClick={() => sync.mutate(viewedAccountId)}
                  className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-ink-900 transition-opacity hover:bg-brand/80"
                >
                  Sync again
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-ink-600 px-4 py-2 text-sm text-ink-400 transition-colors hover:text-white"
              >
                Done
              </button>
            </div>
          )}
        </div>
      )}

      {showsRobinhood && (connected ? (
        <p className="mt-3 text-sm text-ink-400">Robinhood is connected.</p>
      ) : (
        <div className="mt-4 flex flex-col gap-4">
          {/* A refused start (a read_only deployment: "Robinhood cannot be
              connected from this environment") has no approval step to warn about. */}
          {!connect.isError && <BeforeYouStart />}

          {connect.isPending && !pendingUrl && (
            <p className="text-xs text-ink-400">Starting…</p>
          )}

          {connect.isError && (
            <p className="text-xs text-loss">{(connect.error as Error).message}</p>
          )}

          {pendingUrl && (
            <div className="flex flex-col gap-3">
              <a
                href={pendingUrl}
                target="_blank"
                rel="noopener"
                onClick={(e) => {
                  e.preventDefault()
                  window.open(pendingUrl, '_blank', 'noopener')
                }}
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
                  className="w-full max-w-xl rounded-lg border border-ink-600 bg-ink-900 px-3 py-2 text-sm text-white placeholder:text-ink-400 focus:border-brand focus:outline-none"
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

          {canGoBack && (
            <button
              type="button"
              onClick={backFromRobinhood}
              className="w-fit rounded-lg border border-ink-600 px-4 py-2 text-sm text-ink-400 transition-colors hover:text-white"
            >
              Back
            </button>
          )}
        </div>
      ))}
    </dialog>

    {open && portal !== null && (
      <portal.Portal
        loginLink={portal.url}
        onSuccess={() => {
          setPortal(null)
          if (viewedAccountId !== undefined) sync.mutate(viewedAccountId)
        }}
        onError={(detail) => backToChoice(failure(`${PORTAL_FAILED_NOTICE} ${detail}`))}
        onExit={() => backToChoice({ message: PORTAL_CLOSED_NOTICE, isError: false })}
      />
    )}
    </>
  )
}

const NEW_ACCOUNT_NOTE =
  'A new account starts in approval mode, with the settings of the account you are viewing.'

const choiceClass =
  'flex flex-col gap-1 rounded-lg border border-ink-600 bg-ink-900 px-4 py-3 text-left transition-colors hover:border-brand focus-visible:border-brand focus-visible:outline-none'

/** What a sync did, in the dialog's words. Never "added" when nothing was. */
function syncSummary(result: SnapTradeSyncResult): string {
  if (result.added > 0) {
    return `Added ${result.added} ${result.added === 1 ? 'account' : 'accounts'}, now in the account menu. ${NEW_ACCOUNT_NOTE}`
  }
  if (result.connectionsAwaitingAccounts > 0) {
    return 'The broker is connected, but SnapTrade does not list its accounts yet. That can take a few minutes: sync again shortly.'
  }
  if (result.updated > 0) {
    return 'No new account was found. The accounts already here are up to date.'
  }
  return 'No account that can place trades was found at SnapTrade.'
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
