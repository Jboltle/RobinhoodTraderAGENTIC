/**
 * Session state for the dashboard.
 *
 * The session is the bearer token POST /api/auth/login returned, kept in
 * localStorage so a reload stays signed in. The API layer (api.ts) reads the
 * live token on every request, and any 401 signs this browser out: it means
 * the server ended the session (sign-out elsewhere, password reset, expiry).
 */
import { useSyncExternalStore } from 'react'

import {
  login,
  logout,
  setAccessTokenSource,
  setUnauthorizedHandler,
  type Session,
} from './api'

const STORAGE_KEY = 'rh-trader-session'

export interface AuthState {
  readonly session: Session | null
  /** True until the browser has read its stored session (always, in the prerendered shell). */
  readonly isLoading: boolean
  readonly email: string | null
}

let current: Session | null = readStoredSession()
const listeners = new Set<() => void>()

setAccessTokenSource(() => current?.token ?? null)
setUnauthorizedHandler(() => setSession(null))

function readStoredSession(): Session | null {
  if (typeof window === 'undefined') return null
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null') as Session | null
    return stored?.token && stored.email ? stored : null
  } catch {
    return null
  }
}

function setSession(next: Session | null): void {
  current = next
  if (next) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  else window.localStorage.removeItem(STORAGE_KEY)
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useAuth(): AuthState {
  // undefined = still the prerendered shell, before the browser has looked.
  const session = useSyncExternalStore(subscribe, () => current, () => undefined)
  return {
    session: session ?? null,
    isLoading: session === undefined,
    email: session?.email ?? null,
  }
}

export async function signIn(email: string): Promise<void> {
  setSession(await login(email))
}

export async function signOut(): Promise<void> {
  // Ending the server-side session is best effort; this browser forgets it regardless.
  await logout().catch(() => {})
  setSession(null)
}
