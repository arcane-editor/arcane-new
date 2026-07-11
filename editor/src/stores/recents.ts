import { create } from 'zustand';
import {
  loadRecentProjectsFull,
  refreshRecentsCache,
  addRecentProject as persistAdd,
  removeRecentProject as persistRemove,
  type RecentProject,
} from '../utils/persistence';

interface RecentsState {
  recents: RecentProject[];
  reload: () => Promise<void>;
  add: (path: string) => void;
  remove: (path: string) => void;
}

export const useRecentsStore = create<RecentsState>((set) => ({
  recents: [],
  // Re-reads from the shared on-disk store (not just the in-memory cache) —
  // other windows can add/remove recents while this one is open. See
  // `refreshRecentsCache`'s doc comment.
  reload: async () => {
    const recents = await refreshRecentsCache();
    set({ recents });
  },
  add: (path: string) => {
    persistAdd(path);
    set({ recents: loadRecentProjectsFull() });
  },
  remove: (path: string) => {
    persistRemove(path);
    set({ recents: loadRecentProjectsFull() });
  },
}));
