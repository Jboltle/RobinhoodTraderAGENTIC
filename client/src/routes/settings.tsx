import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check } from 'lucide-react'

import {
  disconnectBroker,
  fetchBrokerStatus,
  fetchCallers,
  fetchPortfolio,
  fetchSettings,
  type BrokerStatus,
  type Caller,
  type TradeSettings,
  type TradeSettingsInput,
} from '../lib/api'
import { ConnectDialog } from '../components/ConnectDialog'
import { discordDefaultAvatarUrl, toggleCaller } from '../lib/following'
import { saveSettings } from '../lib/settingsSync'

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
  ssr: false,
})

function SettingsPage() {
  // The form initializes from this user's saved settings; saving needs the
  // trader anyway, so an unreachable trader is a hard error here.
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: fetchSettings,
  })

  if (settings.isPending) {
    return (
      <div className="rounded-xl border border-ink-600 bg-ink-800 px-4 py-6 text-center text-sm text-ink-400">
        Loading settings…
      </div>
    )
  }
  if (settings.isError) {
    return (
      <div className="rounded-xl border border-ink-600 bg-ink-800 px-4 py-6 text-center text-sm text-loss">
        Failed to load settings: {(settings.error as Error).message}
      </div>
    )
  }
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <BrokerSection />
      <SettingsForm initial={settings.data} defaults={settings.data} />
    </div>
  )
}

// =============================================================================
// Robinhood connection
// =============================================================================

/**
 * Connection status plus the manual recovery actions. Reconnect always forces
 * a fresh session server-side, so it also unwedges a connection the status
 * still calls healthy: saved authorization is retried first, and the
 * authorize-and-paste dialog only appears when Robinhood no longer accepts it.
 */
function BrokerSection() {
  const queryClient = useQueryClient()
  // Kept fresh by ConnectBanner's poll (mounted on every page); this query
  // just subscribes to the same cache entry.
  const status = useQuery<BrokerStatus>({
    queryKey: ['broker-status'],
    queryFn: fetchBrokerStatus,
    retry: false,
  })
  const [dialogOpen, setDialogOpen] = useState(false)

  const disconnect = useMutation({
    mutationFn: disconnectBroker,
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ['broker-status'] }),
  })

  const connected = status.data?.connected === true

  return (
    <FormSection title="Robinhood connection">
      <div className="flex items-center gap-2.5">
        <span
          className={`size-2 rounded-full ${connected ? 'bg-gain' : 'animate-pulse bg-warn'}`}
        />
        <span className="text-sm font-medium text-white">
          {status.isPending
            ? 'Checking…'
            : connected
              ? 'Connected'
              : 'Not connected'}
        </span>
      </div>

      <p className="-mt-1 text-xs leading-relaxed text-ink-400">
        Trading and live account data stop when this connection breaks.
        Reconnect retries with your saved authorization and only asks you to
        authorize again when Robinhood no longer accepts it.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-ink-900 transition-colors hover:bg-brand/80"
        >
          {connected ? 'Reconnect' : 'Connect'}
        </button>
        {connected && (
          <button
            type="button"
            disabled={disconnect.isPending}
            onClick={() => {
              if (
                window.confirm(
                  'Disconnect Robinhood? Trading stops until you connect again.',
                )
              )
                disconnect.mutate()
            }}
            className="rounded-lg border border-ink-600 px-4 py-2 text-sm text-ink-400 transition-colors hover:border-loss/40 hover:text-loss disabled:opacity-50"
          >
            {disconnect.isPending ? 'Disconnecting…' : 'Disconnect'}
          </button>
        )}
        {disconnect.isError && (
          <span className="text-xs text-loss">
            {(disconnect.error as Error).message}
          </span>
        )}
      </div>

      <ConnectDialog
        open={dialogOpen}
        force
        onClose={() => setDialogOpen(false)}
      />
    </FormSection>
  )
}

