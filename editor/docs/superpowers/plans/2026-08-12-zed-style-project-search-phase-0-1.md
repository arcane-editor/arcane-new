# Zed-Style Project Search — Phase 0 & 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move content-search results out of the sidebar tree and into a `search://` editor tab that renders syntax-highlighted excerpts with surrounding context, with the sidebar demoted to a synced outline.

**Architecture:** The Rust searcher gains context lines (sliced from the file bytes it already holds) and per-session cancellation. The frontend search store becomes session-keyed so several search tabs coexist. A new `search://<n>` virtual tab renders a virtualized list of file blocks; each block shows merged excerpt ranges highlighted with `monaco.editor.colorize()` — no editor instances in this phase. All decision logic lives in pure services with bun tests; components stay thin.

**Tech Stack:** Rust (`grep-searcher`, `grep-regex`, `ignore`, `globset`), React 19 + TypeScript, Zustand, `@tanstack/react-virtual`, Monaco 0.55.1, Tauri v2, bun test.

**Spec:** `docs/superpowers/specs/2026-08-12-zed-style-project-search-design.md`

## Global Constraints

- **Deep modules.** Import a feature only through its barrel: `import { X } from '../../search'`. Never reach into `features/<name>/components/...` or `.../services/...` from outside that feature. `bun run check:modules` enforces this.
- **Every invoke payload is statically checked.** `bun run check:invoke` compares each `invoke('cmd', {...})` against the Rust `#[tauri::command]` signature. Any new or changed command must keep this green, and gets a raw-JSON serde test on the Rust side (a typed test alone has previously missed payload drift here).
- **Rust structs facing the frontend use `#[serde(rename_all = "camelCase")]`.** Frontend fields are camelCase; Rust fields are snake_case.
- **`bun run verify` must pass before any task is called done.** It runs `tsc --noEmit`, `check:modules`, `check:invoke`, `bun test src`, `cargo test --lib`, and `verify:intellisense`. A `SKIPPED` from `verify:intellisense` is reported as a skip, never as a pass.
- **Keybinding changes require grepping `src-tauri/src/menu.rs`** for both the chord and the command id. On macOS the native menu wins over the JS registry.
- **No React Testing Library.** This repo has no component-test harness and none is being added. Test pure services; keep components thin enough that they carry no untested logic.
- **Test style:** `import { describe, it, expect } from 'bun:test';`, files named `*.test.ts` next to the module.
- **Commit after every task.**

---

### Task 1: `isVirtualPath` helper

The virtual-scheme predicate is open-coded in three places in `workspace.ts`. A third scheme is being added; consolidating first means the new scheme cannot be forgotten at one of them.

**Files:**
- Create: `src/utils/virtual-path.ts`
- Create: `src/utils/virtual-path.test.ts`
- Modify: `src/stores/workspace.ts:477`, `src/stores/workspace.ts:1256`, `src/stores/workspace.ts:1348`
- Modify: `src/utils/persistence.ts:435`
- Modify: `src/utils/persistence.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `isVirtualPath(path: string): boolean`, `VIRTUAL_SCHEMES: readonly string[]`.

- [ ] **Step 1: Write the failing test**

Create `src/utils/virtual-path.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { isVirtualPath } from './virtual-path';

