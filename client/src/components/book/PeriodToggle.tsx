import type { BookPeriod } from '../../lib/api'

export const PERIODS: ReadonlyArray<{ period: BookPeriod; label: string }> = [
  { period: 'today', label: 'Today' },
  { period: 'week', label: 'Week' },
  { period: 'all', label: 'All time' },
]

export function PeriodToggle({
  value,
  onChange,
}: {
  value: BookPeriod
  onChange: (period: BookPeriod) => void
}) {
  return (
    <div className="flex rounded-lg border border-ink-600 bg-ink-800 p-1">
      {PERIODS.map(({ period, label }) => (
        <button
          key={period}
          type="button"
          onClick={() => onChange(period)}
          className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
            value === period ? 'bg-brand/15 text-brand' : 'text-ink-400 hover:text-white'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}
