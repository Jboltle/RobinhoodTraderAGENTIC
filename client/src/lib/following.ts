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