function SettingsForm({
  initial,
  defaults,
}: {
  initial: TradeSettingsInput
  defaults: TradeSettings | undefined
}) {
  const [form, setForm] = useState<TradeSettingsInput>(initial)
  const queryClient = useQueryClient()

  const mutation = useMutation({
    mutationFn: saveSettings,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['settings'] }),
  })

  const set = <K extends keyof TradeSettingsInput>(
    key: K,
    value: TradeSettingsInput[K],
  ) => setForm((f) => ({ ...f, [key]: value }))

  // Placeholder showing the value currently in effect for this account.
  const ph = (key: keyof TradeSettings): string =>
    defaults === undefined
      ? 'default (trader offline)'
      : `current: ${Array.isArray(defaults[key]) ? (defaults[key] as string[]).join(',') : String(defaults[key])}`

  return (
    <form
      className="flex max-w-2xl flex-col gap-6"
      onSubmit={(e) => {
        e.preventDefault()
        // JSON.stringify drops undefined fields, so only explicitly set
        // values reach the session state; the rest fall through to defaults.
        mutation.mutate(form)
      }}
    >
      <header>
        <h1 className="text-2xl font-semibold text-white">Trade Settings</h1>
        <p className="mt-2 text-sm text-ink-400">
          These apply to your account only, and to every callout from the next
          one onwards. Blank fields fall back to the built-in default.
        </p>
      </header>

      <CallersSection
        followed={form.followedCallerIds ?? null}
        onChange={(v) => set('followedCallerIds', v)}
      />

      <FormSection title="Execution">
        <SelectField
          label="Execution mode"
          value={form.executionMode}
          options={['immediate', 'approval']}
          placeholder={ph('executionMode')}
          onChange={(v) => set('executionMode', v)}
        />
      </FormSection>

      <FormSection title="Position sizing">
        <p className="-mt-2 text-xs leading-relaxed text-ink-400">
          Each number below is a slice of your buying power. A stock callout
          that says <em>medium size</em> deploys{' '}
          {Math.min(form.equityMediumPct ?? 0, form.equityFullPct ?? 0)}% of it.
          A callout with no size word uses Medium for stock and Small for
          options. Full is the ceiling nothing gets past: a callout asking for
          $5,000 is trimmed to it, and so is a Small or Medium you set above it.
        </p>

        <SizingPreview form={form} />

        <SizingRow
          asset="Stock"
          small={form.equitySmallPct}
          medium={form.equityMediumPct}
          full={form.equityFullPct}
          onSmall={(v) => set('equitySmallPct', v)}
          onMedium={(v) => set('equityMediumPct', v)}
          onFull={(v) => set('equityFullPct', v)}
        />
        <SizingRow
          asset="Options"
          small={form.optionsSmallPct}
          medium={form.optionsMediumPct}
          full={form.optionsFullPct}
          onSmall={(v) => set('optionsSmallPct', v)}
          onMedium={(v) => set('optionsMediumPct', v)}
          onFull={(v) => set('optionsFullPct', v)}
        />
        <NumberField label="Skip an options trade if one contract alone costs more than (% of buying power)" value={form.maxSingleContractPct} onChange={(v) => set('maxSingleContractPct', v)} placeholder={ph('maxSingleContractPct')} min={0} max={100} step={0.5} />
      </FormSection>

      <FormSection title="Limits & cooldowns">
        <NumberField label="Max trades per day" value={form.maxTradesPerDay} onChange={(v) => set('maxTradesPerDay', v)} placeholder={ph('maxTradesPerDay')} min={0} step={1} />
        <NumberField label="Per-ticker cooldown (seconds)" value={form.cooldownSeconds} onChange={(v) => set('cooldownSeconds', v)} placeholder={ph('cooldownSeconds')} min={0} step={1} />
      </FormSection>

      <FormSection title="Max loss">
        <p className="-mt-2 text-xs leading-relaxed text-ink-400">
          Closes that one open position when either limit is hit — a losing
          NVDA call does not touch anything else. Stock loss is{' '}
          <em>(entry − mark) × shares</em>. Options loss is{' '}
          <em>(entry − mark) × 100 × contracts</em>. Blank is off.
        </p>
        <NumberField
          label="Max loss (%)"
          value={form.maxLossPct ?? undefined}
          onChange={(v) => set('maxLossPct', v === 0 ? null : v ?? null)}
          placeholder={defaults?.maxLossPct == null ? 'off' : ph('maxLossPct')}
          min={0}
          max={100}
          step={1}
        />
        <NumberField
          label="Max loss ($)"
          value={form.maxLossUsd ?? undefined}
          onChange={(v) => set('maxLossUsd', v === 0 ? null : v ?? null)}
          placeholder={defaults?.maxLossUsd == null ? 'off' : ph('maxLossUsd')}
          min={0}
          step={1}
        />
      </FormSection>

      <FormSection title="Tickers">
        <TickerListField label="Allowed tickers (comma-separated, * = any)" value={form.allowedTickers} onChange={(v) => set('allowedTickers', v)} placeholder={ph('allowedTickers')} />
        <TickerListField label="Blocked tickers (comma-separated)" value={form.blockedTickers} onChange={(v) => set('blockedTickers', v)} placeholder={ph('blockedTickers')} />
      </FormSection>

      <FormSection title="Filters">
        <NumberField label="Min parser confidence (0-1)" value={form.minConfidence} onChange={(v) => set('minConfidence', v)} placeholder={ph('minConfidence')} min={0} max={1} step={0.05} />
        <SelectField
          label="Regular market hours only"
          value={form.regularHoursOnly === undefined ? undefined : String(form.regularHoursOnly)}
          options={['true', 'false']}
          placeholder={ph('regularHoursOnly')}
          onChange={(v) => set('regularHoursOnly', v === undefined ? undefined : v === 'true')}
        />
      </FormSection>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={mutation.isPending}
          className="rounded-lg bg-brand px-5 py-2.5 text-sm font-medium text-ink-900 transition-colors hover:bg-brand/80 disabled:opacity-50"
        >
          {mutation.isPending ? 'Saving…' : 'Save settings'}
        </button>
        {mutation.isSuccess && (
          <span className="text-sm text-gain">Saved.</span>
        )}
        {mutation.isError && (
          <span className="text-sm text-loss">
            {(mutation.error as Error).message}
          </span>
        )}
      </div>
    </form>
  )
}

