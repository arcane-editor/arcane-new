import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * STRUCTURAL TEST FILE — every assertion below reads source text and never
 * imports or executes `workspace.ts` or `search.ts`. This is a deliberate
 * fallback, not the first choice: `workspace.ts` transitively touches
 * `document`/`window` at module-eval time (theme FOUC bootstrap), the Tauri
 * IPC bridge, and — via the `features/editor` barrel it imports for
 * `initMonaco`/`disposeModelForPath` — the real `monaco-editor` package,
 * which runs browser-only code (`window.location`, animation-frame
 * scheduling) at import time and crashes under plain `bun test`. This is the
 * same problem `import-link-provider.test.ts` documents, and the same reason
 * `model-disposal.test.ts` and `search-scope.test.ts` — this codebase's two
 * existing tests of this exact store — also read source text instead of
 * importing it.
 *
 * A real-execution version of this file WAS built and got as far as passing
 * in isolation (8/8), using `mock.module` to stub the Tauri SDK boundary and
 * the `features/editor` barrel. But `mock.module` mutates bun's module
 * registry for the entire `bun test` process, not just one file, and even
 * with the minimum mock set required for import-time survival plus
 * `mock.restore()` in `afterAll`, running the FULL suite with that file
 * present caused an unrelated, purely-functional test elsewhere
 * (`review-core.test.ts`'s `registerForActiveTurn` dedupe test — no mocks,
 * no I/O, fully deterministic inputs) to fail nondeterministically. Removing
 * only that one file from the run (everything else, including an unrelated
 * fix to a pre-existing incomplete mock in `auth.test.ts`, left in place)
 * made the full suite pass clean at 1307/1307 again. That is a real bug
 * surface in bun 1.2.11's `mock.module`/`mock.restore()` interaction, not a
 * bug in the store code — but it makes real execution too fragile to share
 * `bun test src`'s ONE process with everything else. It is NOT too fragile
 * for a permanent test outright: `search-tab-lifecycle.exec.ts` (this
 * file's real-execution companion, named so `bun test src`'s glob never
 * picks it up) does exactly that real execution, permanently, in its OWN
 * process via `bun run test:isolated` — where its `mock.module` calls can
 * never collide with `review-core.test.ts` or anything else. This file
 * carries the always-collected, zero-risk structural coverage; the `.exec.ts`
 * sibling carries the real-execution coverage on top of it. Full elimination
 * trail and exact commands for the original single-process attempt are in
 * the fix-round section of task-7-report.md.
 *
 * Every behaviour below is checked by reading `workspace.ts`'s (and, once,
 * `search.ts`'s) source text and asserting things about it — call order,
 * which branch a call sits inside, literal expressions used. None of these
 * assertions execute `openSearchTab`, `closeFile`, `setActiveFile`, or
 * `syncActiveSearchSession` — they inspect the code that defines them.
 */
const WORKSPACE_SOURCE = readFileSync(path.resolve(import.meta.dir, 'workspace.ts'), 'utf8');
const SEARCH_STORE_SOURCE = readFileSync(path.resolve(import.meta.dir, 'search.ts'), 'utf8');

function extractBody(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  if (start === -1) {
    throw new Error(`marker not found — has it been renamed? ${JSON.stringify(startMarker)}`);
  }
  const end = source.indexOf(endMarker, start);
  return source.slice(start, end === -1 ? start + 2500 : end);
}

