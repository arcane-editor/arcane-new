import { invoke } from '@tauri-apps/api/core';

/**
 * Bring this window to the front.
 *
 * One command rather than three JS calls (`unminimize`/`show`/`setFocus`): the
 * order is load-bearing — tao's macOS `set_focus` returns early on a
 * miniaturized or hidden window, so focusing alone silently does nothing to a
 * minimized one — and it is enforced once, in `window_registry::raise`.
 *
 * Lives in `utils/` rather than in `features/project` because the Unity bridge
 * store needs it too, and a store reaching into a feature barrel that reaches
 * back into stores is the mutual-import shape that has broken app startup here
 * before.
 *
 * Best-effort: raising must never fail the open it accompanies.
 */
export async function raiseCurrentWindow(): Promise<void> {
  try {
    await invoke('raise_current_window');
  } catch {
    /* ignore */
  }
}
