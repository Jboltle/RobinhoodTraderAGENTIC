/**
 * The ladder graphic on a position card: entry tick on the left, one dot per
 * level (filled = solid, pending = hollow, runners smaller), and a diamond at
 * the current mark.
 *
 * Levels sit at even spacing rather than on a price scale: runner levels run
 * to +10,000%, so any linear axis would pile the body onto the entry tick.
 * The mark is interpolated between the two levels it sits between, and a mark
 * below entry slides into the short loss region left of the tick.
 */
import type { LadderLevel } from '../../lib/api'

const WIDTH = 300
const HEIGHT = 20
const MID = HEIGHT / 2
/** Where the entry tick sits; everything left of it is the loss region. */
const ENTRY_X = 36
const RIGHT_PAD = 6
const GAIN = 'var(--color-gain)'
const LOSS = 'var(--color-loss)'
const TRACK = 'var(--color-ink-600)'
const PENDING = 'var(--color-ink-500)'

export function TrimLadder({
  ladder,
  pctNow,
  className = '',
}: {
  ladder: readonly LadderLevel[]
  pctNow: number | null
  className?: string
}) {
  const span = WIDTH - RIGHT_PAD - ENTRY_X
  const step = ladder.length === 0 ? span : span / ladder.length
  const xOf = (index: number): number => ENTRY_X + step * (index + 1)
  const markX = pctNow === null ? null : markPosition(pctNow, ladder, xOf)
  const filledTo = ladder.reduce((last, level, i) => (level.filledAt ? i : last), -1)

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      className={`h-5 w-full ${className}`}
      aria-hidden="true"
    >
      <line x1={0} x2={WIDTH} y1={MID} y2={MID} stroke={TRACK} strokeWidth={2} />
      {filledTo >= 0 && (
        <line x1={ENTRY_X} x2={xOf(filledTo)} y1={MID} y2={MID} stroke={GAIN} strokeWidth={2} />
      )}
      <line x1={ENTRY_X} x2={ENTRY_X} y1={MID - 6} y2={MID + 6} stroke="white" strokeWidth={2} />
      {ladder.map((level, i) => (
        <circle
          key={level.pct}
          cx={xOf(i)}
          cy={MID}
          r={level.isRunner ? 2.5 : 3.5}
          fill={level.filledAt ? GAIN : 'var(--color-ink-800)'}
          stroke={level.filledAt ? GAIN : PENDING}
          strokeWidth={1.5}
        >
          <title>{`${level.label} · ${level.qty} @ ${level.price.toFixed(2)}${level.filledAt ? ' · filled' : ''}`}</title>
        </circle>
      ))}
      {markX !== null && (
        <path
          d={`M ${markX} ${MID - 6} L ${markX + 5} ${MID} L ${markX} ${MID + 6} L ${markX - 5} ${MID} Z`}
          fill={pctNow !== null && pctNow < 0 ? LOSS : 'white'}
        />
      )}
    </svg>
  )
}

function markPosition(
  pct: number,
  ladder: readonly LadderLevel[],
  xOf: (index: number) => number,
): number {
  if (pct <= 0) return ENTRY_X - Math.min(1, -pct / 100) * (ENTRY_X - 4)
  if (ladder.length === 0) return ENTRY_X + (WIDTH - RIGHT_PAD - ENTRY_X) * Math.min(1, pct / 100)
  let fromX = ENTRY_X
  let fromPct = 0
  for (const [i, level] of ladder.entries()) {
    if (pct <= level.pct) {
      return fromX + ((pct - fromPct) / (level.pct - fromPct)) * (xOf(i) - fromX)
    }
    fromX = xOf(i)
    fromPct = level.pct
  }
  return fromX
}
