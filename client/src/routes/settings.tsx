import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { fetchSettings, type TradeSettings, type TradeSettingsInput } from '../lib/api'
import { saveSettings } from '../lib/settingsSync'

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
  ssr: false,
})

function SettingsPage() {
  // The form initializes from the trader's resolved settings; saving needs
  // the trader anyway, so an unreachable trader is a hard error here.
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
  return <SettingsForm initial={settings.data} defaults={settings.data} />
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

  // Placeholder showing the trader's effective default, when reachable.
  const ph = (key: keyof TradeSettings): string =>
    defaults === undefined
      ? 'default (trader offline)'
      : `default: ${Array.isArray(defaults[key]) ? (defaults[key] as string[]).join(',') : String(defaults[key])}`

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
          Saved settings are written to the trader and applied to every new
          trade; they persist across restarts. Blank fields are unset and fall
          through to the trader's env defaults.
        </p>
      </header>

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
        <NumberField label="Max equity notional per trade (% of buying power)" value={form.maxNotionalPct} onChange={(v) => set('maxNotionalPct', v)} placeholder={ph('maxNotionalPct')} min={0} max={100} step={0.5} />
        <NumberField label="Max options notional per trade (%)" value={form.maxOptionsNotionalPct} onChange={(v) => set('maxOptionsNotionalPct', v)} placeholder={ph('maxOptionsNotionalPct')} min={0} max={100} step={0.5} />
        <NumberField label="Max single contract cost (%)" value={form.maxSingleContractPct} onChange={(v) => set('maxSingleContractPct', v)} placeholder={ph('maxSingleContractPct')} min={0} max={100} step={0.5} />
        <NumberField label="'Small' position (% of cap)" value={form.positionSmallPct} onChange={(v) => set('positionSmallPct', v)} placeholder={ph('positionSmallPct')} min={0} max={100} step={0.5} />
        <NumberField label="'Medium' position (% of cap)" value={form.positionMediumPct} onChange={(v) => set('positionMediumPct', v)} placeholder={ph('positionMediumPct')} min={0} max={100} step={0.5} />
      </FormSection>

      <FormSection title="Limits & cooldowns">
        <NumberField label="Max trades per day" value={form.maxTradesPerDay} onChange={(v) => set('maxTradesPerDay', v)} placeholder={ph('maxTradesPerDay')} min={0} step={1} />
        <NumberField label="Per-ticker cooldown (seconds)" value={form.cooldownSeconds} onChange={(v) => set('cooldownSeconds', v)} placeholder={ph('cooldownSeconds')} min={0} step={1} />
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
