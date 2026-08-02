/**
 * Window labels for project windows, derived from the project's canonical path.
 *
 * A project window's Tauri label IS the identity of its persisted state: it
 * keys `windows.json` (see `utils/persistence.ts`) and it is how
 * `openProjectInNewWindow` finds an already-open window instead of spawning a
 * duplicate. So the label and the persisted-state migration must agree on the
 * exact same hash function — hence its own module rather than a copy on each
 * side, and rather than an import from `features/project` (which would pull a
 * feature barrel, and through it components that import stores, into the
 * persistence layer).
 */

const HASH_PREFIX = 'editor-';

/**
 * djb2-xor over the path, rendered as a fixed-width hex suffix.
 *
 * Only ever needs to be collision-resistant across the handful of projects a
 * user has open at once, and stable across releases — changing it orphans
 * every persisted window state, which is exactly the bug the path
 * normalization introduced on Windows.
 */
export function hashLabel(path: string): string {
  let h = 5381 >>> 0;
  for (let i = 0; i < path.length; i++) h = ((h * 33) ^ path.charCodeAt(i)) >>> 0;
  return HASH_PREFIX + h.toString(16).padStart(8, '0');
}
