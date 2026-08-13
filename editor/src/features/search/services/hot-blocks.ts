// Which file blocks hold a live Monaco editor. Mounting one costs real time
// and memory, so only blocks in view are hydrated and the rest fall back to
// the read-only render. Recently-visible blocks stay hot so scrolling back a
// few rows does not re-mount.

/**
 * The new hot set and the keys to tear down.
 *
 * Visible blocks are always hot and are never evicted. Remaining capacity goes
 * to previously-hot blocks in their existing order (most recent first). Keys
 * absent from `keys` are evicted unconditionally — that is what happens when a
 * new query replaces the result set.
 */
export function hotSet(
  visibleIndices: number[],
  previous: string[],
  keys: string[],
  cap: number,
): { hot: string[]; evicted: string[] } {
  const visible = visibleIndices
    .map((index) => keys[index])
    .filter((key): key is string => key !== undefined);

  const hot = [...visible];
  for (const key of previous) {
    if (hot.length >= cap) break;
    if (hot.includes(key)) continue;
    if (!keys.includes(key)) continue;
    hot.push(key);
  }

  const evicted = previous.filter((key) => !hot.includes(key));
  return { hot, evicted };
}
