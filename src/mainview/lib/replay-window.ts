/** A bounded replay with no overlap cannot safely append to old scrollback.
 * Replacing the visible window keeps the earlier-page cursor before the gap. */
export function replayWindowHasGap(earliestId: number | null, loadedIds: Iterable<number>): boolean {
  if (earliestId === null) return false;
  for (const id of loadedIds) if (id >= earliestId) return false;
  return true;
}