// =============================================================================
// Position sizing
// =============================================================================

const USD = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

/** The three size keywords for one asset type, side by side. */
function SizingRow({
  asset,
  small,
  medium,
  full,
  onSmall,
  onMedium,
  onFull,
}: {
  asset: string
  small: number | undefined
  medium: number | undefined
  full: number | undefined
  onSmall: (value: number | undefined) => void
  onMedium: (value: number | undefined) => void
  onFull: (value: number | undefined) => void
}) {
  return (
    <div className="grid grid-cols-3 gap-3">
      <NumberField label={`${asset} · Small (%)`} value={small} onChange={onSmall} placeholder="" min={0} max={100} step={0.25} />
      <NumberField label={`${asset} · Medium (%)`} value={medium} onChange={onMedium} placeholder="" min={0} max={100} step={0.25} />
      <NumberField label={`${asset} · Full / ceiling (%)`} value={full} onChange={onFull} placeholder="" min={0} max={100} step={0.25} />
    </div>
  )
}

/**
 * What the numbers above actually do to the account: one bar per size, scaled
 * against the largest of them, plus the total that a full day of trading at
 * the daily cap could deploy.
 */
function SizingPreview({ form }: { form: TradeSettingsInput }) {
  // Shares the dashboard's cache; `retry: false` so a disconnected broker
  // degrades to percentages immediately instead of after three attempts.
  const portfolio = useQuery({
    queryKey: ['portfolio'],
    queryFn: fetchPortfolio,
    retry: false,
  })
  const buyingPower = portfolio.data?.buyingPowerUsd ?? null

  // Mirrors sizePct() in the server's riskFilter: Full is the ceiling, so a
  // Small or Medium typed above it is clamped. Showing the clamped bar means
  // the preview is always what the next callout actually deploys.
  const equityFull = form.equityFullPct ?? 0
  const optionsFull = form.optionsFullPct ?? 0
  const sizes = [
    { label: 'Stock · Small', pct: Math.min(form.equitySmallPct ?? 0, equityFull) },
    { label: 'Stock · Medium', pct: Math.min(form.equityMediumPct ?? 0, equityFull) },
    { label: 'Stock · Full', pct: equityFull },
    { label: 'Options · Small', pct: Math.min(form.optionsSmallPct ?? 0, optionsFull) },
    { label: 'Options · Medium', pct: Math.min(form.optionsMediumPct ?? 0, optionsFull) },
    { label: 'Options · Full', pct: optionsFull },
  ]
  const widest = Math.max(...sizes.map((s) => s.pct))
  const dailyPct = (form.maxTradesPerDay ?? 0) * (form.equityFullPct ?? 0)

  return (
    <div className="rounded-lg border border-ink-600 bg-ink-700/40 p-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium text-white">One trade costs</span>
        <span className="text-xs text-ink-400">
          {buyingPower === null
            ? 'connect Robinhood to see dollar amounts'
            : `of ${USD.format(buyingPower)} buying power`}
        </span>
      </div>

      <div className="flex flex-col gap-2">
        {sizes.map((size) => (
          <SizingBar
            key={size.label}
            label={size.label}
            pct={size.pct}
            widthPct={widest > 0 ? (size.pct / widest) * 100 : 0}
            buyingPower={buyingPower}
          />
        ))}
      </div>

      <div className="mt-3 border-t border-ink-600 pt-3">
        <SizingBar
          label="All day, worst case"
          pct={dailyPct}
          widthPct={Math.min(dailyPct, 100)}
          buyingPower={buyingPower}
          tone="warn"
        />
        <p className="mt-1.5 text-[11px] text-ink-400">
          {form.maxTradesPerDay ?? 0} trades per day at Stock · Full.
        </p>
      </div>
    </div>
  )
}

