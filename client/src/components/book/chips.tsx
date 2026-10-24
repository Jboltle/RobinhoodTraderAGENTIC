import type { Caller, Decision } from '../../lib/api'
import { Outcome, chipClass } from '../TradesTable'

/** Avatar + name for the Caller behind a tracked position. */
export function CallerChip({ caller, authorId }: { caller: Caller | undefined; authorId: string }) {
  const name = caller?.displayName ?? authorId
  return (
    <span className="inline-flex max-w-40 items-center gap-1.5 rounded-full bg-ink-700 py-0.5 pr-2.5 pl-0.5 text-xs text-ink-400">
      {caller?.avatarUrl ? (
        <img src={caller.avatarUrl} alt="" className="size-4 rounded-full" />
      ) : (
        <span className="flex size-4 items-center justify-center rounded-full bg-ink-600 text-[9px] font-semibold uppercase text-white">
          {name.slice(0, 1)}
        </span>
      )}
      <span className="truncate">{name}</span>
    </span>
  )
}

/**
 * This account's own outcome for a Caller entry: the thing the book shows
 * that a tracking-only site cannot. Null decision = the entry was never run
 * for this account (before it connected, or an unfollowed Caller).
 */
export function MyOutcome({ decision }: { decision: Decision | null | undefined }) {
  if (!decision) {
    return <span className={`${chipClass} bg-ink-700 text-ink-500`}>not traded</span>
  }
  return <Outcome decision={decision} />
}
