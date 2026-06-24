import { create } from 'zustand';
import {
  loadRecentProjectsFull,
  addRecentProject as persistAdd,
  removeRecentProject as persistRemove,
  type RecentProject,
} from '../utils/persistence';

interface RecentsState {
  recents: RecentProject[];
  reload: () => void;
  add: (path: string) => void;
  remove: (path: string) => void;
}

export const useRecentsStore = create<RecentsState>((set) => ({
  recents: [],
  reload: () => set({ recents: loadRecentProjectsFull() }),
  add: (path: string) => {
    persistAdd(path);
    set({ recents: loadRecentProjectsFull() });
  },
  remove: (path: string) => {
    persistRemove(path);
    set({ recents: loadRecentProjectsFull() });
  },
}));