function SizingBar({
  label,
  pct,
  widthPct,
  buyingPower,
  tone = 'brand',
}: {
  label: string
  pct: number
  widthPct: number
  buyingPower: number | null
  tone?: 'brand' | 'warn'
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-32 shrink-0 text-xs text-ink-400">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-ink-700">
        <div
          className={`h-full rounded-full ${tone === 'warn' ? 'bg-loss/70' : 'bg-brand'}`}
          style={{ width: `${widthPct}%` }}
        />
      </div>
      <span className="w-28 shrink-0 text-right text-xs tabular-nums text-white">
        {buyingPower !== null && `${USD.format((buyingPower * pct) / 100)} `}
        <span className="text-ink-400">{pct}%</span>
      </span>
    </div>
  )
}

/** Who to copy-trade: the roster of Callers, toggled by clicking their avatar. */
function CallersSection({
  followed,
  onChange,
}: {
  followed: string[] | null
  onChange: (value: string[] | null) => void
}) {
  const callers = useQuery({ queryKey: ['callers'], queryFn: fetchCallers })
  const roster = callers.data ?? []
  const isFollowed = (authorId: string): boolean =>
    followed === null || followed.includes(authorId)
  const followedCount = roster.filter((c) => isFollowed(c.authorId)).length

  return (
    <FormSection title="Callers">
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <span className="text-ink-400">
          {followed === null
            ? 'Following everyone — including Callers added later'
            : `Following ${followedCount} of ${roster.length} Callers`}
        </span>
        <button
          type="button"
          className="text-brand hover:underline"
          onClick={() => onChange(roster.map((c) => c.authorId))}
        >
          Select all
        </button>
        <button
          type="button"
          className="text-ink-400 hover:underline"
          onClick={() => onChange([])}
        >
          Clear all
        </button>
      </div>
      {callers.isPending && (
        <p className="text-sm text-ink-400">Loading Callers…</p>
      )}
      {callers.isError && (
        <p className="text-sm text-loss">
          Failed to load Callers: {(callers.error as Error).message}
        </p>
      )}
      {callers.isSuccess && (
        <div className="flex flex-wrap gap-4">
          {roster.map((caller) => (
            <CallerTile
              key={caller.authorId}
              caller={caller}
              followed={isFollowed(caller.authorId)}
              onToggle={() =>
                onChange(
                  toggleCaller(
                    followed,
                    roster.map((c) => c.authorId),
                    caller.authorId,
                  ),
                )
              }
            />
          ))}
        </div>
      )}
    </FormSection>
  )
}

