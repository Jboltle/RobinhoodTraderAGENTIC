/**
 * Sign in / sign up, shown in place of the dashboard when there is no session.
 *
 * Signing up posts to the trader rather than to Supabase directly: the invite
 * allowlist lives server-side, so the browser has no way to create an account
 * for an address that was never invited.
 */
import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'

import { signUp } from '../lib/api'
import { signIn } from '../lib/auth'

const MIN_PASSWORD_LENGTH = 8

type Mode = 'signin' | 'signup'

export function AuthScreen() {
  const [mode, setMode] = useState<Mode>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  const submit = useMutation({
    mutationFn: async () => {
      if (mode === 'signin') return signIn(email, password)
      await signUp(email, password)
      // Sign the new account straight in so they land on the dashboard.
      return signIn(email, password)
    },
  })

  const canSubmit =
    email.trim().length > 0 && password.length >= MIN_PASSWORD_LENGTH && !submit.isPending

  const switchMode = (next: Mode) => {
    setMode(next)
    submit.reset()
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-ink-900 px-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-2.5">
          <span className="flex size-7 items-center justify-center rounded-full bg-brand/25">
            <span className="size-3 rounded-full bg-brand" />
          </span>
          <span className="text-sm font-semibold tracking-widest text-white">
            RH TRADER
          </span>
        </div>

        <h1 className="text-2xl font-semibold text-white">
          {mode === 'signin' ? 'Sign in' : 'Create your account'}
        </h1>
        <p className="mt-2 text-sm text-ink-400">
          {mode === 'signin'
            ? 'This dashboard is invite-only.'
            : 'Your email must already be on the invite list.'}
        </p>

        <form
          className="mt-6 flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (canSubmit) submit.mutate()
          }}
        >
          <Field label="Email">
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputClass}
              required
            />
          </Field>
          <Field label={`Password (min ${MIN_PASSWORD_LENGTH} characters)`}>
            <input
              type="password"
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputClass}
              minLength={MIN_PASSWORD_LENGTH}
              required
            />
          </Field>

          <button
            type="submit"
            disabled={!canSubmit}
            className="mt-2 rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-ink-900 transition-opacity hover:bg-brand/80 disabled:opacity-50"
          >
            {submit.isPending
              ? 'Working…'
              : mode === 'signin'
                ? 'Sign in'
                : 'Create account'}
          </button>

          {submit.isError && (
            <p className="text-sm text-loss">{(submit.error as Error).message}</p>
          )}
        </form>

        <p className="mt-6 text-sm text-ink-400">
          {mode === 'signin' ? (
            <>
              Invited but no account yet?{' '}
              <button
                type="button"
                onClick={() => switchMode('signup')}
                className="text-brand hover:underline"
              >
                Create one
              </button>
            </>
          ) : (
            <>
              Already have an account?{' '}
              <button
                type="button"
                onClick={() => switchMode('signin')}
                className="text-brand hover:underline"
              >
                Sign in
              </button>
            </>
          )}
        </p>
      </div>
    </main>
  )
}

const inputClass =
  'w-full rounded-lg border border-ink-600 bg-ink-700 px-3 py-2 text-sm text-white transition-colors focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25'

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label className="flex flex-col gap-1.5 text-xs text-ink-400">
      {label}
      {children}
    </label>
  )
}
