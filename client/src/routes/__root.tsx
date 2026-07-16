import {
  HeadContent,
  Link,
  Scripts,
  createRootRouteWithContext,
} from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'
import { LayoutDashboard, Search, Settings } from 'lucide-react'

import TanStackQueryDevtools from '../integrations/tanstack-query/devtools'

import { useTraderStream } from '../lib/stream'

import appCss from '../styles.css?url'

import type { QueryClient } from '@tanstack/react-query'
import type { PerformanceRow } from '../lib/api'

interface MyRouterContext {
  queryClient: QueryClient
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
      },
      {
        title: 'RH Trader',
      },
    ],
    links: [
      {
        rel: 'stylesheet',
        href: appCss,
      },
      { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
      {
        rel: 'preconnect',
        href: 'https://fonts.gstatic.com',
        crossOrigin: 'anonymous',
      },
      {
        rel: 'stylesheet',
        href: 'https://fonts.googleapis.com/css2?family=Golos+Text:wght@400;500;600&display=swap',
      },
    ],
  }),
  shellComponent: RootDocument,
})

const navLinkClass =
  'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-ink-400 transition-colors hover:bg-ink-700/60 hover:text-white [&.active]:bg-brand/8 [&.active]:text-brand'

function RootDocument({ children }: { children: React.ReactNode }) {
  useTraderStream()
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen bg-ink-900 font-sans text-white antialiased">
        <div className="flex min-h-screen">
          <SideNav />
          <div className="flex min-w-0 flex-1 flex-col">
            <TopHeader />
            <main className="mx-auto w-full max-w-6xl flex-1 px-8 py-6">
              {children}
            </main>
          </div>
        </div>
        <TanStackDevtools
          config={{
            position: 'bottom-right',
          }}
          plugins={[
            {
              name: 'Tanstack Router',
              render: <TanStackRouterDevtoolsPanel />,
            },
            TanStackQueryDevtools,
          ]}
        />
        <Scripts />
      </body>
    </html>
  )
}

function SideNav() {
  return (
    <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col border-r border-ink-600 bg-ink-900 px-4 py-5 max-md:hidden">
      <div className="mb-8 flex items-center gap-2.5 px-2">
        <span className="flex size-7 items-center justify-center rounded-full bg-brand/25">
          <span className="size-3 rounded-full bg-brand" />
        </span>
        <span className="text-sm font-semibold tracking-widest">RH TRADER</span>
      </div>

      <nav className="flex flex-col gap-1">
        <Link to="/" className={navLinkClass}>
          <LayoutDashboard className="size-4" />
          Dashboard
        </Link>
        <Link to="/settings" className={navLinkClass}>
          <Settings className="size-4" />
          Settings
        </Link>
      </nav>

      <div className="mt-auto">
        <AccountSummaryCard />
      </div>
    </aside>
  )
}

function AccountSummaryCard() {
  // No queryFn: the cache is hydrated and kept live by the SSE stream
  // (lib/stream.ts), same as the dashboard route.
  const performance = useQuery<PerformanceRow[]>({
    queryKey: ['performance'],
    enabled: false,
  })
  const positions = performance.data ?? []
  // ponytail: "portfolio balance" approximated as market value of tracked
  // positions (options x100). Upgrade path: a real account-balance endpoint.
  const balance = positions.reduce((sum, p) => {
    if (p.currentPrice === null) return sum
    const multiplier = p.assetType === 'option' ? 100 : 1
    return sum + p.currentPrice * p.quantity * multiplier
  }, 0)

  return (
    <div className="rounded-xl border border-ink-600 bg-ink-800 p-4">
      <p className="text-xs text-ink-400">Portfolio Balance</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">
        {performance.isSuccess
          ? balance.toLocaleString('en-US', {
              style: 'currency',
              currency: 'USD',
            })
          : '—'}
      </p>
      <p className="mt-3 text-xs text-ink-400">Open Positions</p>
      <p className="mt-0.5 text-sm font-medium tabular-nums">
        {performance.isSuccess ? positions.length : '—'}
      </p>
    </div>
  )
}

function TopHeader() {
  return (
    <header className="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-ink-600 bg-ink-900 px-8">
      <span className="text-sm font-medium text-ink-400 md:hidden">
        RH TRADER
      </span>
      <nav className="flex gap-1 md:hidden">
        <Link to="/" className={navLinkClass}>
          Dashboard
        </Link>
        <Link to="/settings" className={navLinkClass}>
          Settings
        </Link>
      </nav>
      <label className="ml-auto flex w-64 items-center gap-2 rounded-lg border border-ink-600 bg-ink-700 px-3 py-2 focus-within:border-brand max-sm:w-40">
        <Search className="size-4 shrink-0 text-ink-400" />
        <input
          type="search"
          placeholder="Search"
          className="w-full bg-transparent text-sm text-white placeholder:text-ink-400 focus:outline-none"
        />
      </label>
    </header>
  )
}
