// ── Asset-usage cache invalidation policy ───────────────────────────────────
//
// The scene-usage caches are derived from `.unity` / `.prefab` / `.asset` files,
// so they have to drop when those change on disk. Three things make the naive
// version wrong, and all three bite the ScriptableObject inspector first:
//
//  1. Unity rewrites whole folders on import, so one reimport fires many
//     `file-index-changed` events. Without a debounce the panel reloads once
//     per file.
//  2. When the inspector saves an asset ITSELF, the resulting watcher event is
//     not news — it is the write we just made. Invalidating on it throws away
//     the data we are about to re-render and causes a visible flicker.
//  3. A change to an unrelated file type is not a reason to drop anything.
//
// Kept pure and separate from the store so the policy is testable without a
// Tauri event bus.

/** File kinds whose contents feed the usage caches. */
const RELEVANT_EXT = ['.unity', '.prefab', '.asset'];

/**
 * How long a self-written path stays suppressed. Long enough to cover the
 * watcher's own debounce plus a slow disk; short enough that a genuine external
 * change to the same file moments later is not swallowed.
 */
export const SELF_WRITE_SUPPRESSION_MS = 2000;

/** absolute path → timestamp of our own write. */
const selfWrites = new Map<string, number>();

/**
 * Record that WE just wrote this asset, so the watcher event it produces does
 * not invalidate the caches. Call immediately BEFORE the write.
 */
export function noteSelfWrittenAsset(absPath: string, now = Date.now()): void {
  selfWrites.set(absPath, now);
}

/** Drop expired suppression entries so the map cannot grow without bound. */
function prune(now: number): void {
  for (const [path, at] of selfWrites) {
    if (now - at > SELF_WRITE_SUPPRESSION_MS) selfWrites.delete(path);
  }
}

/**
 * Should a batch of changed paths drop the usage caches?
 *
 * True when at least one path is a Unity asset that we did not just write
 * ourselves.
 */
export function shouldInvalidate(paths: string[], now = Date.now()): boolean {
  prune(now);
  for (const p of paths) {
    const lower = p.toLowerCase();
    if (!RELEVANT_EXT.some((e) => lower.endsWith(e))) continue;
    const writtenAt = selfWrites.get(p);
    if (writtenAt !== undefined && now - writtenAt <= SELF_WRITE_SUPPRESSION_MS) {
      continue; // our own write coming back around
    }
    return true;
  }
  return false;
}

/** Test seam — forget every recorded self-write. */
export function __resetSelfWritesForTest(): void {
  selfWrites.clear();
}
