/**
 * The price the Caller said, read off the callout that produced a trade, so a
 * trade row can show "ours vs theirs" without a second data source.
 *
 * Entries: the shared parse's limit, which is the Caller's stated premium.
 * Exits: the parse carries no price (we sell at market), so it comes from
 * the Caller's own card: a Swift-style `Exit` field, else the first
 * "entry -> price" arrow in the text (Namrood's milestone line).
 */
import type { CalloutItem } from './api'

interface EmbedField {
  name?: unknown
  value?: unknown
}

const PRICE = /\$?\s*(\d+(?:\.\d+)?)/
const ARROW = /\d+(?:\.\d+)?\s*(?:->|→|-->)\s*(\d+(?:\.\d+)?)/

function embedField(callout: CalloutItem, name: string): number | null {
  for (const embed of callout.embeds) {
    const fields = Array.isArray(embed.fields) ? (embed.fields as EmbedField[]) : []
    for (const field of fields) {
      if (typeof field.name !== 'string' || field.name.trim().toLowerCase() !== name) continue
      const match = typeof field.value === 'string' ? PRICE.exec(field.value) : null
      if (match) return Number(match[1])
    }
  }
  return null
}

export function callerPrice(
  callout: CalloutItem | undefined,
  side: 'buy' | 'sell' | null,
): number | null {
  if (!callout) return null
  if (side === 'buy') return callout.parse?.limitPrice ?? embedField(callout, 'entry')
  if (side === 'sell') {
    const exit = embedField(callout, 'exit')
    if (exit !== null) return exit
    const arrow = ARROW.exec(callout.content)
    return arrow ? Number(arrow[1]) : null
  }
  return null
}

/** Our fill against the Caller's price, as a signed fraction of theirs. */
export function priceGapPct(fill: number | null | undefined, caller: number | null): number | null {
  if (fill == null || caller === null || caller <= 0) return null
  return ((fill - caller) / caller) * 100
}
