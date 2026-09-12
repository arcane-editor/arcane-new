import { create } from 'zustand';

/**
 * A version that has been staged by the Rust watcher and is waiting on a
 * restart.
 *
 * The shape lives here rather than in `features/updates` because two surfaces
 * consume it — the toast and the title-bar control — and a store both can read
 * is the only thing that keeps them showing the same version.
 */
export interface PendingUpdate {
  version: string;
  /**
   * True when the new version is already in place and only a relaunch is
   * outstanding (macOS). False when the install still has to run and will
   * terminate the app to do it (Windows).
   */
  installed: boolean;
}

interface UpdatesState {
  /** Null until an update is staged; never cleared by a restart — the process ends. */
  pending: PendingUpdate | null;
  setPending: (update: PendingUpdate) => void;
  clearPending: () => void;
}

export const useUpdatesStore = create<UpdatesState>((set) => ({
  pending: null,
  setPending: (pending) => set({ pending }),
  clearPending: () => set({ pending: null }),
}));