describe('isVirtualPath', () => {
  it('matches every virtual scheme', () => {
    expect(isVirtualPath('diff://unstaged/src/a.ts')).toBe(true);
    expect(isVirtualPath('diff://commit/abc123/src/a.ts')).toBe(true);
    expect(isVirtualPath('auth://signin')).toBe(true);
    expect(isVirtualPath('search://1')).toBe(true);
  });

  it('does not match real paths on either platform', () => {
    expect(isVirtualPath('/Users/x/proj/src/a.ts')).toBe(false);
    expect(isVirtualPath('C:/proj/src/a.ts')).toBe(false);
  });

  it('only matches at the start, never mid-path', () => {
    expect(isVirtualPath('/Users/x/search://1')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test src/utils/virtual-path.test.ts`
Expected: FAIL — cannot resolve `./virtual-path`.

- [ ] **Step 3: Implement**

Create `src/utils/virtual-path.ts`:

```ts
/**
 * Tab paths that name something other than a file on disk. Anything that
 * reads, writes, watches, re-opens or language-server-syncs a tab must skip
 * these — there is no file behind them.
 *
 * Note this is NOT the same predicate as `shouldPersistTab` in
 * `persistence.ts`, which deliberately persists `diff://unstaged/...` while
 * refusing `diff://commit/...`. Keep the two separate.
 */
export const VIRTUAL_SCHEMES = ['diff://', 'auth://', 'search://'] as const;

export function isVirtualPath(path: string): boolean {
  return VIRTUAL_SCHEMES.some((scheme) => path.startsWith(scheme));
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `bun test src/utils/virtual-path.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Route the three `workspace.ts` sites through it**

Add `import { isVirtualPath } from '../utils/virtual-path';` to `src/stores/workspace.ts`, then replace each of these:

- line 477: `if (file.path.startsWith('diff://') || file.path.startsWith('auth://')) continue;` → `if (isVirtualPath(file.path)) continue;`
- line 1256: `const isVirtual = path.startsWith('diff://') || path.startsWith('auth://');` → `const isVirtual = isVirtualPath(path);`
- line 1348: `if (path.startsWith('diff://') || path.startsWith('auth://')) return;` → `if (isVirtualPath(path)) return;`

- [ ] **Step 6: Add `search://` to the persistence predicate**

In `src/utils/persistence.ts`, extend the doc comment and the predicate — do **not** swap in `isVirtualPath`, because this function intentionally persists `diff://unstaged/...`:

```ts
export function shouldPersistTab(path: string): boolean {
  return (
    !path.startsWith('auth://') &&
    !path.startsWith('diff://commit/') &&
    // Search tabs hold a live query and streamed results, neither of which
    // survives a restart in any useful form.
    !path.startsWith('search://')
  );
}
```

Add to `src/utils/persistence.test.ts`, inside the existing `shouldPersistTab` describe block:

```ts
  it('never persists search tabs', () => {
    expect(shouldPersistTab('search://1')).toBe(false);
  });
```

- [ ] **Step 7: Verify and commit**

Run: `bun run verify`
Expected: PASS.

```bash
git add src/utils/virtual-path.ts src/utils/virtual-path.test.ts src/utils/persistence.ts src/utils/persistence.test.ts src/stores/workspace.ts
git commit -m "refactor: extract isVirtualPath, reserve the search:// scheme"
```

---

### Task 2: Session model

The store holds one global search. Two search tabs cannot share one `query` field, so the store becomes session-keyed. This task introduces the pure session reducers and rewires the store around a single default session — the existing `SearchPanel` keeps working, unchanged, throughout.

**Files:**
- Create: `src/features/search/services/search-session.ts`
- Create: `src/features/search/services/search-session.test.ts`
- Modify: `src/features/search/index.ts`
- Modify: `src/stores/search.ts`

**Interfaces:**
- Consumes: `StreamState`, `applyBatch`, `applyComplete` from `search-model.ts` (unchanged).
- Produces: `SearchSession`, `SearchOptionsState`, `createSession(id)`, `sessionForSearchId(sessions, searchId)`, `patchSession(sessions, id, patch)`.

- [ ] **Step 1: Write the failing test**

Create `src/features/search/services/search-session.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import {
  createSession,
  patchSession,
  sessionForSearchId,
} from './search-session';

describe('createSession', () => {
  it('starts empty, idle, and with default options', () => {
    const s = createSession('search://1');
    expect(s.id).toBe('search://1');
    expect(s.query).toBe('');
    expect(s.results).toEqual([]);
    expect(s.isSearching).toBe(false);
    expect(s.activeSearchId).toBeNull();
    expect(s.isRegex).toBe(false);
    expect(s.caseSensitive).toBe(false);
    expect(s.wholeWord).toBe(false);
    expect(s.includeIgnored).toBe(false);
    expect(s.history).toEqual([]);
  });
});

describe('patchSession', () => {
  it('replaces only the named session and leaves the others by reference', () => {
    const a = createSession('search://1');
    const b = createSession('search://2');
    const sessions = { [a.id]: a, [b.id]: b };
    const next = patchSession(sessions, 'search://1', { query: 'foo' });
    expect(next['search://1'].query).toBe('foo');
    expect(next['search://2']).toBe(b);
  });

  it('returns the same object when the session is unknown', () => {
    const sessions = { 'search://1': createSession('search://1') };
    expect(patchSession(sessions, 'search://9', { query: 'x' })).toBe(sessions);
  });
});

describe('sessionForSearchId', () => {
  it('finds the session tracking a given backend search id', () => {
    const sessions = {
      'search://1': { ...createSession('search://1'), activeSearchId: 7 },
      'search://2': { ...createSession('search://2'), activeSearchId: 9 },
    };
    expect(sessionForSearchId(sessions, 9)?.id).toBe('search://2');
  });

  it('returns null for an id no session is tracking (a superseded run)', () => {
    const sessions = {
      'search://1': { ...createSession('search://1'), activeSearchId: 7 },
    };
    expect(sessionForSearchId(sessions, 4)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test src/features/search/services/search-session.test.ts`
Expected: FAIL — cannot resolve `./search-session`.

- [ ] **Step 3: Implement**

Create `src/features/search/services/search-session.ts`:

```ts
// One search tab's complete state. Kept free of Zustand/Tauri so the
// reducers are directly bun-testable, exactly like search-model.ts.
import type { FileSearchResult } from '../../../types';
import type { StreamState } from './search-model';

export interface SearchOptionsState {
  isRegex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  /** Search files excluded by .gitignore. Off matches the previous
   *  behaviour, where gitignored files were unsearchable with no override. */
  includeIgnored: boolean;
  includePattern: string;
  excludePattern: string;
}

export interface SearchSession extends StreamState, SearchOptionsState {
  /** Equals the owning tab's path, e.g. `search://1`. */
  id: string;
  query: string;
  searchError: string | null;
  /** Most-recent-first, capped at HISTORY_LIMIT by pushQuery (Task 7). */
  history: string[];
  /** -1 = the input holds a live (unsubmitted) query. */
  historyIndex: number;
  collapsedFiles: string[];
  /** Excerpt id -> extra context lines revealed above/below. */
  expanded: Record<string, { up: number; down: number }>;
  activeExcerptId: string | null;
}

export type SearchSessions = Record<string, SearchSession>;

export function createSession(id: string): SearchSession {
  return {
    id,
    query: '',
    isRegex: false,
    caseSensitive: false,
    wholeWord: false,
    includeIgnored: false,
    includePattern: '',
    excludePattern: '',
    results: [] as FileSearchResult[],
    totalMatches: 0,
    fileCount: 0,
    truncated: false,
    isSearching: false,
    activeSearchId: null,
    receivedFirstBatch: false,
    searchError: null,
    history: [],
    historyIndex: -1,
    collapsedFiles: [],
    expanded: {},
    activeExcerptId: null,
  };
}

/**
 * Immutably updates one session. Unknown id returns the SAME object by
 * reference so a zustand `setState` can skip the update entirely — the same
 * stale-event discipline `applyBatch` uses.
 */
export function patchSession(
  sessions: SearchSessions,
  id: string,
  patch: Partial<SearchSession>,
): SearchSessions {
  const existing = sessions[id];
  if (!existing) return sessions;
  return { ...sessions, [id]: { ...existing, ...patch } };
}

/**
 * Which session, if any, is currently tracking `searchId`. Streamed batches
 * carry only the backend id, so this is how an event finds its tab. `null`
 * means the run was superseded or cancelled and the event must be dropped.
 */
export function sessionForSearchId(
  sessions: SearchSessions,
  searchId: number,
): SearchSession | null {
  for (const session of Object.values(sessions)) {
    if (session.activeSearchId === searchId) return session;
  }
  return null;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `bun test src/features/search/services/search-session.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Export from the barrel**

Add to `src/features/search/index.ts`:

```ts
export {
  createSession,
  patchSession,
  sessionForSearchId,
  type SearchSession,
  type SearchSessions,
  type SearchOptionsState,
} from './services/search-session';
```

- [ ] **Step 6: Rewire the store around sessions**

Rewrite `src/stores/search.ts` so state is `{ sessions: SearchSessions; activeSessionId: string }` plus actions taking a session id. Keep the existing streaming discipline exactly: listeners registered once, batches routed by id, empty query never reaching the backend.

```ts
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listenScoped } from '../utils/tauri-listener';
import {
  parseGlobList,
  applyBatch,
  applyComplete,
  createSession,
  patchSession,
  sessionForSearchId,
  type SearchSessions,
  type SearchSession,
  type StreamState,
  type SearchBatchPayload,
  type SearchCompletePayload,
} from '../features/search';
import { useProjectContextStore } from './project-context';
import { useWorkspaceStore } from './workspace';

interface SearchState {
  sessions: SearchSessions;
  activeSessionId: string;
  ensureSession: (id: string) => void;
  setActiveSession: (id: string) => void;
  update: (id: string, patch: Partial<SearchSession>) => void;
  search: (id: string, workspacePath: string) => Promise<void>;
  clearResults: (id: string) => void;
  closeSession: (id: string) => void;
}

const DEFAULT_SESSION_ID = 'search://1';

// Monotonic per window, per the backend contract: a higher id supersedes a
// lower one. Task 5 makes the backend cursor per-session so two tabs can run
// concurrently; the counter stays global because ids must stay unique.
let searchGeneration = 0;
let listenersPromise: Promise<void> | null = null;

function toStreamState(session: SearchSession): StreamState {
  return {
    results: session.results,
    totalMatches: session.totalMatches,
    fileCount: session.fileCount,
    truncated: session.truncated,
    isSearching: session.isSearching,
    activeSearchId: session.activeSearchId,
    receivedFirstBatch: session.receivedFirstBatch,
  };
}

function applyToSession(
  searchId: number,
  reduce: (state: StreamState) => StreamState,
) {
  useSearchStore.setState((current) => {
    const session = sessionForSearchId(current.sessions, searchId);
    if (!session) return current;
    const before = toStreamState(session);
    const after = reduce(before);
    if (after === before) return current;
    return { sessions: patchSession(current.sessions, session.id, after) };
  });
}

function ensureListeners(): Promise<void> {
  if (!listenersPromise) {
    listenersPromise = Promise.all([
      listenScoped<SearchBatchPayload>('search-results-batch', (event) => {
        applyToSession(event.payload.searchId, (state) =>
          applyBatch(state, event.payload),
        );
      }),
      listenScoped<SearchCompletePayload>('search-complete', (event) => {
        applyToSession(event.payload.searchId, (state) =>
          applyComplete(state, event.payload),
        );
      }),
    ])
      .then(() => undefined)
      .catch((err) => {
        listenersPromise = null;
        throw err;
      });
  }
  return listenersPromise;
}

export const useSearchStore = create<SearchState>((set, get) => ({
  sessions: { [DEFAULT_SESSION_ID]: createSession(DEFAULT_SESSION_ID) },
  activeSessionId: DEFAULT_SESSION_ID,

  ensureSession: (id) =>
    set((s) => (s.sessions[id] ? s : { sessions: { ...s.sessions, [id]: createSession(id) } })),

  setActiveSession: (id) => set({ activeSessionId: id }),

  update: (id, patch) => set((s) => ({ sessions: patchSession(s.sessions, id, patch) })),

  search: async (id, workspacePath) => {
    const session = get().sessions[id];
    if (!session) return;
    // An empty pattern matches every line in the backend — never send one.
    if (!session.query) {
      get().clearResults(id);
      return;
    }

    const gen = ++searchGeneration;
    // Previous results stay visible until the first batch replaces them.
    set((s) => ({
      sessions: patchSession(s.sessions, id, {
        isSearching: true,
        activeSearchId: gen,
        receivedFirstBatch: false,
        searchError: null,
      }),
    }));

    try {
      // Must be attached before the invoke resolves — batches can arrive as
      // soon as the backend spawns its worker thread.
      await ensureListeners();

      const isUnity = useProjectContextStore.getState().isUnityProject;
      const assetsRootPath = useWorkspaceStore.getState().assetsRootPath;
      const searchRoot = isUnity && assetsRootPath ? assetsRootPath : workspacePath;

      await invoke('start_content_search', {
        searchId: gen,
        sessionId: id,
        options: {
          workspacePath: searchRoot,
          query: session.query,
          isRegex: session.isRegex,
          caseSensitive: session.caseSensitive,
          wholeWord: session.wholeWord,
          includePatterns: parseGlobList(session.includePattern),
          excludePatterns: parseGlobList(session.excludePattern),
          includeIgnored: session.includeIgnored,
          contextLines: null,
          fileExtensions: null,
          maxTotalMatches: null,
          maxMatchesPerFile: null,
        },
      });
    } catch (err) {
      if (get().sessions[id]?.activeSearchId === gen) {
        set((s) => ({
          sessions: patchSession(s.sessions, id, {
            isSearching: false,
            searchError: err instanceof Error ? err.message : String(err),
          }),
        }));
      }
    }
  },

  clearResults: (id) => {
    const session = get().sessions[id];
    if (!session) return;
    if (session.isSearching) {
      const gen = ++searchGeneration;
      invoke('cancel_content_search', { searchId: gen, sessionId: id }).catch(() => {
        // Best-effort: late results arrive under a stale id and are dropped.
      });
    }
    set((s) => ({
      sessions: patchSession(s.sessions, id, {
        results: [],
        totalMatches: 0,
        fileCount: 0,
        truncated: false,
        isSearching: false,
        searchError: null,
        activeSearchId: null,
        receivedFirstBatch: false,
        activeExcerptId: null,
      }),
    }));
  },

  closeSession: (id) => {
    get().clearResults(id);
    set((s) => {
      const next = { ...s.sessions };
      delete next[id];
      const activeSessionId =
        s.activeSessionId === id ? (Object.keys(next)[0] ?? DEFAULT_SESSION_ID) : s.activeSessionId;
      if (!next[activeSessionId]) next[activeSessionId] = createSession(activeSessionId);
      return { sessions: next, activeSessionId };
    });
  },
}));

export { DEFAULT_SESSION_ID };
```

`sessionId`, `includeIgnored` and `contextLines` are sent here but not yet accepted by Rust — Tasks 3–5 add them. Implement those before running `check:invoke`, or run tasks 3–5 first; the plan orders them next for that reason.

- [ ] **Step 7: Point the existing panel at the active session**

In `src/features/search/components/SearchPanel.tsx`, replace the per-field selectors with a session read, leaving the rest of the component untouched:

```tsx
  const sessionId = useSearchStore((s) => s.activeSessionId);
  const session = useSearchStore((s) => s.sessions[s.activeSessionId]);
  const update = useSearchStore((s) => s.update);
  const search = useSearchStore((s) => s.search);
  const clearResults = useSearchStore((s) => s.clearResults);

  const { query, isRegex, caseSensitive, wholeWord, includePattern, excludePattern,
          results, totalMatches, fileCount, truncated, isSearching,
          activeSearchId, searchError } = session;

  const setQuery = (q: string) => update(sessionId, { query: q });
  const toggleRegex = () => update(sessionId, { isRegex: !isRegex });
  const toggleCaseSensitive = () => update(sessionId, { caseSensitive: !caseSensitive });
  const toggleWholeWord = () => update(sessionId, { wholeWord: !wholeWord });
  const setIncludePattern = (p: string) => update(sessionId, { includePattern: p });
  const setExcludePattern = (p: string) => update(sessionId, { excludePattern: p });
```

Then update the two call sites in the component body: `search(workspacePath)` → `search(sessionId, workspacePath)` and `clearResults()` → `clearResults(sessionId)`. This component is deleted in Task 12; it is kept working here so this task ships independently.

- [ ] **Step 8: Verify and commit**

Run: `bun test src && bunx tsc --noEmit`
Expected: PASS. (`check:invoke` will fail until Task 5 — that is why the full `verify` gate lands there.)

```bash
git add src/features/search src/stores/search.ts
git commit -m "refactor(search): make the search store session-keyed"
```

---

### Task 3: Context lines in the Rust searcher

`search_file` already receives the whole file as `content: &[u8]`, so context is a slice off a line index built from bytes already in hand — no `SearcherBuilder` context configuration and no sink rework.

**Files:**
- Modify: `src-tauri/src/search.rs` (`ContentSearchOptions`, `ContentSearchMatch`, `Engine`, `Engine::build`, `search_file`, `process_and_send`, `run_env_supplement`)
- Modify: `src/types/index.ts` (`SearchMatch`)

**Interfaces:**
- Consumes: nothing.
- Produces: `ContentSearchOptions.context_lines: Option<usize>`; `ContentSearchMatch.before: Vec<String>` / `.after: Vec<String>` (camelCase `before`/`after` on the wire); `search_file(searcher, matcher, path, content, max_matches_per_file, context_lines)`.

- [ ] **Step 1: Write the failing tests**

Add to the `mod tests` block at the bottom of `src-tauri/src/search.rs`. `search_one` is the existing helper; add a context-aware variant beside these tests:

```rust
    // ── search_file: context lines ──────────────────────────────────────

    fn search_one_ctx(m: &RegexMatcher, content: &str, context: usize) -> ContentFileResult {
        let mut searcher = build_searcher();
        search_file(&mut searcher, m, "/tmp/f", content.as_bytes(), 200, context)
    }

    #[test]
    fn context_lines_are_captured_both_sides() {
        let m = literal_matcher("needle", false, false);
        let r = search_one_ctx(&m, "a\nb\nneedle\nc\nd\n", 2);
        assert_eq!(r.matches.len(), 1);
        assert_eq!(r.matches[0].line_number, 3);
        assert_eq!(r.matches[0].before, vec!["a".to_string(), "b".to_string()]);
        assert_eq!(r.matches[0].after, vec!["c".to_string(), "d".to_string()]);
    }

    #[test]
    fn context_clamps_at_start_of_file() {
        let m = literal_matcher("needle", false, false);
        let r = search_one_ctx(&m, "needle\nb\nc\n", 2);
        assert!(r.matches[0].before.is_empty());
        assert_eq!(r.matches[0].after, vec!["b".to_string(), "c".to_string()]);
    }

    #[test]
    fn context_clamps_at_end_of_file() {
        let m = literal_matcher("needle", false, false);
        let r = search_one_ctx(&m, "a\nb\nneedle\n", 2);
        assert_eq!(r.matches[0].before, vec!["a".to_string(), "b".to_string()]);
        assert!(r.matches[0].after.is_empty());
    }

    #[test]
    fn context_strips_crlf_terminators() {
        let m = literal_matcher("needle", false, false);
        let r = search_one_ctx(&m, "a\r\nneedle\r\nc\r\n", 1);
        assert_eq!(r.matches[0].before, vec!["a".to_string()]);
        assert_eq!(r.matches[0].after, vec!["c".to_string()]);
    }

    #[test]
    fn zero_context_yields_no_context_lines() {
        let m = literal_matcher("needle", false, false);
        let r = search_one_ctx(&m, "a\nneedle\nc\n", 0);
        assert!(r.matches[0].before.is_empty());
        assert!(r.matches[0].after.is_empty());
    }

    #[test]
    fn context_lines_are_not_preview_trimmed() {
        // A long context line stays whole: trimming is a match-window concern,
        // and there is no match on a context line to centre a window on.
        let m = literal_matcher("needle", false, false);
        let long = "x".repeat(600);
        let content = format!("{}\nneedle\n", long);
        let r = search_one_ctx(&m, &content, 1);
        assert_eq!(r.matches[0].before[0].chars().count(), 600);
    }

    #[test]
    fn two_matches_on_adjacent_lines_each_carry_their_own_context() {
        let m = literal_matcher("needle", false, false);
        let r = search_one_ctx(&m, "a\nneedle\nneedle\nb\n", 1);
        assert_eq!(r.matches.len(), 2);
        assert_eq!(r.matches[0].after, vec!["needle".to_string()]);
        assert_eq!(r.matches[1].before, vec!["needle".to_string()]);
    }
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd src-tauri && cargo test --lib context`
Expected: FAIL to compile — `search_file` takes 5 arguments, `before`/`after` do not exist.

- [ ] **Step 3: Implement**

In `src-tauri/src/search.rs`:

Add to `ContentSearchOptions` (after `max_matches_per_file`):

```rust
    /// Lines of context to include either side of each match. `None` and an
    /// explicit JSON `null` both mean "use the default" — same `Option`
    /// treatment as `max_total_matches` above, and for the same reason.
    pub context_lines: Option<usize>,
```

Add to `ContentSearchMatch`:

```rust
    /// Up to `context_lines` lines immediately preceding `line_number`, in
    /// file order. Line terminators stripped; never preview-trimmed.
    pub before: Vec<String>,
    /// Up to `context_lines` lines immediately following `line_number`.
    pub after: Vec<String>,
```

Add the default and the line index near `default_max_total_matches`:

```rust
fn default_context_lines() -> usize {
    2
}

/// Byte ranges of each line in `content`, terminators excluded. Built once
/// per file and shared by every match in it.
fn line_ranges(content: &[u8]) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let mut start = 0usize;
    for (i, b) in content.iter().enumerate() {
        if *b == b'\n' {
            let mut end = i;
            if end > start && content[end - 1] == b'\r' {
                end -= 1;
            }
            ranges.push((start, end));
            start = i + 1;
        }
    }
    if start < content.len() {
        ranges.push((start, content.len()));
    }
    ranges
}

/// `count` lines of context on one side of `line_number` (1-based). Clamped
/// at both file boundaries. Invalid UTF-8 lines are skipped rather than
/// lossily converted, matching how the searcher already ends a file's scan on
/// an encoding error.
fn context_lines_at(
    content: &[u8],
    ranges: &[(usize, usize)],
    line_number: usize,
    count: usize,
    before: bool,
) -> Vec<String> {
    if count == 0 || line_number == 0 {
        return Vec::new();
    }
    let idx = line_number - 1;
    let (lo, hi) = if before {
        (idx.saturating_sub(count), idx)
    } else {
        ((idx + 1).min(ranges.len()), (idx + 1 + count).min(ranges.len()))
    };
    ranges[lo..hi]
        .iter()
        .filter_map(|(s, e)| std::str::from_utf8(&content[*s..*e]).ok().map(str::to_string))
        .collect()
}
```

Change `search_file`'s signature and body. Add the parameter:

```rust
pub fn search_file(
    searcher: &mut Searcher,
    matcher: &RegexMatcher,
    path: &str,
    content: &[u8],
    max_matches_per_file: usize,
    context_lines: usize,
) -> ContentFileResult {
```

Immediately after `let mut truncated = false;` add:

```rust
    // Built once per file; empty when context is off so a zero-context search
    // pays nothing for this.
    let ranges = if context_lines > 0 {
        line_ranges(content)
    } else {
        Vec::new()
    };
```

and in the `matches.push(...)` call add the two fields:

```rust
            matches.push(ContentSearchMatch {
                line_number: line_number as usize,
                line_content: display,
                match_start: ms16,
                match_end: me16,
                line_start: line_start16,
                before: context_lines_at(content, &ranges, line_number as usize, context_lines, true),
                after: context_lines_at(content, &ranges, line_number as usize, context_lines, false),
            });
```

Add `context_lines: usize` to `struct Engine`, and in `Engine::build` resolve it:

```rust
            context_lines: options.context_lines.unwrap_or_else(default_context_lines),
```

Finally pass it at both `search_file` call sites — in `process_and_send` and anywhere else `cargo` reports — as `engine.context_lines`.

- [ ] **Step 4: Fix the existing tests' call sites**

Every existing `search_file(...)` call in `mod tests` now needs a sixth argument. Pass `0` so those tests keep asserting exactly what they asserted before.

Run: `cd src-tauri && cargo test --lib`
Expected: PASS, including the 7 new context tests.

- [ ] **Step 5: Widen the frontend type**

In `src/types/index.ts`, add to `SearchMatch`:

```ts
  /** Context lines immediately preceding `lineNumber`, in file order.
   *  Absent when the search ran with zero context. */
  before?: string[];
  /** Context lines immediately following `lineNumber`. */
  after?: string[];
```

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/search.rs src/types/index.ts
git commit -m "feat(search): return context lines around each match"
```

---

### Task 4: `includeIgnored` option

Gitignored files are currently unsearchable with no override. `walk_policy` gains an options struct rather than a second entry point, so the explorer and quick-open callers cannot drift.

**Files:**
- Modify: `src-tauri/src/walk_policy.rs`
- Modify: `src-tauri/src/search.rs` (`ContentSearchOptions`, `Engine`, `run_walk`)

**Interfaces:**
- Consumes: `ContentSearchOptions` from Task 3.
- Produces: `walk_policy::WalkOptions { include_ignored: bool }`, `walk_policy::policy_walker_with(root, opts)`; `policy_walker(root)` retained as the default-options wrapper.

- [ ] **Step 1: Write the failing test**

Add to `src-tauri/src/walk_policy.rs`'s test module (create `mod tests` at the bottom if absent):

```rust
#[cfg(test)]
mod include_ignored_tests {
    use super::*;
    use std::fs;

    fn fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join(".gitignore"), "secret.txt\n").unwrap();
        fs::write(root.join("secret.txt"), "hidden").unwrap();
        fs::write(root.join("plain.txt"), "visible").unwrap();
        // `ignore` only applies .gitignore inside a git repo.
        fs::create_dir(root.join(".git")).unwrap();
        dir
    }

    fn walked_names(root: &str, opts: WalkOptions) -> Vec<String> {
        policy_walker_with(root, opts)
            .build()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect()
    }

    #[test]
    fn gitignored_file_is_skipped_by_default() {
        let dir = fixture();
        let names = walked_names(dir.path().to_str().unwrap(), WalkOptions::default());
        assert!(names.contains(&"plain.txt".to_string()));
        assert!(!names.contains(&"secret.txt".to_string()));
    }

    #[test]
    fn include_ignored_reveals_the_gitignored_file() {
        let dir = fixture();
        let names = walked_names(
            dir.path().to_str().unwrap(),
            WalkOptions { include_ignored: true },
        );
        assert!(names.contains(&"secret.txt".to_string()));
    }

    #[test]
    fn always_hidden_entries_stay_hidden_even_with_include_ignored() {
        let dir = fixture();
        let names = walked_names(
            dir.path().to_str().unwrap(),
            WalkOptions { include_ignored: true },
        );
        assert!(!names.iter().any(|n| n == ".DS_Store"));
    }
}
```

If `tempfile` is not already a dev-dependency, add `tempfile = "3"` under `[dev-dependencies]` in `src-tauri/Cargo.toml`. Check first — other tests in this crate may already use it.

- [ ] **Step 2: Run and watch it fail**

Run: `cd src-tauri && cargo test --lib include_ignored`
Expected: FAIL to compile — `WalkOptions` / `policy_walker_with` do not exist.

- [ ] **Step 3: Implement**

In `src-tauri/src/walk_policy.rs`:

```rust
/// Per-call overrides to the D3 walk policy.
#[derive(Debug, Clone, Copy, Default)]
pub struct WalkOptions {
    /// Walk files excluded by .gitignore / global gitignore / .git/info/exclude.
    /// `ALWAYS_HIDDEN` is unaffected — `.git` and `.DS_Store` stay hidden.
    pub include_ignored: bool,
}

pub fn policy_walker_with(root: &str, opts: WalkOptions) -> WalkBuilder {
    let mut builder = WalkBuilder::new(root);
    let respect_ignore = !opts.include_ignored;
    builder
        .hidden(false)
        .git_ignore(respect_ignore)
        .git_global(respect_ignore)
        .git_exclude(respect_ignore)
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            !is_always_hidden(&name)
        });
    builder
}

/// The default policy: gitignore respected. Existing callers (explorer tree,
/// quick-open, file index) keep this behaviour untouched.
pub fn policy_walker(root: &str) -> WalkBuilder {
    policy_walker_with(root, WalkOptions::default())
}
```

In `src-tauri/src/search.rs`: add `#[serde(default)] pub include_ignored: bool,` to `ContentSearchOptions`, add `include_ignored: bool` to `Engine`, set it in `Engine::build` from `options.include_ignored`, and in `run_walk` swap the walker construction to:

```rust
    let walker = walk_policy::policy_walker_with(
        &engine.workspace_path,
        walk_policy::WalkOptions { include_ignored: engine.include_ignored },
    )
    .threads(engine.threads)
    .build_parallel();
```

- [ ] **Step 4: Run and watch it pass**

Run: `cd src-tauri && cargo test --lib`
Expected: PASS — the three new tests plus every existing walk_policy and search test.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/walk_policy.rs src-tauri/src/search.rs src-tauri/Cargo.toml
git commit -m "feat(search): add includeIgnored to content search"
```

---

### Task 5: Per-session cancellation cursor

The cancellation cursor is keyed by window label, so a search started in one tab silently truncates a search still running in another — partial results, no error, exactly the failure class this repo keeps hitting. Keying the cursor by window **and** session makes tabs independent.

**Files:**
- Modify: `src-tauri/src/search.rs` (`ContentSearchState`, `start_content_search`, `cancel_content_search`)

**Interfaces:**
- Consumes: nothing.
- Produces: `start_content_search(app, state, window, search_id, session_id, options)` and `cancel_content_search(state, window, search_id, session_id)` — frontend payloads gain `sessionId: string`.

- [ ] **Step 1: Write the failing tests**

Add to `mod tests` in `src-tauri/src/search.rs`:

```rust
    #[test]
    fn cursors_are_independent_per_session() {
        let state = ContentSearchState::new();
        let a = state.cursor("main", "search://1");
        let b = state.cursor("main", "search://2");
        a.store(5, Ordering::SeqCst);
        assert_eq!(b.load(Ordering::SeqCst), 0, "sessions must not share a cursor");
    }

    #[test]
    fn same_session_returns_the_same_cursor() {
        let state = ContentSearchState::new();
        let a = state.cursor("main", "search://1");
        a.store(7, Ordering::SeqCst);
        assert_eq!(state.cursor("main", "search://1").load(Ordering::SeqCst), 7);
    }

    #[test]
    fn drop_window_clears_every_session_of_that_window_only() {
        let state = ContentSearchState::new();
        state.cursor("main", "search://1").store(3, Ordering::SeqCst);
        state.cursor("other", "search://1").store(4, Ordering::SeqCst);
        state.drop_window("main");
        assert_eq!(state.cursor("main", "search://1").load(Ordering::SeqCst), 0);
        assert_eq!(state.cursor("other", "search://1").load(Ordering::SeqCst), 4);
    }

    #[test]
    fn options_deserialize_from_the_frontend_payload_verbatim() {
        // Raw JSON, exactly as stores/search.ts sends it. A typed test would
        // not have caught the `null` vs missing-key distinction that bit
        // max_total_matches, so this asserts against the literal payload.
        let json = r#"{
            "workspacePath": "/w",
            "query": "foo",
            "isRegex": false,
            "caseSensitive": false,
            "wholeWord": false,
            "includePatterns": [],
            "excludePatterns": [],
            "includeIgnored": true,
            "contextLines": null,
            "fileExtensions": null,
            "maxTotalMatches": null,
            "maxMatchesPerFile": null
        }"#;
        let opts: ContentSearchOptions = serde_json::from_str(json).expect("payload must deserialize");
        assert_eq!(opts.query, "foo");
        assert!(opts.include_ignored);
        assert_eq!(opts.context_lines, None);
        let engine = Engine::build(&opts).expect("engine must build");
        assert_eq!(engine.context_lines, 2, "null contextLines resolves to the default");
    }
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd src-tauri && cargo test --lib cursors_are_independent`
Expected: FAIL to compile — `cursor` takes one argument.

- [ ] **Step 3: Implement**

In `src-tauri/src/search.rs`, change the cursor key from `label` to a composite. The map type and the existing `lock_recover` poisoning behaviour stay exactly as they are — only the key derivation changes:

```rust
/// Key for the per-run cancellation cursor: window label AND session id.
/// Keying by window alone let a search in one tab supersede a search still
/// running in another, truncating it to partial results with no error and no
/// sign anything was cut short. NUL is the separator because it cannot occur
/// in a window label or a `search://n` id.
fn cursor_key(label: &str, session_id: &str) -> String {
    format!("{}\u{0}{}", label, session_id)
}

impl ContentSearchState {
    /// Returns this window+session's cancellation cursor, creating a fresh
    /// `Arc<AtomicU64>` (starting at 0) the first time the pair is seen. The
    /// returned `Arc` is cloned into the search's worker/emitter threads so
    /// `cancel_content_search`, or a newer `start_content_search` for the
    /// same pair, can advance it out from under them.
    pub fn cursor(&self, label: &str, session_id: &str) -> Arc<AtomicU64> {
        let mut map = lock_recover(&self.0);
        map.entry(cursor_key(label, session_id)).or_default().clone()
    }

    /// Drop every session cursor belonging to this window. Called from
    /// `WindowEvent::Destroyed` cleanup in `lib.rs` — idempotent, and a no-op
    /// if the window never started a search. In-flight workers hold their own
    /// `Arc` clone, so this does not cancel them; it only stops the entries
    /// occupying the map after the window is gone.
    pub fn drop_window(&self, label: &str) {
        let prefix = format!("{}\u{0}", label);
        let mut map = lock_recover(&self.0);
        map.retain(|k, _| !k.starts_with(&prefix));
    }
}
```

Then thread `session_id: String` through both commands:

```rust
#[tauri::command(async)]
pub fn start_content_search(
    app: AppHandle,
    state: State<'_, ContentSearchState>,
    window: Window,
    search_id: u64,
    session_id: String,
    options: ContentSearchOptions,
) -> Result<(), String> {
```

with the body's `state.cursor(window.label())` becoming `state.cursor(window.label(), &session_id)`, and the same for:

```rust
#[tauri::command]
pub fn cancel_content_search(
    state: State<'_, ContentSearchState>,
    window: Window,
    search_id: u64,
    session_id: String,
) {
```

- [ ] **Step 4: Run and watch it pass**

Run: `cd src-tauri && cargo test --lib`
Expected: PASS.

- [ ] **Step 5: Run the full gate — this is where Task 2's payload becomes valid**

Run: `bun run verify`
Expected: PASS, including `check:invoke` (which was failing since Task 2 because `sessionId`, `includeIgnored` and `contextLines` had no Rust counterpart).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/search.rs
git commit -m "fix(search): key the cancellation cursor per session, not per window"
```

---

### Task 6: `excerpt-model` — matches to merged excerpts

The piece that makes results read like a file rather than a list: two matches four lines apart become one continuous excerpt instead of two boxes repeating the same code.

**Files:**
- Create: `src/features/search/services/excerpt-model.ts`
- Create: `src/features/search/services/excerpt-model.test.ts`
- Modify: `src/features/search/index.ts`

**Interfaces:**
- Consumes: `FileSearchResult`, `SearchMatch` from `src/types`.
- Produces: `ExcerptLine`, `Excerpt`, `buildExcerpts(file)`, `excerptId(filePath, startLine)`, `applyExpansion(excerpt, fileLines, expansion)`.

- [ ] **Step 1: Write the failing test**

Create `src/features/search/services/excerpt-model.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { buildExcerpts, applyExpansion, excerptId } from './excerpt-model';
import type { FileSearchResult } from '../../../types';

function match(lineNumber: number, lineContent: string, before: string[] = [], after: string[] = []) {
  return {
    lineNumber,
    lineContent,
    matchStart: 0,
    matchEnd: 3,
    lineStart: 0,
    before,
    after,
  };
}

describe('buildExcerpts', () => {
  it('turns one match into one excerpt spanning its context', () => {
    const file: FileSearchResult = {
      path: '/w/a.ts',
      matches: [match(3, 'hit', ['a', 'b'], ['c', 'd'])],
    };
    const [ex] = buildExcerpts(file);
    expect(ex.startLine).toBe(1);
    expect(ex.endLine).toBe(5);
    expect(ex.lines.map((l) => l.text)).toEqual(['a', 'b', 'hit', 'c', 'd']);
    expect(ex.lines[2].matches).toEqual([{ start: 0, end: 3 }]);
    expect(ex.matchCount).toBe(1);
  });

  it('merges matches whose context windows overlap into one excerpt', () => {
    const file: FileSearchResult = {
      path: '/w/a.ts',
      matches: [
        match(3, 'hit', ['a', 'b'], ['c', 'd']),
        match(6, 'hit', ['d', 'e'], ['g', 'h']),
      ],
    };
    const excerpts = buildExcerpts(file);
    expect(excerpts).toHaveLength(1);
    expect(excerpts[0].startLine).toBe(1);
    expect(excerpts[0].endLine).toBe(8);
    expect(excerpts[0].matchCount).toBe(2);
    // Line 5 came from both windows and must appear exactly once.
    expect(excerpts[0].lines.filter((l) => l.lineNumber === 5)).toHaveLength(1);
  });

  it('keeps distant matches as separate excerpts', () => {
    const file: FileSearchResult = {
      path: '/w/a.ts',
      matches: [match(3, 'hit', ['a', 'b'], ['c', 'd']), match(40, 'hit', ['x'], ['y'])],
    };
    const excerpts = buildExcerpts(file);
    expect(excerpts).toHaveLength(2);
    expect(excerpts[1].startLine).toBe(39);
  });

  it('folds two matches on the same line into one line with two ranges', () => {
    const file: FileSearchResult = {
      path: '/w/a.ts',
      matches: [
        { ...match(3, 'hit and hit'), matchStart: 0, matchEnd: 3 },
        { ...match(3, 'hit and hit'), matchStart: 8, matchEnd: 11 },
      ],
    };
    const [ex] = buildExcerpts(file);
    expect(ex.lines.filter((l) => l.lineNumber === 3)).toHaveLength(1);
    expect(ex.lines.find((l) => l.lineNumber === 3)!.matches).toEqual([
      { start: 0, end: 3 },
      { start: 8, end: 11 },
    ]);
    expect(ex.matchCount).toBe(2);
  });

  it('drops highlight ranges from a differently-trimmed window but still counts the match', () => {
    // A long line trimmed around each match yields different lineStart values;
    // the two windows show different text, so only the first can be rendered.
    const file: FileSearchResult = {
      path: '/w/a.ts',
      matches: [
        { ...match(3, 'window-one'), lineStart: 0, matchStart: 0, matchEnd: 3 },
        { ...match(3, 'window-two'), lineStart: 400, matchStart: 2, matchEnd: 5 },
      ],
    };
    const [ex] = buildExcerpts(file);
    const line = ex.lines.find((l) => l.lineNumber === 3)!;
    expect(line.text).toBe('window-one');
    expect(line.matches).toEqual([{ start: 0, end: 3 }]);
    expect(ex.matchCount).toBe(2);
  });

  it('handles a match with no context at all', () => {
    const file: FileSearchResult = { path: '/w/a.ts', matches: [match(1, 'hit')] };
    const [ex] = buildExcerpts(file);
    expect(ex.startLine).toBe(1);
    expect(ex.endLine).toBe(1);
    expect(ex.lines).toHaveLength(1);
  });
});

describe('excerptId', () => {
  it('is stable for a file and start line', () => {
    expect(excerptId('/w/a.ts', 12)).toBe('/w/a.ts:12');
  });
});

describe('applyExpansion', () => {
  const fileLines = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7'];

  it('reveals lines above and below from the real file', () => {
    const file: FileSearchResult = { path: '/w/a.ts', matches: [match(4, 'l4')] };
    const [ex] = buildExcerpts(file);
    const grown = applyExpansion(ex, fileLines, { up: 2, down: 1 });
    expect(grown.startLine).toBe(2);
    expect(grown.endLine).toBe(5);
    expect(grown.lines.map((l) => l.text)).toEqual(['l2', 'l3', 'l4', 'l5']);
  });

  it('clamps at both file boundaries', () => {
    const file: FileSearchResult = { path: '/w/a.ts', matches: [match(1, 'l1')] };
    const [ex] = buildExcerpts(file);
    const grown = applyExpansion(ex, fileLines, { up: 5, down: 99 });
    expect(grown.startLine).toBe(1);
    expect(grown.endLine).toBe(7);
  });

  it('preserves match highlight ranges on the match line', () => {
    const file: FileSearchResult = { path: '/w/a.ts', matches: [match(4, 'l4')] };
    const [ex] = buildExcerpts(file);
    const grown = applyExpansion(ex, fileLines, { up: 1, down: 0 });
    expect(grown.lines.find((l) => l.lineNumber === 4)!.matches).toEqual([{ start: 0, end: 3 }]);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `bun test src/features/search/services/excerpt-model.test.ts`
Expected: FAIL — cannot resolve `./excerpt-model`.

- [ ] **Step 3: Implement**

Create `src/features/search/services/excerpt-model.ts`:

```ts
// Folds a file's flat match list into the excerpt ranges the results tab
// renders. Pure — no Monaco, no store, no Tauri — so it is bun-testable.
import type { FileSearchResult, SearchMatch } from '../../../types';

export interface MatchRange {
  /** UTF-16 offset within the line's rendered `text`. */
  start: number;
  end: number;
}

export interface ExcerptLine {
  /** 1-based line number in the real file. */
  lineNumber: number;
  text: string;
  /** Empty for pure context lines. */
  matches: MatchRange[];
}

export interface Excerpt {
  /** `${filePath}:${startLine}` — stable across re-renders of one result set. */
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  lines: ExcerptLine[];
  /** Matches inside this excerpt, including any whose highlight could not be
   *  rendered (see the trimming note in `buildExcerpts`). */
  matchCount: number;
}

export interface Expansion {
  up: number;
  down: number;
}

export function excerptId(filePath: string, startLine: number): string {
  return `${filePath}:${startLine}`;
}

interface Window {
  start: number;
  end: number;
  /** lineNumber -> text, from context lines and match lines alike. */
  text: Map<number, string>;
  /** lineNumber -> highlight ranges. */
  ranges: Map<number, MatchRange[]>;
  /** lineNumber -> the lineStart the rendered text belongs to. */
  origin: Map<number, number>;
  matchCount: number;
}

function windowFor(match: SearchMatch): Window {
  const before = match.before ?? [];
  const after = match.after ?? [];
  const start = match.lineNumber - before.length;
  const end = match.lineNumber + after.length;

  const text = new Map<number, string>();
  before.forEach((line, i) => text.set(start + i, line));
  text.set(match.lineNumber, match.lineContent);
  after.forEach((line, i) => text.set(match.lineNumber + 1 + i, line));

  return {
    start,
    end,
    text,
    ranges: new Map([[match.lineNumber, [{ start: match.matchStart, end: match.matchEnd }]]]),
    origin: new Map([[match.lineNumber, match.lineStart ?? 0]]),
    matchCount: 1,
  };
}

function absorb(target: Window, next: Window): void {
  target.start = Math.min(target.start, next.start);
  target.end = Math.max(target.end, next.end);
  target.matchCount += next.matchCount;

  for (const [lineNumber, text] of next.text) {
    if (!target.text.has(lineNumber)) target.text.set(lineNumber, text);
  }
  for (const [lineNumber, ranges] of next.ranges) {
    const incomingOrigin = next.origin.get(lineNumber) ?? 0;
    const existingOrigin = target.origin.get(lineNumber);
    if (existingOrigin === undefined) {
      target.origin.set(lineNumber, incomingOrigin);
      target.ranges.set(lineNumber, [...ranges]);
      continue;
    }
    // A long line is preview-trimmed around each match independently, so two
    // matches on one line can describe DIFFERENT windows of that line. Only
    // ranges from the window whose text we are actually rendering can be
    // highlighted; the rest stay in matchCount so the tally is still honest.
    if (existingOrigin === incomingOrigin) {
      target.ranges.get(lineNumber)!.push(...ranges);
    }
  }
}

/**
 * Builds this file's excerpts, merging matches whose context windows touch or
 * overlap so adjacent hits render as one continuous run of code rather than
 * two boxes repeating the same lines. Input order is assumed ascending by
 * line, which is the order the backend's sink emits.
 */
export function buildExcerpts(file: FileSearchResult): Excerpt[] {
  const windows: Window[] = [];
  for (const match of file.matches) {
    const next = windowFor(match);
    const current = windows[windows.length - 1];
    // `<= current.end + 1` merges touching windows too, not just overlapping
    // ones — a one-line gap between excerpts is noise, not separation.
    if (current && next.start <= current.end + 1) {
      absorb(current, next);
    } else {
      windows.push(next);
    }
  }

  return windows.map((w) => {
    const lines: ExcerptLine[] = [];
    for (let lineNumber = w.start; lineNumber <= w.end; lineNumber++) {
      const text = w.text.get(lineNumber);
      if (text === undefined) continue;
      lines.push({ lineNumber, text, matches: w.ranges.get(lineNumber) ?? [] });
    }
    return {
      id: excerptId(file.path, w.start),
      filePath: file.path,
      startLine: w.start,
      endLine: w.end,
      lines,
      matchCount: w.matchCount,
    };
  });
}

/**
 * Re-renders an excerpt with `up`/`down` extra lines taken from the real file
 * contents, clamped at both boundaries. Highlight ranges on existing lines are
 * preserved; revealed lines are pure context.
 */
export function applyExpansion(
  excerpt: Excerpt,
  fileLines: string[],
  expansion: Expansion,
): Excerpt {
  const startLine = Math.max(1, excerpt.startLine - expansion.up);
  const endLine = Math.min(fileLines.length, excerpt.endLine + expansion.down);

  const existing = new Map(excerpt.lines.map((l) => [l.lineNumber, l]));
  const lines: ExcerptLine[] = [];
  for (let lineNumber = startLine; lineNumber <= endLine; lineNumber++) {
    const known = existing.get(lineNumber);
    lines.push(
      known ?? { lineNumber, text: fileLines[lineNumber - 1] ?? '', matches: [] },
    );
  }

  return { ...excerpt, startLine, endLine, lines };
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `bun test src/features/search/services/excerpt-model.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Export and commit**

Add to `src/features/search/index.ts`:

```ts
export {
  buildExcerpts,
  applyExpansion,
  excerptId,
  type Excerpt,
  type ExcerptLine,
  type MatchRange,
  type Expansion,
} from './services/excerpt-model';
```

```bash
git add src/features/search
git commit -m "feat(search): fold matches into merged excerpt ranges"
```

---

### Task 7: Query history and search settings

**Files:**
- Create: `src/features/search/services/query-history.ts`
- Create: `src/features/search/services/query-history.test.ts`
- Modify: `src/features/search/index.ts`
- Modify: `src/types/index.ts` (`SettingsSchema`)
- Modify: `src/stores/settings.ts` (`DEFAULT_SETTINGS`)

**Interfaces:**
- Consumes: nothing.
- Produces: `pushQuery(history, query)`, `historyStep(history, index, direction)`, `HISTORY_LIMIT`, `resolveCaseSensitive(query, caseSensitive, useSmartcase)`.

- [ ] **Step 1: Write the failing test**

Create `src/features/search/services/query-history.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { pushQuery, historyStep, resolveCaseSensitive, HISTORY_LIMIT } from './query-history';

describe('pushQuery', () => {
  it('adds the newest query at the front', () => {
    expect(pushQuery(['b'], 'a')).toEqual(['a', 'b']);
  });

  it('moves a repeated query to the front instead of duplicating it', () => {
    expect(pushQuery(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b']);
  });

  it('ignores empty and whitespace-only queries', () => {
    expect(pushQuery(['a'], '')).toEqual(['a']);
    expect(pushQuery(['a'], '   ')).toEqual(['a']);
  });

  it('caps at HISTORY_LIMIT', () => {
    const full = Array.from({ length: HISTORY_LIMIT }, (_, i) => `q${i}`);
    const next = pushQuery(full, 'new');
    expect(next).toHaveLength(HISTORY_LIMIT);
    expect(next[0]).toBe('new');
    expect(next).not.toContain(`q${HISTORY_LIMIT - 1}`);
  });
});

describe('historyStep', () => {
  const history = ['a', 'b', 'c'];

  it('walks back from the live query into the history', () => {
    expect(historyStep(history, -1, 'back')).toEqual({ index: 0, query: 'a' });
    expect(historyStep(history, 0, 'back')).toEqual({ index: 1, query: 'b' });
  });

  it('stops at the oldest entry', () => {
    expect(historyStep(history, 2, 'back')).toEqual({ index: 2, query: 'c' });
  });

  it('walks forward and returns to the live query', () => {
    expect(historyStep(history, 1, 'forward')).toEqual({ index: 0, query: 'a' });
    expect(historyStep(history, 0, 'forward')).toEqual({ index: -1, query: '' });
  });

  it('does nothing when the history is empty', () => {
    expect(historyStep([], -1, 'back')).toBeNull();
  });
});

describe('resolveCaseSensitive', () => {
  it('honours the explicit toggle regardless of smartcase', () => {
    expect(resolveCaseSensitive('foo', true, true)).toBe(true);
  });

  it('goes case-sensitive for a query containing uppercase when smartcase is on', () => {
    expect(resolveCaseSensitive('Foo', false, true)).toBe(true);
  });

  it('stays insensitive for an all-lowercase query when smartcase is on', () => {
    expect(resolveCaseSensitive('foo', false, true)).toBe(false);
  });

  it('ignores case entirely when smartcase is off', () => {
    expect(resolveCaseSensitive('Foo', false, false)).toBe(false);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `bun test src/features/search/services/query-history.test.ts`
Expected: FAIL — cannot resolve `./query-history`.

- [ ] **Step 3: Implement**

Create `src/features/search/services/query-history.ts`:

```ts
/** Matches Zed's BufferSearchBar, which keeps up to 50 previous queries. */
export const HISTORY_LIMIT = 50;

export function pushQuery(history: string[], query: string): string[] {
  if (!query.trim()) return history;
  return [query, ...history.filter((entry) => entry !== query)].slice(0, HISTORY_LIMIT);
}

export interface HistoryPosition {
  /** -1 means the input is back on the live, unsubmitted query. */
  index: number;
  query: string;
}

/**
 * Moves through the history ring. `index` is the current position (-1 = live
 * query); `back` walks toward older entries, `forward` toward newer and
 * finally back out to the live query. Returns `null` when there is nothing to
 * move to, so the caller can leave the input untouched.
 */
export function historyStep(
  history: string[],
  index: number,
  direction: 'back' | 'forward',
): HistoryPosition | null {
  if (history.length === 0) return null;

  if (direction === 'back') {
    const next = Math.min(index + 1, history.length - 1);
    return { index: next, query: history[next] };
  }

  const next = index - 1;
  if (next < 0) return { index: -1, query: '' };
  return { index: next, query: history[next] };
}

/**
 * Smartcase: an all-lowercase query searches case-insensitively, a query
 * containing an uppercase letter goes case-sensitive on its own. The explicit
 * `Aa` toggle always wins.
 */
export function resolveCaseSensitive(
  query: string,
  caseSensitive: boolean,
  useSmartcase: boolean,
): boolean {
  if (caseSensitive) return true;
  if (!useSmartcase) return false;
  return query !== query.toLowerCase();
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `bun test src/features/search/services/query-history.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Add the settings keys**

In `src/types/index.ts`, add to `SettingsSchema` beside the other feature keys:

```ts
  /** Lines of context rendered either side of a match in the search tab. */
  'search.contextLines': number;
  /** Populate a new search from the editor's selection / word under cursor. */
  'search.seedQueryFromCursor': 'selection' | 'always' | 'never';
  /** Lowercase query = case-insensitive; any uppercase = case-sensitive. */
  'search.useSmartcase': boolean;
```

In `src/stores/settings.ts`, add to `DEFAULT_SETTINGS`:

```ts
  'search.contextLines': 2,
  'search.seedQueryFromCursor': 'selection',
  'search.useSmartcase': true,
```

- [ ] **Step 6: Wire `contextLines` and smartcase into the search invoke**

In `src/stores/search.ts`'s `search` action, replace the two hardcoded values:

```ts
      const settings = useSettingsStore.getState().settings;
      const caseSensitive = resolveCaseSensitive(
        session.query,
        session.caseSensitive,
        settings['search.useSmartcase'],
      );
```

pass `caseSensitive` in place of `session.caseSensitive`, and `contextLines: settings['search.contextLines']` in place of `contextLines: null`. Import `useSettingsStore` from `'./settings'` and `resolveCaseSensitive` from `'../features/search'`.

- [ ] **Step 7: Export, verify, commit**

Add to `src/features/search/index.ts`:

```ts
export {
  pushQuery,
  historyStep,
  resolveCaseSensitive,
  HISTORY_LIMIT,
  type HistoryPosition,
} from './services/query-history';
```

Run: `bun run verify`
Expected: PASS.

```bash
git add src/features/search src/types/index.ts src/stores/settings.ts src/stores/search.ts
git commit -m "feat(search): query history ring, smartcase, and search settings"
```

---

### Task 8: `search://` tab plumbing

Opens the tab and routes it to a placeholder view. Nothing renders results yet — this task exists so tab lifecycle can be reviewed on its own, before any rendering complexity lands on top of it.

**Files:**
- Modify: `src/stores/workspace.ts` (new `openSearchTab` action + interface entry)
- Create: `src/features/search/components/SearchResultsTab.tsx`
- Modify: `src/features/search/index.ts`
- Modify: `src/features/editor/components/EditorPanel.tsx`

**Interfaces:**
- Consumes: `createSession`/`useSearchStore` (Task 2), `isVirtualPath` (Task 1).
- Produces: `useWorkspaceStore.getState().openSearchTab(seed?): string` returning the new tab path; `<SearchResultsTab sessionId={...} />`.

- [ ] **Step 1: Add the store action**

In `src/stores/workspace.ts`, add to the interface beside `openCommitDiffTab`:

```ts
  /** Opens a new search tab and returns its path (`search://<n>`). `seed`
   *  pre-fills the query and/or the include glob — used by "Search in Folder"
   *  and by seeding from the editor selection. */
  openSearchTab: (seed?: { query?: string; includePattern?: string }) => string;
```

and the implementation:

```ts
  openSearchTab: (seed) => {
    // Ids are monotonic per run and never reused, so a closed tab's session
    // can be dropped without a later tab colliding with it.
    const used = get().openFiles.filter((f) => f.path.startsWith('search://')).length;
    let n = used + 1;
    while (get().openFiles.some((f) => f.path === `search://${n}`)) n += 1;
    const path = `search://${n}`;

    const search = useSearchStore.getState();
    search.ensureSession(path);
    if (seed?.query !== undefined || seed?.includePattern !== undefined) {
      search.update(path, {
        ...(seed.query !== undefined ? { query: seed.query } : {}),
        ...(seed.includePattern !== undefined ? { includePattern: seed.includePattern } : {}),
      });
    }
    search.setActiveSession(path);

    set((state) => ({
      openFiles: [...state.openFiles, { path, name: 'Search', content: '', isDirty: false }],
      activeFilePath: path,
    }));
    return path;
  },
```

Import `useSearchStore` from `'./search'` at the top of the file.

- [ ] **Step 2: Close the session when the tab closes**

Find `closeFile` in `src/stores/workspace.ts` and add, before its `set(...)`:

```ts
    if (path.startsWith('search://')) {
      useSearchStore.getState().closeSession(path);
    }
```

- [ ] **Step 3: Create the placeholder tab component**

Create `src/features/search/components/SearchResultsTab.tsx`:

```tsx
import { useSearchStore } from '../../../stores/search';

interface SearchResultsTabProps {
  sessionId: string;
}

function SearchResultsTab({ sessionId }: SearchResultsTabProps) {
  const session = useSearchStore((s) => s.sessions[sessionId]);
  if (!session) return null;
  return <div className="search-tab" data-session={sessionId} />;
}

export default SearchResultsTab;
```

- [ ] **Step 4: Route the scheme in EditorPanel**

In `src/features/editor/components/EditorPanel.tsx`, import `SearchResultsTab` from `'../../search'` and add this branch immediately after the `activeFile` lookup and before `const activeLanguage = detectLanguage(...)` — a search tab has no language, no model URI and no LSP document, so it must return before any of that is computed:

```tsx
  if (activeFile.path.startsWith('search://')) {
    return <SearchResultsTab sessionId={activeFile.path} />;
  }
```

- [ ] **Step 5: Export from the barrel**

Add to `src/features/search/index.ts`:

```ts
export { default as SearchResultsTab } from './components/SearchResultsTab';
```

- [ ] **Step 6: Verify by hand**

There is no command bound to this yet (Task 13 adds it), so drive it from the devtools console. Run `bun run tauri dev`, open devtools, and evaluate:

```js
window.__ARCANE_TEST_OPEN_SEARCH__ = () => useWorkspaceStore.getState().openSearchTab({ query: 'test' });
```

If `useWorkspaceStore` is not exposed on `window` in this build, add a temporary `import.meta.env.DEV` export in `src/stores/workspace.ts` for this check and remove it before committing.

Expected: a tab named "Search" opens and is selected, renders an empty panel, and closing it does not throw. Calling it again produces `search://2`, and closing a tab removes its session from `useSearchStore.getState().sessions`.

- [ ] **Step 7: Verify and commit**

Run: `bun run verify`
Expected: PASS.

```bash
git add src/stores/workspace.ts src/features/search src/features/editor/components/EditorPanel.tsx
git commit -m "feat(search): open results in a search:// tab"
```

---

### Task 9: The query bar

**Files:**
- Create: `src/features/search/components/SearchQueryBar.tsx`
- Modify: `src/features/search/components/SearchResultsTab.tsx`
- Modify: `src/App.css`

**Interfaces:**
- Consumes: `useSearchStore` (Task 2), `pushQuery`/`historyStep` (Task 7), `useDebouncedValue` (`src/hooks`), `autoSearchAction` (existing `search-model`).
- Produces: `<SearchQueryBar sessionId={...} />`.

- [ ] **Step 1: Implement the component**

Create `src/features/search/components/SearchQueryBar.tsx`:

```tsx
import { useCallback, useEffect, useRef } from 'react';
import { Search, EyeOff } from 'lucide-react';
import { useSearchStore } from '../../../stores/search';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useDebouncedValue } from '../../../hooks/useDebouncedValue';
import { autoSearchAction } from '../services/search-model';
import { pushQuery, historyStep } from '../services/query-history';

interface SearchQueryBarProps {
  sessionId: string;
}

function SearchQueryBar({ sessionId }: SearchQueryBarProps) {
  const session = useSearchStore((s) => s.sessions[sessionId]);
  const update = useSearchStore((s) => s.update);
  const search = useSearchStore((s) => s.search);
  const clearResults = useSearchStore((s) => s.clearResults);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);

  const inputRef = useRef<HTMLInputElement>(null);
  const debouncedQuery = useDebouncedValue(session?.query ?? '', 300);

  // Focus on mount: opening a search tab should leave you typing, not
  // hunting for the field.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [sessionId]);

  // Auto-search off the DEBOUNCED value only. Depending on anything that
  // changes identity per keystroke re-runs this per character and fires a
  // full workspace scan for each one — see the comment on autoSearchAction.
  useEffect(() => {
    const action = autoSearchAction(debouncedQuery);
    if (action === 'search') {
      if (workspacePath) search(sessionId, workspacePath);
    } else if (action === 'clear') {
      clearResults(sessionId);
    }
  }, [
    debouncedQuery,
    sessionId,
    workspacePath,
    search,
    clearResults,
    session?.isRegex,
    session?.caseSensitive,
    session?.wholeWord,
    session?.includeIgnored,
    session?.includePattern,
    session?.excludePattern,
  ]);

  const runNow = useCallback(() => {
    if (!session) return;
    update(sessionId, { history: pushQuery(session.history, session.query), historyIndex: -1 });
    if (workspacePath && session.query) search(sessionId, workspacePath);
  }, [session, sessionId, update, search, workspacePath]);

  if (!session) return null;

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      runNow();
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const step = historyStep(
        session!.history,
        session!.historyIndex,
        e.key === 'ArrowUp' ? 'back' : 'forward',
      );
      if (!step) return;
      e.preventDefault();
      update(sessionId, { query: step.query, historyIndex: step.index });
    }
  }

  const toggle = (key: 'isRegex' | 'caseSensitive' | 'wholeWord' | 'includeIgnored') =>
    update(sessionId, { [key]: !session[key] } as Partial<typeof session>);

  // While streaming, the store's totals only land on search-complete, so a
  // live count has to be derived from the batches accumulated so far —
  // otherwise the counter sits frozen at the previous search's totals.
  const streamed = session.results.reduce((sum, f) => sum + f.matches.length, 0);
  const summary = session.searchError
    ? session.searchError
    : session.isSearching
      ? `${streamed} in ${session.results.length} files…`
      : session.results.length > 0
        ? `${session.totalMatches} in ${session.fileCount} files${session.truncated ? ' (capped)' : ''}`
        : session.query.length >= 3 && session.activeSearchId !== null
          ? 'No results'
          : '';

  return (
    <div className="search-tab-bar">
      <div className="search-input-row">
        <div className="search-input-wrapper">
          <Search size={14} className="search-input-icon" />
          <input
            ref={inputRef}
            className="search-input"
            type="text"
            placeholder="Search"
            value={session.query}
            onChange={(e) => update(sessionId, { query: e.target.value, historyIndex: -1 })}
            onKeyDown={onKeyDown}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
          />
        </div>
        <div className="search-toggle-group">
          <button
            className={`search-toggle-btn${session.caseSensitive ? ' active' : ''}`}
            title="Match Case (Alt+Cmd+C)"
            onClick={() => toggle('caseSensitive')}
          >
            Aa
          </button>
          <button
            className={`search-toggle-btn${session.wholeWord ? ' active' : ''}`}
            title="Match Whole Word (Alt+Cmd+W)"
            onClick={() => toggle('wholeWord')}
          >
            Ab|
          </button>
          <button
            className={`search-toggle-btn${session.isRegex ? ' active' : ''}`}
            title="Use Regular Expression (Alt+Cmd+X)"
            onClick={() => toggle('isRegex')}
          >
            .*
          </button>
          <button
            className={`search-toggle-btn${session.includeIgnored ? ' active' : ''}`}
            title="Include Ignored Files"
            onClick={() => toggle('includeIgnored')}
          >
            <EyeOff size={14} />
          </button>
        </div>
        <span className="search-tab-count">{summary}</span>
      </div>

      <div className="search-filter-inputs">
        <input
          className="search-filter-input"
          type="text"
          placeholder="files to include (e.g. Assets/**, *.cs)"
          value={session.includePattern}
          onChange={(e) => update(sessionId, { includePattern: e.target.value })}
          spellCheck={false}
          autoComplete="off"
        />
        <input
          className="search-filter-input"
          type="text"
          placeholder="files to exclude (e.g. **/Editor/**)"
          value={session.excludePattern}
          onChange={(e) => update(sessionId, { excludePattern: e.target.value })}
          spellCheck={false}
          autoComplete="off"
        />
      </div>
    </div>
  );
}

export default SearchQueryBar;
```

There is no filters show/hide toggle: the tab is wide enough to keep the include/exclude row permanently visible, which is why it exists in the sidebar version and not here.

- [ ] **Step 2: Mount it in the tab**

Replace `src/features/search/components/SearchResultsTab.tsx`'s body:

```tsx
import { useSearchStore } from '../../../stores/search';
import SearchQueryBar from './SearchQueryBar';

interface SearchResultsTabProps {
  sessionId: string;
}

function SearchResultsTab({ sessionId }: SearchResultsTabProps) {
  const session = useSearchStore((s) => s.sessions[sessionId]);
  if (!session) return null;

  return (
    <div className="search-tab">
      <SearchQueryBar sessionId={sessionId} />
      <div className="search-tab-body" />
    </div>
  );
}

export default SearchResultsTab;
```

- [ ] **Step 3: Add the styles**

Append to `src/App.css`, using the existing theme custom properties (grep `--panel-bg` and neighbours in that file and reuse the exact names — do not introduce new colour literals):

```css
.search-tab {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.search-tab-bar {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-color);
  background: var(--panel-bg);
}

.search-tab-body {
  flex: 1;
  overflow: auto;
  position: relative;
  outline: none;
}

.search-tab-count {
  margin-left: auto;
  padding-left: 10px;
  color: var(--text-muted);
  font-size: 12px;
  white-space: nowrap;
}
```

- [ ] **Step 4: Verify by hand**

Run: `bun run tauri dev`, open a search tab, type a query.
Expected: the query streams results into the store (check `useSearchStore.getState().sessions` in the console — `results` fills), the body is still empty, `ArrowUp` after pressing Enter twice recalls the previous query.

- [ ] **Step 5: Verify and commit**

Run: `bun run verify`
Expected: PASS.

```bash
git add src/features/search src/App.css
git commit -m "feat(search): query bar in the results tab"
```

---

### Task 10: Excerpt rendering

**Files:**
- Create: `src/features/search/services/highlight.ts`
- Create: `src/features/search/services/highlight.test.ts`
- Create: `src/features/search/components/FileExcerptBlock.tsx`
- Create: `src/features/search/components/ExcerptList.tsx`
- Modify: `src/features/search/components/SearchResultsTab.tsx`
- Modify: `src/features/search/index.ts`
- Modify: `src/App.css`

**Interfaces:**
- Consumes: `buildExcerpts`, `Excerpt`, `ExcerptLine` (Task 6); `detectLanguage` (`src/utils/language-detect`); `getFileIcon` (`src/utils/file-icons`).
- Produces: `excerptRowKey(excerpt, line)`, `colorizeLine(text, monacoId)`, `<ExcerptList sessionId={...} />`.

- [ ] **Step 1: Write the failing test for the pure part**

Create `src/features/search/services/highlight.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { splitByMatches, excerptRowKey } from './highlight';

describe('splitByMatches', () => {
  it('returns one plain segment for a line with no matches', () => {
    expect(splitByMatches('hello', [])).toEqual([{ text: 'hello', isMatch: false }]);
  });

  it('splits around a single match', () => {
    expect(splitByMatches('a hit b', [{ start: 2, end: 5 }])).toEqual([
      { text: 'a ', isMatch: false },
      { text: 'hit', isMatch: true },
      { text: ' b', isMatch: false },
    ]);
  });

  it('splits around two matches on one line', () => {
    expect(splitByMatches('ab cd ab', [{ start: 0, end: 2 }, { start: 6, end: 8 }])).toEqual([
      { text: 'ab', isMatch: true },
      { text: ' cd ', isMatch: false },
      { text: 'ab', isMatch: true },
    ]);
  });

  it('drops zero-width and out-of-range ranges rather than emitting empty spans', () => {
    expect(splitByMatches('abc', [{ start: 1, end: 1 }])).toEqual([
      { text: 'abc', isMatch: false },
    ]);
    expect(splitByMatches('abc', [{ start: 2, end: 99 }])).toEqual([
      { text: 'ab', isMatch: false },
      { text: 'c', isMatch: true },
    ]);
  });

  it('sorts unordered ranges before splitting', () => {
    expect(splitByMatches('ab cd', [{ start: 3, end: 5 }, { start: 0, end: 2 }])).toEqual([
      { text: 'ab', isMatch: true },
      { text: ' ', isMatch: false },
      { text: 'cd', isMatch: true },
    ]);
  });
});

describe('excerptRowKey', () => {
  it('is unique per file and line', () => {
    expect(excerptRowKey('/w/a.ts', 12)).toBe('/w/a.ts#12');
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `bun test src/features/search/services/highlight.test.ts`
Expected: FAIL — cannot resolve `./highlight`.

- [ ] **Step 3: Implement**

Create `src/features/search/services/highlight.ts`:

```ts
// Match-range splitting is pure and tested here. Token colouring itself is a
// Monaco call kept behind `colorizeLine` — bun cannot import Monaco (it wants
// a DOM and workers), so nothing that touches it is unit-tested; keep the
// untestable surface to that one function.
import type { MatchRange } from './excerpt-model';

export interface LineSegment {
  text: string;
  isMatch: boolean;
}

export function excerptRowKey(filePath: string, lineNumber: number): string {
  return `${filePath}#${lineNumber}`;
}

/**
 * Splits a line into alternating plain and matched segments. Ranges are
 * UTF-16 offsets into `text`; out-of-range ends are clamped and zero-width
 * ranges dropped, so a malformed range can never produce an empty span or a
 * negative slice.
 */
export function splitByMatches(text: string, ranges: MatchRange[]): LineSegment[] {
  const sorted = [...ranges]
    .map((r) => ({ start: Math.max(0, r.start), end: Math.min(text.length, r.end) }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);

  if (sorted.length === 0) return [{ text, isMatch: false }];

  const segments: LineSegment[] = [];
  let cursor = 0;
  for (const range of sorted) {
    if (range.start < cursor) continue; // overlapping range: keep the first
    if (range.start > cursor) {
      segments.push({ text: text.slice(cursor, range.start), isMatch: false });
    }
    segments.push({ text: text.slice(range.start, range.end), isMatch: true });
    cursor = range.end;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), isMatch: false });
  }
  return segments;
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `bun test src/features/search/services/highlight.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Build the file block**

Create `src/features/search/components/FileExcerptBlock.tsx`:

```tsx
import { ChevronDown, ChevronRight } from 'lucide-react';
import { getFileIcon } from '../../../utils/file-icons';
import { splitByMatches } from '../services/highlight';
import type { Excerpt } from '../services/excerpt-model';

interface FileExcerptBlockProps {
  filePath: string;
  relativePath: string;
  excerpts: Excerpt[];
  matchCount: number;
  collapsed: boolean;
  activeExcerptId: string | null;
  onToggleCollapse: (filePath: string) => void;
  onOpenExcerpt: (filePath: string, lineNumber: number, column: number) => void;
  onFocusExcerpt: (excerptId: string) => void;
  onExpand: (excerptId: string, direction: 'up' | 'down') => void;
}

function FileExcerptBlock({
  filePath,
  relativePath,
  excerpts,
  matchCount,
  collapsed,
  activeExcerptId,
  onToggleCollapse,
  onOpenExcerpt,
  onFocusExcerpt,
  onExpand,
}: FileExcerptBlockProps) {
  const fileName = filePath.split('/').pop() || filePath;

  return (
    <div className="search-excerpt-file">
      <button
        className="search-excerpt-file-header"
        onClick={() => onToggleCollapse(filePath)}
        title={filePath}
      >
        <span className="search-file-chevron">
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </span>
        <span className="search-file-icon">{getFileIcon(fileName, 14)}</span>
        <span className="search-file-name">{fileName}</span>
        <span className="search-file-path">{relativePath !== fileName ? relativePath : ''}</span>
        <span className="search-file-count">{matchCount}</span>
      </button>

      {!collapsed &&
        excerpts.map((excerpt) => (
          <div
            key={excerpt.id}
            className={`search-excerpt${activeExcerptId === excerpt.id ? ' active' : ''}`}
            onMouseDown={() => onFocusExcerpt(excerpt.id)}
          >
            <button
              className="search-excerpt-expand"
              title="Expand context above (Shift+Enter)"
              onClick={() => onExpand(excerpt.id, 'up')}
            >
              ⌃
            </button>

            {excerpt.lines.map((line) => {
              const segments = splitByMatches(line.text, line.matches);
              const isMatchLine = line.matches.length > 0;
              return (
                <div
                  key={line.lineNumber}
                  className={`search-excerpt-line${isMatchLine ? ' is-match' : ''}`}
                  onDoubleClick={() =>
                    onOpenExcerpt(filePath, line.lineNumber, (line.matches[0]?.start ?? 0) + 1)
                  }
                >
                  <span className="search-excerpt-gutter">{line.lineNumber}</span>
                  <code className="search-excerpt-code">
                    {segments.map((segment, i) =>
                      segment.isMatch ? (
                        <mark key={i} className="search-match-highlight">
                          {segment.text}
                        </mark>
                      ) : (
                        <span key={i}>{segment.text}</span>
                      ),
                    )}
                  </code>
                </div>
              );
            })}

            <button
              className="search-excerpt-expand"
              title="Expand context below"
              onClick={() => onExpand(excerpt.id, 'down')}
            >
              ⌄
            </button>
          </div>
        ))}
    </div>
  );
}

export default FileExcerptBlock;
```

Syntax colouring via `monaco.editor.colorize` is added in a follow-up commit inside this same task (Step 7); shipping the plain-text segments first keeps the highlight logic reviewable in isolation.

- [ ] **Step 6: Build the virtualized list**

Create `src/features/search/components/ExcerptList.tsx`:

Tasks 11 and 12 add to this file, so the import line already carries the hooks they need.

```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useSearchStore } from '../../../stores/search';
import { useWorkspaceStore } from '../../../stores/workspace';
import { buildExcerpts, applyExpansion } from '../services/excerpt-model';
import { readFileLines } from '../services/file-lines';
import FileExcerptBlock from './FileExcerptBlock';

const LINE_HEIGHT = 18;
const HEADER_HEIGHT = 26;
const EXPANDER_HEIGHT = 12;
/** Lines revealed per click of ⌃ / ⌄. */
const EXPAND_STEP = 5;

interface ExcerptListProps {
  sessionId: string;
}

function ExcerptList({ sessionId }: ExcerptListProps) {
  const session = useSearchStore((s) => s.sessions[sessionId]);
  const update = useSearchStore((s) => s.update);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const scrollRef = useRef<HTMLDivElement>(null);

  const blocks = useMemo(
    () =>
      (session?.results ?? []).map((file) => ({
        file,
        excerpts: buildExcerpts(file),
        collapsed: (session?.collapsedFiles ?? []).includes(file.path),
      })),
    [session?.results, session?.collapsedFiles],
  );

  // Estimated from the excerpt shape rather than a constant: blocks differ by
  // an order of magnitude in height, and measureElement corrects the rest.
  const estimateSize = useCallback(
    (index: number) => {
      const block = blocks[index];
      if (!block) return HEADER_HEIGHT;
      if (block.collapsed) return HEADER_HEIGHT;
      const lines = block.excerpts.reduce((sum, e) => sum + e.lines.length, 0);
      return HEADER_HEIGHT + lines * LINE_HEIGHT + block.excerpts.length * EXPANDER_HEIGHT * 2;
    },
    [blocks],
  );

  const virtualizer = useVirtualizer({
    count: blocks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    overscan: 4,
  });

  const toggleCollapse = useCallback(
    (filePath: string) => {
      const current = session?.collapsedFiles ?? [];
      update(sessionId, {
        collapsedFiles: current.includes(filePath)
          ? current.filter((p) => p !== filePath)
          : [...current, filePath],
      });
    },
    [session?.collapsedFiles, sessionId, update],
  );

  const openExcerpt = useCallback(async (filePath: string, lineNumber: number, column: number) => {
    const fileName = filePath.split('/').pop() || '';
    await useWorkspaceStore.getState().openFile(filePath, fileName);
    window.dispatchEvent(
      new CustomEvent('navigate-to-line', { detail: { line: lineNumber, column } }),
    );
  }, []);

  const focusExcerpt = useCallback(
    (excerptId: string) => update(sessionId, { activeExcerptId: excerptId }),
    [sessionId, update],
  );

  // Expansion is wired in Task 11; the handler exists here so the block's
  // props are stable across both tasks.
  const expand = useCallback(() => undefined, []);

  if (!session) return null;

  return (
    <div className="search-tab-body" ref={scrollRef}>
      <div style={{ height: `${virtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}>
        {virtualizer.getVirtualItems().map((item) => {
          const block = blocks[item.index];
          if (!block) return null;
          const relativePath = workspacePath
            ? block.file.path.replace(workspacePath + '/', '')
            : block.file.path;
          return (
            <div
              key={block.file.path}
              data-index={item.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${item.start}px)`,
              }}
            >
              <FileExcerptBlock
                filePath={block.file.path}
                relativePath={relativePath}
                excerpts={block.excerpts}
                matchCount={block.file.matches.length}
                collapsed={block.collapsed}
                activeExcerptId={session.activeExcerptId}
                onToggleCollapse={toggleCollapse}
                onOpenExcerpt={openExcerpt}
                onFocusExcerpt={focusExcerpt}
                onExpand={expand}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default ExcerptList;
```

- [ ] **Step 7: Add syntax colouring**

Hooks cannot be called inside a `.map` callback, so the per-line body becomes its own component in the same file. Monaco's `colorize` escapes its input and the text comes from the user's own files, which is what makes `dangerouslySetInnerHTML` acceptable here and would not make it acceptable for remote HTML.

Add to the top of `FileExcerptBlock.tsx`:

```tsx
import { useEffect, useState } from 'react';
import * as monaco from 'monaco-editor';
import { detectLanguage } from '../../../utils/language-detect';
import type { MatchRange } from '../services/excerpt-model';

/** Colorized HTML per (languageId, text). Search results repeat lines across
 *  excerpts constantly, and colorize is an async tokenizer pass, so without a
 *  cache scrolling re-tokenizes the same lines on every virtualization pass. */
const colorCache = new Map<string, string>();

function useColorizedLine(text: string, monacoId: string): string | null {
  const [html, setHtml] = useState<string | null>(() => colorCache.get(`${monacoId}\u0000${text}`) ?? null);

  useEffect(() => {
    const key = `${monacoId}\u0000${text}`;
    const cached = colorCache.get(key);
    if (cached !== undefined) {
      setHtml(cached);
      return;
    }
    let cancelled = false;
    monaco.editor
      .colorize(text, monacoId, { tabSize: 4 })
      .then((result) => {
        if (colorCache.size > 5000) colorCache.clear();
        colorCache.set(key, result);
        if (!cancelled) setHtml(result);
      })
      .catch(() => {
        // Unknown language or a tokenizer error: plain text is a fine result.
      });
    return () => {
      cancelled = true;
    };
  }, [text, monacoId]);

  return html;
}
```

Then add the row component below it, and replace the inline `excerpt.lines.map(...)` body from Step 5 with a call to it. Match lines keep the plain segment split so highlight offsets stay exact; pure context lines get the colorized HTML:

```tsx
interface ExcerptLineRowProps {
  lineNumber: number;
  text: string;
  matches: MatchRange[];
  monacoId: string;
  onOpen: (lineNumber: number, column: number) => void;
}

function ExcerptLineRow({ lineNumber, text, matches, monacoId, onOpen }: ExcerptLineRowProps) {
  const isMatchLine = matches.length > 0;
  // Only context lines go through colorize: a match line needs exact UTF-16
  // offsets for its <mark>, and those cannot survive tokenization into HTML.
  const colorized = useColorizedLine(isMatchLine ? '' : text, monacoId);

  return (
    <div
      className={`search-excerpt-line${isMatchLine ? ' is-match' : ''}`}
      onDoubleClick={() => onOpen(lineNumber, (matches[0]?.start ?? 0) + 1)}
    >
      <span className="search-excerpt-gutter">{lineNumber}</span>
      <code className="search-excerpt-code">
        {isMatchLine || colorized === null ? (
          splitByMatches(text, matches).map((segment, i) =>
            segment.isMatch ? (
              <mark key={i} className="search-match-highlight">
                {segment.text}
              </mark>
            ) : (
              <span key={i}>{segment.text}</span>
            ),
          )
        ) : (
          <span dangerouslySetInnerHTML={{ __html: colorized }} />
        )}
      </code>
    </div>
  );
}
```

In `FileExcerptBlock`, compute the language once per file and render rows through it:

```tsx
  const monacoId = detectLanguage(fileName).monacoId;
```

```tsx
            {excerpt.lines.map((line) => (
              <ExcerptLineRow
                key={line.lineNumber}
                lineNumber={line.lineNumber}
                text={line.text}
                matches={line.matches}
                monacoId={monacoId}
                onOpen={(lineNumber, column) => onOpenExcerpt(filePath, lineNumber, column)}
              />
            ))}
```

`useColorizedLine` is called with `''` for match lines rather than being skipped, because a hook cannot be called conditionally; colorizing an empty string is cheap and its result is discarded.

- [ ] **Step 8: Mount the list and style it**

In `SearchResultsTab.tsx`, replace `<div className="search-tab-body" />` with `<ExcerptList sessionId={sessionId} />`.

Append to `src/App.css` (reusing existing theme variables — grep neighbouring rules for the exact names):

```css
.search-excerpt-file-header {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 26px;
  padding: 0 10px;
  background: var(--panel-bg);
  border: none;
  border-top: 1px solid var(--border-color);
  color: var(--text-primary);
  font-size: 12px;
  cursor: pointer;
}

.search-excerpt-line {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  min-height: 18px;
  line-height: 18px;
  padding: 0 10px;
  font-family: var(--editor-font-family, monospace);
  font-size: 12px;
  white-space: pre;
}

.search-excerpt-line.is-match {
  background: var(--search-match-line-bg, transparent);
}

.search-excerpt-gutter {
  min-width: 40px;
  text-align: right;
  color: var(--text-muted);
  user-select: none;
}

.search-excerpt-code {
  overflow: hidden;
  text-overflow: ellipsis;
}

.search-excerpt.active {
  box-shadow: inset 2px 0 0 var(--accent-color);
}

.search-excerpt-expand {
  width: 100%;
  height: 12px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-size: 10px;
  cursor: pointer;
}
```

- [ ] **Step 9: Verify by hand, then verify and commit**

Run: `bun run tauri dev`, open a search tab in a real project, search for a common identifier.
Expected: results stream in as file blocks with two context lines either side, matches highlighted, C# lines syntax-coloured, scrolling smooth over hundreds of files, double-click opens the file at the right line and column.

Run: `bun run verify`
Expected: PASS.

```bash
git add src/features/search src/App.css
git commit -m "feat(search): render results as syntax-highlighted excerpts"
```

---

### Task 11: Excerpt expansion

**Files:**
- Create: `src/features/search/services/file-lines.ts`
- Create: `src/features/search/services/file-lines.test.ts`
- Modify: `src/features/search/components/ExcerptList.tsx`
- Modify: `src/features/search/index.ts`

**Interfaces:**
- Consumes: `applyExpansion` (Task 6), `invoke('read_file', { path })`.
- Produces: `splitLines(content)`, `readFileLines(path)` (cached), `clearFileLineCache()`.

- [ ] **Step 1: Write the failing test**

Create `src/features/search/services/file-lines.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { splitLines } from './file-lines';

describe('splitLines', () => {
  it('splits on LF', () => {
    expect(splitLines('a\nb\nc')).toEqual(['a', 'b', 'c']);
  });

  it('splits on CRLF without leaving carriage returns', () => {
    expect(splitLines('a\r\nb\r\nc')).toEqual(['a', 'b', 'c']);
  });

  it('drops the empty trailing element from a final newline', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
  });

  it('returns a single empty line for empty content', () => {
    expect(splitLines('')).toEqual(['']);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `bun test src/features/search/services/file-lines.test.ts`
Expected: FAIL — cannot resolve `./file-lines`.

- [ ] **Step 3: Implement**

Create `src/features/search/services/file-lines.ts`:

```ts
import { invoke } from '@tauri-apps/api/core';

/** Splits file content into lines with terminators removed. A trailing
 *  newline does NOT produce a final empty line — line N of a file with N
 *  lines must be the last element. */
export function splitLines(content: string): string[] {
  const normalized = content.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// Expansion re-reads the same file repeatedly as the user opens context on
// several excerpts; the cache is dropped whenever a new search starts, so it
// can never serve lines from a file that changed between searches.
const cache = new Map<string, string[]>();

export async function readFileLines(path: string): Promise<string[]> {
  const cached = cache.get(path);
  if (cached) return cached;
  const content = await invoke<string>('read_file', { path });
  const lines = splitLines(content);
  cache.set(path, lines);
  return lines;
}

export function clearFileLineCache(): void {
  cache.clear();
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `bun test src/features/search/services/file-lines.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Wire expansion into the list**

In `ExcerptList.tsx`, hold the read lines in component state and apply the session's expansion when building blocks. Replace the placeholder `expand` callback:

```tsx
  const [fileLines, setFileLines] = useState<Record<string, string[]>>({});

  const expand = useCallback(
    async (excerptId: string, direction: 'up' | 'down') => {
      const filePath = excerptId.slice(0, excerptId.lastIndexOf(':'));
      const lines = fileLines[filePath] ?? (await readFileLines(filePath));
      setFileLines((prev) => (prev[filePath] ? prev : { ...prev, [filePath]: lines }));

      const current = session?.expanded[excerptId] ?? { up: 0, down: 0 };
      update(sessionId, {
        expanded: {
          ...(session?.expanded ?? {}),
          [excerptId]: {
            up: current.up + (direction === 'up' ? EXPAND_STEP : 0),
            down: current.down + (direction === 'down' ? EXPAND_STEP : 0),
          },
        },
      });
    },
    [fileLines, session?.expanded, sessionId, update],
  );
```

(`EXPAND_STEP`, `useState` and the `readFileLines` / `applyExpansion` imports were already added in Task 10.) Then apply the expansion inside the `blocks` memo:

```tsx
        excerpts: buildExcerpts(file).map((excerpt) => {
          const expansion = session?.expanded[excerpt.id];
          const lines = fileLines[file.path];
          return expansion && lines ? applyExpansion(excerpt, lines, expansion) : excerpt;
        }),
```

adding `fileLines` and `session?.expanded` to the memo's dependency array.

- [ ] **Step 6: Drop the cache when a search starts**

In `src/stores/search.ts`'s `search` action, call `clearFileLineCache()` immediately before the `invoke`, importing it from `'../features/search'`. Stale lines from a previous search would otherwise expand into content that no longer matches the result set.

- [ ] **Step 7: Verify by hand, then verify and commit**

Run: `bun run tauri dev`, search, click ⌃ and ⌄ on an excerpt several times.
Expected: five more real lines appear each click, clamping silently at the start and end of the file, with the match highlight staying on the right line.

Run: `bun run verify`
Expected: PASS.

```bash
git add src/features/search src/stores/search.ts
git commit -m "feat(search): expand excerpt context from the real file"
```

---

### Task 12: The outline panel

The sidebar stops being the search UI and becomes the compact index of the active session, synced both ways with the tab.

**Files:**
- Create: `src/features/search/components/SearchOutlinePanel.tsx`
- Delete: `src/features/search/components/SearchPanel.tsx`
- Modify: `src/features/search/index.ts`
- Modify: `src/features/app-shell/components/SidebarPanel.tsx`
- Modify: `src/features/search/components/ExcerptList.tsx`
- Modify: `src/App.css`

**Interfaces:**
- Consumes: `useSearchStore`, `buildExcerpts`, `excerptId`.
- Produces: `<SearchOutlinePanel />`; a `search-reveal-excerpt` window event carrying `{ sessionId, excerptId }`.

- [ ] **Step 1: Build the outline**

Create `src/features/search/components/SearchOutlinePanel.tsx`:

```tsx
import { useMemo } from 'react';
import { useSearchStore } from '../../../stores/search';
import { useWorkspaceStore } from '../../../stores/workspace';
import { getFileIcon } from '../../../utils/file-icons';
import { buildExcerpts } from '../services/excerpt-model';

function plural(count: number): string {
  return count === 1 ? '' : 's';
}

function SearchOutlinePanel() {
  const sessionId = useSearchStore((s) => s.activeSessionId);
  const session = useSearchStore((s) => s.sessions[s.activeSessionId]);
  const update = useSearchStore((s) => s.update);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);

  const files = useMemo(
    () =>
      (session?.results ?? []).map((file) => ({
        path: file.path,
        name: file.path.split('/').pop() || file.path,
        relativePath: workspacePath ? file.path.replace(workspacePath + '/', '') : file.path,
        excerpts: buildExcerpts(file),
        matchCount: file.matches.length,
      })),
    [session?.results, workspacePath],
  );

  if (!session) return null;

  const summary = session.isSearching
    ? 'Searching…'
    : session.results.length > 0
      ? `${session.totalMatches} result${plural(session.totalMatches)} in ${session.fileCount} file${plural(session.fileCount)}`
      : '';

  function reveal(excerptId: string) {
    update(sessionId, { activeExcerptId: excerptId });
    window.dispatchEvent(
      new CustomEvent('search-reveal-excerpt', { detail: { sessionId, excerptId } }),
    );
  }

  return (
    <div className="sidebar">
      <div className="sidebar-header">SEARCH RESULTS</div>
      <div className="search-summary">{summary}</div>
      <div className="search-outline">
        {files.map((file) => (
          <div key={file.path} className="search-outline-file">
            <div className="search-outline-file-header" title={file.relativePath}>
              <span className="search-file-icon">{getFileIcon(file.name, 14)}</span>
              <span className="search-file-name">{file.name}</span>
              <span className="search-file-count">{file.matchCount}</span>
            </div>
            {file.excerpts.map((excerpt) => (
              <button
                key={excerpt.id}
                className={`search-outline-row${session.activeExcerptId === excerpt.id ? ' active' : ''}`}
                onClick={() => reveal(excerpt.id)}
              >
                <span className="search-match-line">{excerpt.startLine}</span>
                <span className="search-match-content">
                  {excerpt.lines.find((l) => l.matches.length > 0)?.text.trim() ?? ''}
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export default SearchOutlinePanel;
```

- [ ] **Step 2: Scroll the tab when the outline asks**

In `ExcerptList.tsx`, add a listener that scrolls the virtualizer to the requested excerpt:

```tsx
  useEffect(() => {
    function onReveal(event: Event) {
      const detail = (event as CustomEvent<{ sessionId: string; excerptId: string }>).detail;
      if (detail.sessionId !== sessionId) return;
      const filePath = detail.excerptId.slice(0, detail.excerptId.lastIndexOf(':'));
      const index = blocks.findIndex((b) => b.file.path === filePath);
      if (index >= 0) virtualizer.scrollToIndex(index, { align: 'center' });
    }
    window.addEventListener('search-reveal-excerpt', onReveal);
    return () => window.removeEventListener('search-reveal-excerpt', onReveal);
  }, [blocks, sessionId, virtualizer]);
```

The reverse direction already works: `onFocusExcerpt` writes `activeExcerptId`, which the outline reads and styles.

- [ ] **Step 3: Swap the sidebar registration**

In `src/features/app-shell/components/SidebarPanel.tsx`, change the import to `import { SearchOutlinePanel } from '../../search';` and the `case 'search':` branch to `return <SearchOutlinePanel />;`.

- [ ] **Step 4: Delete the old panel**

Delete `src/features/search/components/SearchPanel.tsx`, and in `src/features/search/index.ts` replace `export { default as SearchPanel } from './components/SearchPanel';` with `export { default as SearchOutlinePanel } from './components/SearchOutlinePanel';`.

`flattenRows` in `search-model.ts` existed only for that panel. Delete `flattenRows`, its `SearchRow` type, their barrel exports, and their tests in `search-model.test.ts`. Leaving dead code behind a deleted consumer is how the next reader learns the wrong thing.

- [ ] **Step 5: Style the outline**

Append to `src/App.css`:

```css
.search-outline {
  flex: 1;
  overflow: auto;
}

.search-outline-file-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  font-size: 12px;
  color: var(--text-primary);
}

.search-outline-row {
  display: flex;
  gap: 8px;
  width: 100%;
  padding: 2px 10px 2px 26px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
}

.search-outline-row.active {
  background: var(--list-active-bg);
}
```

- [ ] **Step 6: Verify by hand, then verify and commit**

Run: `bun run tauri dev`, run a search, open the Search sidebar view.
Expected: the outline lists every excerpt; clicking one scrolls the tab to it and marks it active; clicking an excerpt in the tab marks the matching outline row.

Run: `bun run verify`
Expected: PASS — `check:modules` in particular, since the barrel changed.

```bash
git add -A src/features/search src/features/app-shell/components/SidebarPanel.tsx src/App.css
git commit -m "feat(search): sidebar becomes a synced results outline"
```

---

### Task 13: Commands, keybindings, and Search in Folder

**Files:**
- Modify: `src/App.tsx` (command registry)
- Modify: `src/features/explorer/components/*` (directory context menu — locate the existing menu component with `rg -n "context-menu" src/features/explorer`)
- Verify: `src-tauri/src/menu.rs`

**Interfaces:**
- Consumes: `openSearchTab` (Task 8), `useSearchStore` (Task 2).
- Produces: commands `search.openTab`, `search.newTab`, `search.useSelection`, `search.toggleCase`, `search.toggleWholeWord`, `search.toggleRegex`, `search.nextMatch`, `search.previousMatch`.

- [ ] **Step 1: Check the native menu first**

Run: `rg -n -i "shift\+f|alt\+h|shift\+h|F3|search|find" src-tauri/src/menu.rs`
Expected: no accelerator for any chord this task binds. If any appears, the native menu wins on macOS and `menu.rs` must be updated in the same commit — this is the failure mode CLAUDE.md documents for `mod+j`.

- [ ] **Step 2: Repoint `search.focus` at the tab**

In `src/App.tsx`, replace the `search.focus` command (currently at line ~839) with:

```tsx
    {
      id: 'search.openTab',
      label: 'Search in Files',
      category: 'Search',
      keybinding: 'mod+shift+f',
      handler: () => {
        const workspace = useWorkspaceStore.getState();
        const existing = workspace.openFiles.find((f) => f.path.startsWith('search://'));
        const seededQuery = selectionSeedQuery();
        if (existing) {
          workspace.setActiveFile(existing.path);
          useSearchStore.getState().setActiveSession(existing.path);
          if (seededQuery) useSearchStore.getState().update(existing.path, { query: seededQuery });
          window.dispatchEvent(new CustomEvent('search-focus-query'));
          return;
        }
        workspace.openSearchTab(seededQuery ? { query: seededQuery } : undefined);
      },
    },
    {
      id: 'search.newTab',
      label: 'New Search',
      category: 'Search',
      handler: () => {
        const seededQuery = selectionSeedQuery();
        useWorkspaceStore.getState().openSearchTab(seededQuery ? { query: seededQuery } : undefined);
      },
    },
```

Add the seed helper near the other module-level helpers in `App.tsx`:

```tsx
/** The editor selection, when the seed setting allows it. Returns '' when
 *  there is nothing to seed with, so callers can treat it as falsy. */
function selectionSeedQuery(): string {
  const mode = useSettingsStore.getState().settings['search.seedQueryFromCursor'];
  if (mode === 'never') return '';

  // There is no "active editor" accessor in this codebase; Monaco's own
  // registry is the source of truth. Prefer the focused editor, falling back
  // to the only one open.
  const monaco = getMonacoInstance();
  const editors = monaco?.editor.getEditors() ?? [];
  const editor = editors.find((e) => e.hasTextFocus()) ?? editors[0];
  const selection = editor?.getSelection();
  const model = editor?.getModel();
  if (!editor || !selection || !model) return '';

  if (selection.isEmpty()) {
    if (mode !== 'always') return '';
    const position = editor.getPosition();
    if (!position) return '';
    return model.getWordAtPosition(position)?.word ?? '';
  }
  // A multi-line selection is a range to search within, not a query — Zed
  // treats it that way too. Seeding with it would produce a query that
  // matches nothing.
  if (selection.startLineNumber !== selection.endLineNumber) return '';
  return model.getValueInRange(selection);
}
```

`getMonacoInstance` is exported from `src/utils/monaco-instance.ts` and returns the Monaco namespace (not an editor); `monaco.editor.getEditors()` is a documented 0.55 API.

- [ ] **Step 3: Add the remaining commands**

Append these to the same registry array:

```tsx
    {
      id: 'search.useSelection',
      label: 'Use Selection for Find',
      category: 'Search',
      keybinding: 'mod+e',
      handler: () => {
        const query = selectionSeedQuery();
        if (!query) return;
        const { activeSessionId, update } = useSearchStore.getState();
        update(activeSessionId, { query });
      },
    },
    {
      id: 'search.toggleCase',
      label: 'Toggle Match Case',
      category: 'Search',
      keybinding: 'mod+alt+c',
      handler: () => {
        const { activeSessionId, sessions, update } = useSearchStore.getState();
        update(activeSessionId, { caseSensitive: !sessions[activeSessionId]?.caseSensitive });
      },
    },
    {
      id: 'search.toggleWholeWord',
      label: 'Toggle Match Whole Word',
      category: 'Search',
      keybinding: 'mod+alt+w',
      handler: () => {
        const { activeSessionId, sessions, update } = useSearchStore.getState();
        update(activeSessionId, { wholeWord: !sessions[activeSessionId]?.wholeWord });
      },
    },
    {
      id: 'search.toggleRegex',
      label: 'Toggle Regular Expression',
      category: 'Search',
      keybinding: 'mod+alt+x',
      handler: () => {
        const { activeSessionId, sessions, update } = useSearchStore.getState();
        update(activeSessionId, { isRegex: !sessions[activeSessionId]?.isRegex });
      },
    },
```

- [ ] **Step 4: Focus the query input on demand**

In `SearchQueryBar.tsx`, listen for the event the `search.openTab` handler dispatches:

```tsx
  useEffect(() => {
    function onFocus() {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
    window.addEventListener('search-focus-query', onFocus);
    return () => window.removeEventListener('search-focus-query', onFocus);
  }, []);
```

- [ ] **Step 5: Add Search in Folder**

`ContextMenu.tsx` takes one prop per action rather than an items array, and renders optional actions only when the prop is passed. Follow that shape exactly.

In `src/features/explorer/components/ContextMenu.tsx`, add `Search` to the `lucide-react` import, add the prop to `ContextMenuProps` and the destructure:

```tsx
  /** Opens a search tab scoped to this directory (shown when provided). */
  onSearchInFolder?: () => void;
```

and render it after the `onNewScript` block, above the existing divider:

```tsx
        {onSearchInFolder && (
          <button
            className="context-menu-item"
            onClick={() => handleItem(onSearchInFolder)}
            style={menuItemStyle}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <Search size={14} style={{ marginRight: 8, flexShrink: 0 }} />
            Search in Folder
          </button>
        )}
```

In `src/features/explorer/components/ExplorerPanel.tsx`, pass it at the `<ContextMenu ... />` call site (around line 574), directories only — the prop stays `undefined` for files, which is how the component already hides optional actions:

```tsx
          onSearchInFolder={
            contextMenu.isDir
              ? () => {
                  const relative = toRelativePath(contextMenu.path, workspacePath);
                  useWorkspaceStore.getState().openSearchTab({ includePattern: `${relative}/**` });
                }
              : undefined
          }
```

`toRelativePath` and `workspacePath` are already in scope at that call site — they are used by the neighbouring `onCopyRelativePath` handler.

- [ ] **Step 6: Bind alt+enter and shift+enter inside the results tab**

These act on the active excerpt, so they belong to the tab rather than the global registry — a document-level hotkey would fire while you are typing in the query input. In `ExcerptList.tsx`, make the scroll container focusable and handle the keys on it:

```tsx
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const activeId = session?.activeExcerptId;
      if (!activeId) return;

      if (e.key === 'Enter' && e.altKey) {
        e.preventDefault();
        const filePath = activeId.slice(0, activeId.lastIndexOf(':'));
        const block = blocks.find((b) => b.file.path === filePath);
        const excerpt = block?.excerpts.find((ex) => ex.id === activeId);
        const line = excerpt?.lines.find((l) => l.matches.length > 0);
        if (line) openExcerpt(filePath, line.lineNumber, (line.matches[0]?.start ?? 0) + 1);
        return;
      }

      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        void expand(activeId, 'down');
      }
    },
    [blocks, expand, openExcerpt, session?.activeExcerptId],
  );
```

and put `tabIndex={0}` and `onKeyDown={onKeyDown}` on the `.search-tab-body` div.

Do **not** call `e.stopPropagation()` in this handler. React attaches its listeners to `#root`, below the `document` listener `react-hotkeys-hook` uses, so stopping propagation here would kill every app hotkey for as long as this element holds focus — the trap documented in CLAUDE.md.

- [ ] **Step 7: Verify by hand**

Run: `bun run tauri dev`.
Expected, each checked individually:
- `mod+shift+f` with a word selected opens a search tab pre-filled with that word; pressing it again focuses the same tab and selects the query text.
- Clicking an excerpt then pressing `alt+enter` opens that file at that match; `shift+enter` reveals five more lines below it.
- "New Search" from the palette opens a second, independent tab; running a search in it does not stop the first tab's results from being complete (this is what Task 5 bought).
- `mod+alt+c` / `mod+alt+w` / `mod+alt+x` flip the toggles and re-run the search.
- `mod+e` with a different selection replaces the query.
- Right-click a folder in the explorer → "Search in Folder" opens a tab scoped to it.
- `mod+shift+g` still opens Source Control and `mod+g` still opens Go to Line.

- [ ] **Step 8: Verify and commit**

Run: `bun run verify`
Expected: PASS.

```bash
git add src/App.tsx src/features/search src/features/explorer
git commit -m "feat(search): commands, keybindings, and Search in Folder"
```

---

## Deferred to later phases

Not in scope here, per the spec's phasing:

- `mod+shift+h` / Replace in Files, and the AI Chat History move to `mod+alt+h` (Phase 2).
- `F3` / `shift+F3` match navigation (Phase 2 — it needs a "current match" concept, whereas Phase 1 only tracks a current excerpt).
- `mod+alt+enter` open-excerpt-in-split (Phase 2, with the rest of the match-navigation work).
- Hydration to editable excerpts via `setHiddenAreas`, and `saveAll` (Phase 3).

## Final manual verification

Run once after Task 13, in a real Unity project, before calling Phase 1 done:

- [ ] Search a common identifier; results stream in with context, syntax coloured.
- [ ] Expand context up and down on an excerpt at the very top of a file and at the very bottom — it clamps rather than throwing.
- [ ] Search something matched inside `.prefab` / `.unity` YAML and inside a `.shader` — both appear (no extension filter was reintroduced).
- [ ] Toggle Include Ignored on a gitignored file and confirm it appears only with the toggle on.
- [ ] Open two search tabs with different queries and confirm both hold complete results.
- [ ] Double-click a match: the correct file opens at the correct line **and column**, including on a long line that was preview-trimmed.
- [ ] `bun run verify` is green, and `verify:intellisense` reports a real pass rather than `SKIPPED`.
