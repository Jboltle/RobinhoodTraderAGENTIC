import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { SnapTradeReact } from 'snaptrade-react'

const PORTAL_Z_INDEX = 1000
const BACKDROP_COLOR = 'rgba(0, 0, 0, 0.6)'
/** The iframe snaptrade-react renders, and the antd panel it sits in. */
const PORTAL_FRAME_ID = 'snaptrade-react-connection-portal'
const PANEL_SELECTOR = '.ant-modal-content'

interface SnapTradePortalProps {
  /** A Connection Portal link issued a moment ago (it expires in five minutes). */
  loginLink: string
  /** The broker was connected. */
  onSuccess: () => void
  /** The portal reported a failure, in its own words. */
  onError: (detail: string) => void
  /**
   * The portal was closed without connecting: by the Close button here, by
   * Escape, or by SnapTrade's page (its own "x", or an abandoned sign-in tab).
   * May be called twice for one close.
   */
  onExit: () => void
}

/**
 * A place at the top of the modal's panel for this app's own control.
 *
 * ponytail: snaptrade-react takes no header and no children, so the place is
 * made in antd's DOM, found through the iframe's id and antd's panel class.
 * Both packages are pinned and SnapTradePortal.test.tsx renders the real
 * modal, so an upgrade that moves either fails there. Upgrade path: a header
 * prop on SnapTradeReact, or our own dialog around its useWindowMessage hook.
 */
function usePanelTop(): HTMLElement | null {
  const [top, setTop] = useState<HTMLElement | null>(null)

  useEffect(() => {
    const host = document.createElement('div')
    const place = (): boolean => {
      const panel = document.getElementById(PORTAL_FRAME_ID)?.closest(PANEL_SELECTOR)
      if (!panel) return false
      // First in the panel, so Tab reaches it before the portal's iframe.
      panel.prepend(host)
      setTop(host)
      return true
    }
    // antd mounts its modal a render after this component.
    const observer = new MutationObserver(() => {
      if (place()) observer.disconnect()
    })
    if (!place()) observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      host.remove()
    }
  }, [])

  return top
}

/**
 * SnapTrade's Connection Portal in the snaptrade-react modal.
 *
 * Loaded on demand (ConnectDialog imports it lazily): snaptrade-react brings
 * antd, which nobody who never opens the portal should download.
 *
 * The modal has no close control of its own outside the portal page, so one
 * is added on its panel: the way out when the page inside never loads.
 * Escape closes it too while the keyboard is in this page; inside the
 * portal's iframe the keys are SnapTrade's.
 */
export default function SnapTradePortal({
  loginLink,
  onSuccess,
  onError,
  onExit,
}: SnapTradePortalProps) {
  const panelTop = usePanelTop()

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onExit()
    }
    // Capturing: antd's modal stops Escape from bubbling out of it, and
    // snaptrade-react gives it nothing to call.
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [onExit])

  return (
    <>
      <SnapTradeReact
        loginLink={loginLink}
        isOpen
        // SnapTrade's own "x" posts CLOSE_MODAL, which calls both of these.
        close={onExit}
        onExit={onExit}
        onSuccess={() => onSuccess()}
        onError={(error) => onError(error.detail)}
        contentLabel="Connect your broker"
        style={{ overlay: { backgroundColor: BACKDROP_COLOR, zIndex: PORTAL_Z_INDEX } }}
      />
      {panelTop !== null &&
        createPortal(
          <div className="mb-3 flex justify-end">
            <button
              type="button"
              aria-label="Close broker connection"
              onClick={onExit}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-md bg-ink-800 px-3 py-2 text-sm font-medium text-white ring-1 ring-ink-600 transition-colors hover:bg-ink-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
            >
              <X className="size-4" aria-hidden="true" />
              Close
            </button>
          </div>,
          panelTop,
        )}
    </>
  )
}
