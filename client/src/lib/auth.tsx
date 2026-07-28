/**
 * Session state for the dashboard.
 *
 * Supabase persists the session in localStorage and refreshes it in the
 * background; this exposes the current one to React and, more importantly,
 * hands the live access token to the API layer (api.ts) so every request the
 * app makes is signed with whatever token is valid right now rather than one
 * captured at mount.
 */
import { createContext, useContext, useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'

import { setAccessTokenSource } from './api'
import { supabase } from './supabase'

export interface AuthState {
  readonly session: Session | null
  /** True until Supabase has restored (or ruled out) a stored session. */
  readonly isLoading: boolean
  readonly email: string | null
}

const AuthContext = createContext<AuthState>({
  session: null,
  isLoading: true,
  email: null,
})

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    let current: Session | null = null
    setAccessTokenSource(() => current?.access_token ?? null)

    void supabase.auth.getSession().then(({ data }) => {
      current = data.session
      setSession(data.session)
      setIsLoading(false)
    })

    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      current = next
      setSession(next)
      setIsLoading(false)
    })
    return () => data.subscription.unsubscribe()
  }, [])

  return (
    <AuthContext.Provider
      value={{ session, isLoading, email: session?.user.email ?? null }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = (): AuthState => useContext(AuthContext)

export const signOut = async (): Promise<void> => {
  await supabase.auth.signOut()
}