const openSearchTabBody = extractBody(WORKSPACE_SOURCE, 'openSearchTab: (seed) => {', '\n  refreshTree:');
const closeFileBody = extractBody(WORKSPACE_SOURCE, 'closeFile: (path: string) => {', '\n  popRecentlyClosed:');
const setActiveFileBody = extractBody(WORKSPACE_SOURCE, 'setActiveFile: (path: string) => {', '\n  reorderTabs:');
const deletePathBody = extractBody(WORKSPACE_SOURCE, 'deletePath: async (path: string) => {', '\n  restartLsp:');
const syncActiveSearchSessionBody = extractBody(
  WORKSPACE_SOURCE,
  'function syncActiveSearchSession(path: string | null): void {',
  '\n\ninterface WorkspaceState',
);
const closeSessionBody = extractBody(SEARCH_STORE_SOURCE, 'closeSession: (id) => {', "\n}));");
const ensureSessionBody = extractBody(SEARCH_STORE_SOURCE, 'ensureSession: (id) =>', '\n\n  setActiveSession:');

describe('openSearchTab (source text — see file header)', () => {
  // Required behaviour 1: "openSearchTab() twice yields search://1 then
  // search://2, each with its own entry in sessions." Not executed; checked
  // via the id-generation expression and the fact that `ensureSession` is
  // called with that freshly-computed, monotonically-numbered path.
  it('computes each tab a `search://${n}` path, numbered from the count of already-open search tabs', () => {
    expect(openSearchTabBody).toMatch(
      /const used = get\(\)\.openFiles\.filter\(\(f\) => f\.path\.startsWith\('search:\/\/'\)\)\.length;/,
    );
    expect(openSearchTabBody).toMatch(/let n = used \+ 1;/);
    expect(openSearchTabBody).toContain('`search://${n}`');
  });

  // `used + 1` alone is not enough: with tabs search://1..3 open and
  // search://2 closed, `used` (a COUNT, 2) plus 1 gives `search://3` again —
  // colliding with the tab that's already there — unless something re-probes
  // for a live collision and keeps incrementing. That's this while loop; it
  // must run between computing `n` and freezing `path`.
  it('re-probes for a collision with a currently-open tab before freezing the path', () => {
    const nAssignIdx = openSearchTabBody.indexOf('let n = used + 1;');
    const loopIdx = openSearchTabBody.indexOf(
      "while (get().openFiles.some((f) => f.path === `search://${n}`)) n += 1;",
    );
    const pathAssignIdx = openSearchTabBody.indexOf('const path = `search://${n}`;');
    expect(nAssignIdx).toBeGreaterThan(-1);
    expect(loopIdx).toBeGreaterThan(nAssignIdx);
    expect(pathAssignIdx).toBeGreaterThan(loopIdx);
  });

  it('calls ensureSession with that freshly-computed path, giving each tab its own session entry', () => {
    const ensureIdx = openSearchTabBody.indexOf('ensureSession(path)');
    expect(ensureIdx).toBeGreaterThan(-1);
    // `path` here is the just-computed `search://${n}` from the block above
    // — confirm the assignment precedes the call, i.e. it's the SAME
    // variable, not some fixed/shared id.
    const pathAssignIdx = openSearchTabBody.indexOf('const path = `search://${n}`;');
    expect(pathAssignIdx).toBeGreaterThan(-1);
    expect(ensureIdx).toBeGreaterThan(pathAssignIdx);
  });

  // Required behaviour 5 (also load-bearing for behaviour 2, below):
  // `ensureSession` must run before `setActiveSession` — `setActiveSession`
  // does not itself create a session (established in an earlier review), so
  // pointing it at an id with no session would leave a consumer (e.g.
  // `SearchResultsTab`) reading `undefined`.
  it('calls ensureSession before setActiveSession', () => {
    const ensure = openSearchTabBody.indexOf('ensureSession(');
    const activate = openSearchTabBody.indexOf('setActiveSession(');
    expect(ensure).toBeGreaterThan(-1);
    expect(activate).toBeGreaterThan(-1);
    expect(activate).toBeGreaterThan(ensure);
  });

  // Required behaviour 2: "openSearchTab({ query: 'x' }) seeds
  // sessions[path].query === 'x' and points both activeSessionId and
  // activeFilePath at that path." Checked as three separate source facts:
  // the seed's query is threaded into the same `update(path, ...)` call,
  // `setActiveSession` is called with that same `path`, and the workspace
  // `set(...)` sets `activeFilePath` to that same `path` — not a literal,
  // not a different variable.
  it('threads seed.query into the same update(path, ...) call for the freshly-computed path', () => {
    expect(openSearchTabBody).toContain(
      "search.update(path, {",
    );
    expect(openSearchTabBody).toContain(
      "seed.query !== undefined ? { query: seed.query } : {}",
    );
  });

  it('activates the same path in both the search store and the workspace tab list', () => {
    expect(openSearchTabBody).toContain('search.setActiveSession(path);');
    expect(openSearchTabBody).toMatch(/openFiles: \[\.\.\.state\.openFiles, \{ path, name: 'Search'/);
    expect(openSearchTabBody).toContain('activeFilePath: path,');
    expect(openSearchTabBody).toContain('return path;');
  });

  // Required behaviour 3: "An unseeded openSearchTab() leaves an existing
  // session's fields untouched." This requires the `update(` call to be
  // NESTED inside the `seed?.query !== undefined || seed?.includePattern
  // !== undefined` guard, not merely textually AFTER it — an `if (...) { }`
  // followed by an unconditional `update(...)` below the closing brace would
  // satisfy an order check while running on every call, seeded or not. The
  // verbatim block below only matches if `search.update(path, {...})` and
  // its closing `});` sit BETWEEN the guard's `{` and its matching `}` —
  // move the call below that `}` and this literal stops appearing in the
  // source at all, which is what makes this a nesting check and not an
  // ordering check.
  it('nests the only update(...) call inside the seed-provided guard, so an unseeded call cannot touch any session', () => {
    expect(openSearchTabBody).toContain(
      "if (seed?.query !== undefined || seed?.includePattern !== undefined) {\n" +
        "      search.update(path, {\n" +
        "        ...(seed.query !== undefined ? { query: seed.query } : {}),\n" +
        "        ...(seed.includePattern !== undefined ? { includePattern: seed.includePattern } : {}),\n" +
        "      });\n" +
        "    }",
    );
    // ...and the ONLY update(...) call in the whole action body is this one
    // (no second, unconditional call elsewhere that would defeat the guard).
    const updateIdx = openSearchTabBody.indexOf('search.update(path,');
    expect(openSearchTabBody.indexOf('search.update(', updateIdx + 1)).toBe(-1);
  });
});

describe('closeFile (source text — see file header)', () => {
  // Required behaviour 4a: closeFile removes the closed path from openFiles
  // unconditionally (not specific to search tabs — this is the pre-existing
  // general behavior this task builds the search branch on top of).
  it('filters the closed path out of openFiles unconditionally', () => {
    expect(closeFileBody).toContain("state.openFiles.filter((f) => f.path !== path)");
  });

  // Required behaviour 4b: closeFile on a search tab deletes its sessions
  // entry (in the non-last-tab case). Checked in two parts: (i) closeFile
  // calls closeSession(path) for a search:// path, and (ii) closeSession's
  // OWN source (search.ts, also read as text, not executed) deletes that
  // id's key from `sessions` when it isn't the last one. Chaining these two
  // source facts is what stands in for "and deletes its sessions entry"
  // without running either function.
  it('calls closeSession(path) for a search:// tab before the rest of the teardown', () => {
    const guardIdx = closeFileBody.indexOf("if (path.startsWith('search://')) {");
    const closeSessionIdx = closeFileBody.indexOf('useSearchStore.getState().closeSession(path);');
    // The first thing closeFile does after its own signature is this guard —
    // nothing else in the body (LSP notify, diagnostics clear, model
    // dispose) appears before it.
    const lspNotifyIdx = closeFileBody.indexOf("Notify the LSP server for this file's language");
    const disposeIdx = closeFileBody.indexOf('disposeModelForPath(path);');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(closeSessionIdx).toBeGreaterThan(guardIdx);
    expect(guardIdx).toBeLessThan(lspNotifyIdx);
    expect(closeSessionIdx).toBeLessThan(disposeIdx);
  });

  it('closeSession itself deletes the closing id from `sessions` (search.ts source)', () => {
    expect(closeSessionBody).toContain('delete next[id];');
  });

  // Finding 3: closeFile's "fall back to the last remaining tab" branch must
  // resync activeSessionId when that fallback lands on a search:// tab.
  it('resyncs activeSessionId (via syncActiveSearchSession) with whatever tab ends up active after a close', () => {
    const setCallIdx = closeFileBody.lastIndexOf('set((state) => {');
    const syncIdx = closeFileBody.indexOf('syncActiveSearchSession(get().activeFilePath);');
    expect(syncIdx).toBeGreaterThan(-1);
    expect(syncIdx).toBeGreaterThan(setCallIdx);
  });
});

describe('ensureSession (source text — see file header)', () => {
  // Required behaviour 3 also depends on this, on the OTHER side of the same
  // coin: `ensureSession` must be create-IF-ABSENT, not create-always — an
  // `ensureSession` that unconditionally overwrites would silently reset a
  // reused id's session on every later `openSearchTab()` call, which is
  // exactly what "leaves an existing session's fields untouched" rules out.
  // Pinned the same way `closeSession`'s delete is pinned above: read the
  // literal guard, not just call it and hope.
  it('only creates a session when one is absent (search.ts source)', () => {
    expect(ensureSessionBody).toContain(
      's.sessions[id] ? s : { sessions: { ...s.sessions, [id]: createSession(id) } }',
    );
  });
});

describe('setActiveFile (source text — see file header)', () => {
  // Finding 3: a TabBar click (setActiveFile) landing on a search:// tab
  // must resync activeSessionId — this is the path `tab.next`/`tab.prev`
  // and every TabBar click go through (confirmed by reading App.tsx and
  // TabBar.tsx — see task-7-report.md's fix-round section for the exact
  // call sites checked).
  it('calls syncActiveSearchSession(path) after activating the tab', () => {
    const setIdx = setActiveFileBody.indexOf('set({ activeFilePath: path });');
    const syncIdx = setActiveFileBody.indexOf('syncActiveSearchSession(path);');
    expect(setIdx).toBeGreaterThan(-1);
    expect(syncIdx).toBeGreaterThan(setIdx);
  });
});

describe('deletePath (source text — see file header)', () => {
  // Fix round 2, Item 1: deleting the active file falls back to
  // `openFiles[openFiles.length - 1]`, exactly like closeFile's fallback —
  // and that fallback tab can be a search:// one. A full sweep of every
  // `activeFilePath` assignment site in this file found this as the one
  // other place (besides setActiveFile and closeFile) that can land on an
  // already-open search tab; `openFile`, `renamePath`, and the diff-tab
  // sites cannot produce a search path, and `setWorkspace` nulls
  // `activeFilePath` outright.
  it('resyncs activeSessionId after its fallback-to-last-remaining-tab branch', () => {
    const setCallIdx = deletePathBody.indexOf('set((state) => {');
    const syncIdx = deletePathBody.indexOf('syncActiveSearchSession(get().activeFilePath);');
    expect(setCallIdx).toBeGreaterThan(-1);
    expect(syncIdx).toBeGreaterThan(setCallIdx);
  });
});

describe('syncActiveSearchSession (source text — see file header)', () => {
  it('no-ops for a null or non-search path', () => {
    expect(syncActiveSearchSessionBody).toContain(
      "if (!path || !path.startsWith('search://')) return;",
    );
  });

  it('only calls setActiveSession — never ensureSession, so it cannot create a session', () => {
    expect(syncActiveSearchSessionBody).toContain('useSearchStore.getState().setActiveSession(path);');
    expect(syncActiveSearchSessionBody).not.toContain('ensureSession(');
  });
});
