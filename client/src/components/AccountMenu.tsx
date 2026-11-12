import { useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, LogOut, Plug, Settings } from 'lucide-react'

import {
  ACCOUNTS_QUERY_KEY,
  accountState,
  institutionName,
  listAccounts,
  useAccounts,
} from '../lib/accounts'
import type { ListedAccount } from '../lib/accounts'
import { selectAccount } from '../lib/api'
import type { AccountsResponse } from '../lib/api'
import { signOut, useAuth } from '../lib/auth'
import { ConnectDialog } from './ConnectDialog'

const MENU_ID = 'account-menu'
const ITEM_SELECTOR = '[role^="menuitem"]'
const VIEWED_ITEM_SELECTOR = '[role="menuitemradio"][aria-checked="true"]'

const itemClass =
  'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-ink-400 transition-colors hover:bg-ink-700/60 hover:text-white focus-visible:bg-ink-700 focus-visible:text-white'

/** PAPER or LIVE, wherever an account is named. */
export function AccountBadge({ isPaper }: { isPaper: boolean }) {
  return (
    <span
      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide ${
        isPaper ? 'bg-ink-700 text-ink-400' : 'bg-gain/10 text-gain'
      }`}
    >
      {isPaper ? 'PAPER' : 'LIVE'}
    </span>
  )
}

/**
 * The profile circle in the header and the menu under it: the user's
 * accounts, then Connect account, Settings and Sign out.
 *
 * Choosing an account changes what every screen and Settings show and edit.
 * It never changes which accounts trade: each connected account keeps taking
 * its callouts under its own settings, viewed or not.
 *
 * The menu is a native popover, so the browser handles Escape, a click
 * outside, and returning focus to the button. What is added here is the menu
 * keyboard pattern: focus moves into the menu when it opens, the arrow keys,
 * Home and End move between items, and Tab closes it.
 */
export function AccountMenu() {
  const { email } = useAuth()
  const queryClient = useQueryClient()
  const accounts = useAccounts()
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [connectOpen, setConnectOpen] = useState(false)

  // The list changing its selected id is what makes the rest of the app let
  // go of the previous account (useResetOnAccountSwitch, in the root route).
  const switchAccount = useMutation({
    mutationFn: selectAccount,
    onSuccess: (selectedAccountId) => {
      queryClient.setQueryData<AccountsResponse>(
        ACCOUNTS_QUERY_KEY,
        (current) => current && { ...current, selectedAccountId },
      )
    },
  })

  const list = listAccounts(accounts.data)
  const viewedAccountId = accounts.data?.selectedAccountId
  const viewed = list.find((account) => account.id === viewedAccountId)

  const closeMenu = (): void => menuRef.current?.hidePopover()

  const choose = (accountId: string): void => {
    if (switchAccount.isPending) return
    if (accountId === viewedAccountId) {
      closeMenu()
      return
    }
    switchAccount.mutate(accountId, { onSuccess: closeMenu })
  }

  const onToggle = (event: React.ToggleEvent<HTMLDivElement>): void => {
    const opened = event.newState === 'open'
    setMenuOpen(opened)
    if (!opened) return
    switchAccount.reset()
    const menu = event.currentTarget
    const first =
      menu.querySelector<HTMLElement>(VIEWED_ITEM_SELECTOR) ??
      menu.querySelector<HTMLElement>(ITEM_SELECTOR)
    first?.focus()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    // Closing hands focus back to the button, and Tab carries on from there.
    if (event.key === 'Tab') {
      closeMenu()
      return
    }
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(ITEM_SELECTOR))
    const current = items.indexOf(document.activeElement as HTMLElement)
    const last = items.length - 1
    const destinations: Partial<Record<string, number>> = {
      ArrowDown: current === last ? 0 : current + 1,
      ArrowUp: current <= 0 ? last : current - 1,
      Home: 0,
      End: last,
    }
    const destination = destinations[event.key]
    if (destination === undefined) return
    event.preventDefault()
    items[destination]?.focus()
  }

  return (
    <>
      <button
        type="button"
        popoverTarget={MENU_ID}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls={MENU_ID}
        aria-label={viewed ? `Account menu, viewing ${viewed.label}` : 'Account menu'}
        className="account-menu-button flex size-9 shrink-0 items-center justify-center rounded-full bg-brand/15 text-sm font-semibold text-brand uppercase transition-colors hover:bg-brand/25"
      >
        <span aria-hidden="true">{email?.charAt(0) ?? '?'}</span>
      </button>

      {/* No display utility on the popover itself: it would override the
          browser's rule that keeps a closed popover hidden. */}
      <div
        id={MENU_ID}
        ref={menuRef}
        popover="auto"
        role="menu"
        aria-label={email ? `Account menu for ${email}` : 'Account menu'}
        onToggle={onToggle}
        onKeyDown={onKeyDown}
        className="account-menu w-72 rounded-xl border border-ink-600 bg-ink-800 p-1.5 text-white shadow-xl shadow-black/60"
      >
        <div role="none" className="truncate px-3 pt-2 pb-1.5 text-xs text-ink-400">
          {email}
        </div>

        <div role="group" aria-label="Accounts">
          {list.map((account) => (
            <AccountItem
              key={account.id}
              account={account}
              viewed={account.id === viewedAccountId}
              busy={switchAccount.isPending}
              onChoose={() => choose(account.id)}
            />
          ))}
        </div>
        {accounts.isPending && (
          <div role="none" className="px-3 py-2 text-xs text-ink-400">
            Loading accounts…
          </div>
        )}
        {accounts.isError && (
          <div role="none" className="px-3 py-2 text-xs text-loss">
            Accounts unavailable ({(accounts.error as Error).message})
          </div>
        )}
        {switchAccount.isError && (
          <div role="alert" className="px-3 py-2 text-xs text-loss">
            Could not switch accounts: {(switchAccount.error as Error).message}
          </div>
        )}

        <div role="separator" className="my-1.5 border-t border-ink-600" />

        <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          className={itemClass}
          onClick={() => {
            closeMenu()
            setConnectOpen(true)
          }}
        >
          <Plug className="size-4 shrink-0" aria-hidden="true" />
          Connect account
        </button>
        <Link
          to="/settings"
          role="menuitem"
          tabIndex={-1}
          className={itemClass}
          onClick={closeMenu}
        >
          <Settings className="size-4 shrink-0" aria-hidden="true" />
          Settings
        </Link>
        <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          className={itemClass}
          onClick={() => void signOut()}
        >
          <LogOut className="size-4 shrink-0" aria-hidden="true" />
          Sign out
        </button>
      </div>

      {/* Not forced: opened from here it never tears down a healthy session.
          Settings' Reconnect is the forced one. */}
      <ConnectDialog open={connectOpen} force={false} onClose={() => setConnectOpen(false)} />
    </>
  )
}

function AccountItem({
  account,
  viewed,
  busy,
  onChoose,
}: {
  account: ListedAccount
  viewed: boolean
  busy: boolean
  onChoose: () => void
}) {
  const needsAttention = account.needsReconnect || !account.connected
  return (
    // aria-disabled rather than disabled: a disabled button drops focus, and
    // with it the arrow keys, while a switch is in flight.
    <button
      type="button"
      role="menuitemradio"
      aria-checked={viewed}
      aria-disabled={busy}
      tabIndex={-1}
      className={itemClass}
      onClick={onChoose}
    >
      <Check
        className={`size-4 shrink-0 text-brand ${viewed ? '' : 'invisible'}`}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate font-medium text-white">{account.label}</span>
          <AccountBadge isPaper={account.isPaper} />
        </span>
        <span className="block truncate text-xs">
          {institutionName(account.institution)} ·{' '}
          <span className={needsAttention ? 'text-warn' : undefined}>{accountState(account)}</span>
        </span>
      </span>
    </button>
  )
}