function CallerTile({
  caller,
  followed,
  onToggle,
}: {
  caller: Caller
  followed: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={followed ? `Unfollow ${caller.displayName}` : `Follow ${caller.displayName}`}
      className="flex w-16 flex-col items-center gap-1.5"
    >
      <span className="relative">
        <img
          src={caller.avatarUrl ?? discordDefaultAvatarUrl(caller.authorId)}
          alt=""
          className={`h-14 w-14 rounded-full ${followed ? 'ring-2 ring-brand' : 'grayscale opacity-40'}`}
        />
        {followed && (
          <span className="absolute -right-0.5 -bottom-0.5 flex size-4 items-center justify-center rounded-full bg-brand text-ink-900">
            <Check className="size-3" />
          </span>
        )}
      </span>
      <span
        className={`w-full truncate text-center text-xs ${followed ? 'text-white' : 'text-ink-400'}`}
      >
        {caller.displayName}
      </span>
    </button>
  )
}

const inputClass =
  'w-full rounded-lg border border-ink-600 bg-ink-700 px-3 py-2 text-sm text-white transition-colors focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25'

function FormSection({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="rounded-xl border border-ink-600 bg-ink-800 p-6">
      <h2 className="mb-4 text-base font-semibold text-white">{title}</h2>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  )
}

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

function SelectField<T extends string>({
  label,
  value,
  options,
  placeholder,
  onChange,
}: {
  label: string
  value: T | undefined
  options: readonly T[]
  placeholder: string
  onChange: (value: T | undefined) => void
}) {
  return (
    <Field label={label}>
      <select
        className={inputClass}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? undefined : (e.target.value as T))}
      >
        <option value="">{placeholder}</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </Field>
  )
}

function NumberField({
  label,
  value,
  onChange,
  placeholder,
  min,
  max,
  step = 1,
}: {
  label: string
  value: number | undefined
  onChange: (value: number | undefined) => void
  placeholder: string
  min?: number
  max?: number
  step?: number
}) {
  return (
    <Field label={label}>
      <input
        type="number"
        className={inputClass}
        value={value ?? ''}
        placeholder={placeholder}
        min={min}
        max={max}
        step={step}
        onChange={(e) =>
          onChange(e.target.value === '' ? undefined : Number(e.target.value))
        }
      />
    </Field>
  )
}

function TickerListField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string
  value: string[] | undefined
  onChange: (value: string[] | undefined) => void
  placeholder: string
}) {
  // Raw text state so typing commas/spaces isn't mangled by parse-on-change.
  const [text, setText] = useState(value?.join(',') ?? '')
  return (
    <Field label={label}>
      <input
        type="text"
        className={inputClass}
        value={text}
        placeholder={placeholder}
        onChange={(e) => {
          setText(e.target.value)
          const tickers = e.target.value
            .split(',')
            .map((t) => t.trim().toUpperCase())
            .filter((t) => t.length > 0)
          onChange(tickers.length === 0 ? undefined : tickers)
        }}
      />
    </Field>
  )
}
