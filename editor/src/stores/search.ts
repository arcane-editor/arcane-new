import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { FileSearchResult } from '../types';
import { useProjectContextStore } from './project-context';
import { useWorkspaceStore } from './workspace';

interface SearchState {
  query: string;
  isRegex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  includePattern: string;
  excludePattern: string;
  results: FileSearchResult[];
  totalMatches: number;
  fileCount: number;
  truncated: boolean;
  isSearching: boolean;

  setQuery: (query: string) => void;
  toggleRegex: () => void;
  toggleCaseSensitive: () => void;
  toggleWholeWord: () => void;
  setIncludePattern: (pattern: string) => void;
  setExcludePattern: (pattern: string) => void;
  search: (workspacePath: string) => Promise<void>;
  clearResults: () => void;
}

let searchGeneration = 0;

export const useSearchStore = create<SearchState>((set, get) => ({
  query: '',
  isRegex: false,
  caseSensitive: false,
  wholeWord: false,
  includePattern: '',
  excludePattern: '',
  results: [],
  totalMatches: 0,
  fileCount: 0,
  truncated: false,
  isSearching: false,

  setQuery: (query) => set({ query }),
  toggleRegex: () => set((s) => ({ isRegex: !s.isRegex })),
  toggleCaseSensitive: () => set((s) => ({ caseSensitive: !s.caseSensitive })),
  toggleWholeWord: () => set((s) => ({ wholeWord: !s.wholeWord })),
  setIncludePattern: (pattern) => set({ includePattern: pattern }),
  setExcludePattern: (pattern) => set({ excludePattern: pattern }),

  search: async (workspacePath) => {
    const { query, isRegex, caseSensitive, wholeWord, includePattern, excludePattern } = get();
    if (!query) { get().clearResults(); return; }

    const gen = ++searchGeneration;
    set({ isSearching: true });

    try {
      const isUnity = useProjectContextStore.getState().isUnityProject;
      const assetsRootPath = useWorkspaceStore.getState().assetsRootPath;
      const searchRoot = isUnity && assetsRootPath ? assetsRootPath : workspacePath;
      const res = await invoke<{ results: FileSearchResult[]; totalMatches: number; fileCount: number; truncated: boolean }>(
        'search_in_files',
        {
          workspacePath: searchRoot,
          query,
          isRegex,
          caseSensitive,
          wholeWord,
          includePattern: includePattern || null,
          excludePattern: excludePattern || null,
          fileExtensions: isUnity ? ['cs'] : null,
        }
      );
      if (gen !== searchGeneration) return;
      set({
        results: res.results,
        totalMatches: res.totalMatches,
        fileCount: res.fileCount,
        truncated: res.truncated,
        isSearching: false,
      });
    } catch {
      if (gen === searchGeneration) set({ isSearching: false });
    }
  },

  clearResults: () => set({ results: [], totalMatches: 0, fileCount: 0, truncated: false }),
}));
