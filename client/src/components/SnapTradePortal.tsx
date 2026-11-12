import { useEffect } from 'react'
import { SnapTradeReact } from 'snaptrade-react'

/** antd's own modal layer; the Close button below sits one above it. */
const PORTAL_Z_INDEX = 1000
const BACKDROP_COLOR = 'rgba(0, 0, 0, 0.6)'

interface SnapTradePortalProps {
  /** A Connection Portal link issued a moment ago (it expires in five minutes). */
  loginLink: string
  /** The broker was connected. */
  onSuccess: () => void
  /** The portal reported a failure, in its own words. */
  onError: (detail: string) => void
  /** The portal was closed without connecting. */
  onExit: () => void
}

/**
 * SnapTrade's Connection Portal in the snaptrade-react modal.
 *
 * Loaded on demand (ConnectDialog imports it lazily): snaptrade-react brings
 * antd, which nobody who never opens the portal should download.
 *
 * The modal has no close control of its own outside the portal page, so one
 * is added here, with Escape: the way out when the page inside never loads.
 */
export default function SnapTradePortal({
  loginLink,
  onSuccess,
  onError,
  onExit,
}: SnapTradePortalProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onExit()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onExit])

  return (
    <>
      <SnapTradeReact
        loginLink={loginLink}
        isOpen
        close={onExit}
        onExit={onExit}
        onSuccess={() => onSuccess()}
        onError={(error) => onError(error.detail)}
        contentLabel="Connect your broker"
        style={{ overlay: { backgroundColor: BACKDROP_COLOR, zIndex: PORTAL_Z_INDEX } }}
      />
      <button
        type="button"
        onClick={onExit}
        style={{ zIndex: PORTAL_Z_INDEX + 1 }}
        className="fixed right-4 top-4 rounded-md bg-ink-800 px-3 py-1.5 text-xs font-medium text-white ring-1 ring-ink-600 transition-colors hover:bg-ink-700"
      >
        Close broker connection
      </button>
    </>
  )
}
