/**
 * Sign in, shown in place of the dashboard when there is no session.
 *
 * Passwordless: the user asks for a one-time sign-in link by email. The
 * request goes to the trader rather than to Supabase directly, because the
 * invite allowlist lives server-side — an address that was never invited gets
 * a 403 and no email, and there is no self-serve signup path at all.
 */
import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'

import { requestMagicLink } from '../lib/api'

export function AuthScreen() {
  const [email, setEmail] = useState('')

  const submit = useMutation({
    mutationFn: () => requestMagicLink(email),
  })

  const canSubmit = email.trim().length > 0 && !submit.isPending

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

        {submit.isSuccess ? (
          <>
            <h1 className="text-2xl font-semibold text-white">Check your email</h1>
            <p className="mt-2 text-sm text-ink-400">
              We sent a sign-in link to <span className="text-white">{email}</span>.
              Open it on this device to land on the dashboard.
            </p>
            <button
              type="button"
              onClick={() => submit.reset()}
              className="mt-6 text-sm text-brand hover:underline"
            >
              Use a different email
            </button>
          </>
        ) : (
          <>
            <h1 className="text-2xl font-semibold text-white">Sign in</h1>
            <p className="mt-2 text-sm text-ink-400">
              This dashboard is invite-only. Enter your invited email and we&apos;ll
              send you a sign-in link.
            </p>

            <form
              className="mt-6 flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault()
                if (canSubmit) submit.mutate()
              }}
            >
              <label className="flex flex-col gap-1.5 text-xs text-ink-400">
                Email
                <input
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={inputClass}
                  required
                />
              </label>

              <button
                type="submit"
                disabled={!canSubmit}
                className="mt-2 rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-ink-900 transition-opacity hover:bg-brand/80 disabled:opacity-50"
              >
                {submit.isPending ? 'Sending…' : 'Email me a sign-in link'}
              </button>

              {submit.isError && (
                <p className="text-sm text-loss">{(submit.error as Error).message}</p>
              )}
            </form>
          </>
        )}
      </div>
    </main>
  )
}

const inputClass =
  'w-full rounded-lg border border-ink-600 bg-ink-700 px-3 py-2 text-sm text-white transition-colors focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25'
