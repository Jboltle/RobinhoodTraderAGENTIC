/**
 * Toggle one Caller in a Following list. `null` means "follow everyone,
 * including future Callers", so the first deselect materializes it into an
 * explicit list of every current roster ID minus the clicked one — the user
 * never sees the null/array mechanics.
 */
export function toggleCaller(
  followed: string[] | null,
  rosterIds: string[],
  authorId: string,
): string[] | null {
  if (followed === null) return rosterIds.filter((id) => id !== authorId)
  return followed.includes(authorId)
    ? followed.filter((id) => id !== authorId)
    : [...followed, authorId]
}

/** Discord derives which of its 6 default avatars a user gets from their ID. */
export function discordDefaultAvatarUrl(authorId: string): string {
  // A non-numeric id (malformed input) gets index 0 instead of a BigInt throw.
  const index = /^\d+$/.test(authorId) ? (BigInt(authorId) >> 22n) % 6n : 0n
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`
}

export interface TradeCallerFace {
  name: string
  avatarUrl: string | null
}

/**
 * Resolve the Trades-table Caller cell from the feed Callout + Settings roster.
 * No Callout, or a Callout with no author identity → null (render as —).
 */
export function resolveTradeCaller(
  messageId: string,
  calloutByMessageId: ReadonlyMap<
    string,
    { authorId: string | null; authorName: string }
  >,
  rosterByAuthorId: ReadonlyMap<
    string,
    { displayName: string; avatarUrl: string | null }
  >,
): TradeCallerFace | null {
  const callout = calloutByMessageId.get(messageId)
  if (!callout) return null

  if (callout.authorId) {
    const roster = rosterByAuthorId.get(callout.authorId)
    return {
      name: roster?.displayName || callout.authorName,
      avatarUrl: roster?.avatarUrl ?? discordDefaultAvatarUrl(callout.authorId),
    }
  }

  const name = callout.authorName.trim().slice(0,12)
  if (!name) return null
  return { name, avatarUrl: null }
}
