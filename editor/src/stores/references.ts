/**
 * Find Usages — a walkable list of `textDocument/references` hits.
 *
 * Monaco's peek widget is fine for two results and useless for forty: it sits
 * on top of the code you are reading, closes when you navigate, and has no
 * grouping. This is the same data in a panel you can work through.
 *
 * Modelled on `unity-context/stores/scene-usage.ts` — cache keyed by query,
 * promise dedup, generation guard — with one deliberate difference: a failed
 * query renders as an ERROR, not as an empty result. In the scene-usage store
 * a fetch failure is swallowed into `entries = []`, which makes "this symbol is
 * unused" and "the language server did not answer" look identical. For a
 * question you would act on — is it safe to delete this? — they must not.
 */

import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { ReferenceHit } from '../features/lsp';

export interface ReferenceLine extends ReferenceHit {
  /** Source text of the hit's line, trimmed. Empty when the file is unreadable. */
  preview: string;
  /** Column of the match within `preview`, 0-based; -1 when unknown. */
  previewMatchStart: number;
  previewMatchLength: number;
}

export interface ReferenceFileGroup {
  path: string;
  name: string;
  hits: ReferenceLine[];
}

export type ReferenceQueryStatus = 'idle' | 'loading' | 'ready' | 'error';

interface RawFile {
  path: string;
  content: string;
}

interface ReferencesState {
  /** What the current results are about, for the panel header. */
  symbol: string | null;
  status: ReferenceQueryStatus;
  error: string | null;
  groups: ReferenceFileGroup[];
  /** Collapsed file paths. Absent means expanded — most results want to be read. */
  collapsed: Set<string>;
  filter: string;

  setFilter: (filter: string) => void;
  toggleCollapsed: (path: string) => void;
  /** Start a query; the returned token must be handed back to `showResults`/`fail`. */
  begin: (symbol: string) => number;
  showResults: (token: number, symbol: string, hits: ReferenceHit[]) => Promise<void>;
  fail: (token: number, symbol: string, message: string) => void;
  reset: () => void;
}

/**
 * Bumped on every new query. A slow query must not paint over the results of a
 * newer one the user has already asked for.
 *
 * The token is issued by `begin` and passed back in, rather than re-read at
 * completion time: the whole gap that matters is the one BETWEEN starting a
 * query and reporting it, so a guard that samples the counter after the request
 * has already returned is checking the wrong interval and never fires.
 */
let generation = 0;

function basename(path: string): string {
  return path.split('/').pop() || path;
}

/** Group hits by file, preserving first-seen file order and sorting within a file. */
export function groupHits(hits: ReferenceLine[]): ReferenceFileGroup[] {
  const byPath = new Map<string, ReferenceLine[]>();
  for (const hit of hits) {
    const list = byPath.get(hit.path);
    if (list) list.push(hit);
    else byPath.set(hit.path, [hit]);
  }
  return [...byPath.entries()].map(([path, list]) => ({
    path,
    name: basename(path),
    hits: list.sort((a, b) => a.line - b.line || a.column - b.column),
  }));
}

/**
 * Attach the source line each hit sits on.
 *
 * Line text, not the containing symbol name: naming the symbol would need a
 * `documentSymbol` round trip per result file, and those files are not open in
 * the language server. The line itself is what you actually read to decide
 * whether a hit matters.
 */
export function attachPreviews(hits: ReferenceHit[], files: RawFile[], symbol: string): ReferenceLine[] {
  const linesByPath = new Map<string, string[]>();
  for (const file of files) linesByPath.set(file.path, file.content.split('\n'));

  return hits.map((hit) => {
    const raw = linesByPath.get(hit.path)?.[hit.line - 1] ?? '';
    const leading = raw.length - raw.trimStart().length;
    const preview = raw.trim();
    // `hit.column` is 1-based against the raw line; re-base it onto the trimmed
    // preview. Fall back to a text search when the server's column and the
    // file on disk disagree (an unsaved buffer, a stale index).
    let start = hit.column - 1 - leading;
    if (start < 0 || preview.slice(start, start + symbol.length) !== symbol) {
      start = preview.indexOf(symbol);
    }
    return {
      ...hit,
      preview,
      previewMatchStart: start,
      previewMatchLength: start >= 0 ? symbol.length : 0,
    };
  });
}

export const useReferencesStore = create<ReferencesState>((set) => ({
  symbol: null,
  status: 'idle',
  error: null,
  groups: [],
  collapsed: new Set<string>(),
  filter: '',

  setFilter: (filter) => set({ filter }),

  toggleCollapsed: (path) =>
    set((state) => {
      const collapsed = new Set(state.collapsed);
      if (collapsed.has(path)) collapsed.delete(path);
      else collapsed.add(path);
      return { collapsed };
    }),

  begin: (symbol) => {
    const token = ++generation;
    set({ symbol, status: 'loading', error: null, groups: [], collapsed: new Set(), filter: '' });
    return token;
  },

  showResults: async (token, symbol, hits) => {
    if (token !== generation) return;

    if (hits.length === 0) {
      set({ symbol, status: 'ready', error: null, groups: [] });
      return;
    }

    const paths = [...new Set(hits.map((h) => h.path))];
    let files: RawFile[] = [];
    try {
      files = await invoke<RawFile[]>('read_files_bulk', { paths });
    } catch {
      // Previews are a nicety; losing them must not lose the results.
      files = [];
    }
    if (token !== generation) return;

    set({
      symbol,
      status: 'ready',
      error: null,
      groups: groupHits(attachPreviews(hits, files, symbol)),
    });
  },

  fail: (token, symbol, message) => {
    if (token !== generation) return;
    set({ symbol, status: 'error', error: message, groups: [] });
  },

  reset: () => {
    generation++;
    set({ symbol: null, status: 'idle', error: null, groups: [], collapsed: new Set(), filter: '' });
  },
}));
