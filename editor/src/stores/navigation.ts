/**
 * Jump history — Navigate Back / Forward.
 *
 * Two stacks, not one list with a cursor. The "current" location is never
 * stored: it is read live off `workspace.activeFilePath` + `ui.cursorPosition`
 * at the moment Back or Forward runs. That matters because the cursor keeps
 * moving after you arrive somewhere, and a stored copy would send you back to
 * where you *landed* rather than where you actually are.
 *
 * So the only thing recorded is the location you are LEAVING, pushed by
 * `recordJumpOrigin()` at the moment a jump starts. See `installJumpHistory`
 * for the two places that fire.
 */

import { create } from 'zustand';
import { isVirtualPath } from '../utils/virtual-path';

export interface NavEntry {
  path: string;
  line: number;
  column: number;
}

/**
 * How far back you can walk. Deep enough to cover a morning's worth of
 * spelunking, shallow enough that the arrays stay trivial to copy.
 */
export const JUMP_HISTORY_LIMIT = 50;

export function sameLocation(a: NavEntry | null, b: NavEntry | null): boolean {
  if (!a || !b) return false;
  return a.path === b.path && a.line === b.line;
}

interface NavigationState {
  /** Places you have left, oldest first. The top is the most recent. */
  back: NavEntry[];
  /** Places you have come Back from, so Forward can return to them. */
  forward: NavEntry[];
  /**
   * True while a Back/Forward jump is being applied. `recordJumpOrigin` is a
   * no-op then — replaying history must not itself write history, or Back
   * would only ever toggle between two locations.
   */
  replaying: boolean;

  push: (entry: NavEntry) => void;
  goBack: (current: NavEntry | null) => NavEntry | null;
  goForward: (current: NavEntry | null) => NavEntry | null;
  setReplaying: (replaying: boolean) => void;
  reset: () => void;
}

/** A location worth remembering: a real file, with a real line. */
function isRecordable(entry: NavEntry | null): entry is NavEntry {
  if (!entry) return false;
  if (!entry.path || isVirtualPath(entry.path)) return false;
  return Number.isFinite(entry.line) && entry.line >= 1;
}

export const useNavigationStore = create<NavigationState>((set, get) => ({
  back: [],
  forward: [],
  replaying: false,

  push: (entry) => {
    const state = get();
    if (state.replaying || !isRecordable(entry)) return;
    // Landing on the same line you already recorded is not a jump. Without
    // this, a run of navigations inside one line stacks duplicate entries and
    // Back appears to do nothing several presses in a row.
    if (sameLocation(state.back[state.back.length - 1] ?? null, entry)) return;

    const back = [...state.back, entry].slice(-JUMP_HISTORY_LIMIT);
    // A fresh navigation invalidates the Forward tail, exactly like a browser.
    set({ back, forward: [] });
  },

  goBack: (current) => {
    const state = get();
    const target = state.back[state.back.length - 1];
    if (!target) return null;

    const back = state.back.slice(0, -1);
    const forward = isRecordable(current)
      ? [...state.forward, current].slice(-JUMP_HISTORY_LIMIT)
      : state.forward;
    set({ back, forward });
    return target;
  },

  goForward: (current) => {
    const state = get();
    const target = state.forward[state.forward.length - 1];
    if (!target) return null;

    const forward = state.forward.slice(0, -1);
    const back = isRecordable(current)
      ? [...state.back, current].slice(-JUMP_HISTORY_LIMIT)
      : state.back;
    set({ back, forward });
    return target;
  },

  setReplaying: (replaying) => set({ replaying }),

  reset: () => set({ back: [], forward: [], replaying: false }),
}));
