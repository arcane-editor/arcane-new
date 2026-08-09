# Phase 0 + 1: Windows CI, Invoke Guard, and Blocker Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Windows behaviour verifiable in CI, close the invoke-argument bug class that killed three features, and fix every blocker that loses user work or leaves a shipped platform broken.

**Architecture:** Phase 0 lands the verification substrate first — a CI matrix that actually runs the test suite on `windows-latest`, plus a static checker that compares TypeScript `invoke()` payloads against Rust `#[tauri::command]` signatures. Phase 1 then fixes the confirmed blockers, each with a test that would have caught it.

**Tech Stack:** Rust (Tauri v2, portable-pty 0.9), TypeScript/React 19, Zustand, bun test, cargo test, GitHub Actions.

## Global Constraints

- Package manager is **bun**. Test runner is `bun test`, not vitest/jest.
- Rust tests run with `cargo test --lib` from `editor/src-tauri`.
- Full local gate is `bun run verify` (tsc + check:modules + bun test + cargo test + verify:intellisense). Run it before declaring any task done.
- Module boundaries: import features only via `src/features/<name>/index.ts`. `bun run check:modules` enforces this.
- Any keybinding change must be grepped against **both** `src/App.tsx` and `src-tauri/src/menu.rs` (see `editor/CLAUDE.md`).
- No new runtime dependencies in Phase 0 or 1.
- Paths in this plan are relative to `editor/` unless prefixed with `.github/`.
- Findings referenced as C1/H4/M9 etc. are catalogued in `docs/superpowers/specs/2026-08-09-ide-production-readiness-audit.md`.

---

## File Structure

**Created**
- `.github/workflows/ci.yml` — test matrix on windows-latest + macos-14
- `editor/scripts/check-invoke-args.mjs` — static TS↔Rust invoke argument checker
- `editor/scripts/check-invoke-args.test.ts` — tests for the checker's parsers
- `editor/src-tauri/src/process_util.rs` — one place that owns Windows process-creation flags
- `editor/src/utils/model-uri.ts` — single source of truth for Monaco/LSP document URIs
- `editor/src/utils/model-uri.test.ts`
- `editor/src-tauri/src/cli.rs` — `--goto` argv parsing
- `editor/src/features/git/components/ConfirmDiscardDialog.tsx`

**Modified**
- `editor/src-tauri/src/terminal.rs` — Windows PTY writer; writer taken before spawn
- `editor/src-tauri/src/unity.rs` — Windows Unity Hub discovery
- `editor/src-tauri/src/dap.rs` — platform-correct mono discovery
- `editor/src-tauri/src/lib.rs` — argv handling, `process_util` wiring, `mod cli`
- `editor/src-tauri/src/git.rs` — `Command::new` → `process_util::command`
- `editor/src-tauri/src/menu.rs` — free `CmdOrCtrl+Shift+T`
- `editor/src-tauri/tauri.conf.json` — platform-conditional decorations
- `editor/src/features/explorer/components/ExplorerPanel.tsx` — Refresh/Collapse All
- `editor/src/features/git/components/SourceControlPanel.tsx` — discard confirmation
- `editor/src/features/unity-hierarchy/services/open-script.ts` — invoke args
- `editor/src/features/unity-quick-open/components/UnityAssetPickerModal.tsx` — invoke args
- `editor/src/features/editor/components/EditorPanel.tsx` — use `model-uri.ts`
- `editor/src/stores/workspace.ts` — dispose Monaco models on close
- `editor/src/stores/search.ts` — drop the hardcoded `.cs` limit
- `editor/src/App.css` — platform-conditional title bar
- `editor/src/main.tsx` — stamp platform on `<html>`
- `editor/package.json` — wire `check:invoke` into `verify`

---

## Task 1: CI runs the test suite on Windows

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: a required status check named `test (windows-latest)` and `test (macos-14)`.

- [ ] **Step 1: Write the workflow**

```yaml
name: CI

on:
  push:
    branches: ['**']
  pull_request:

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [windows-latest, macos-14]
    runs-on: ${{ matrix.os }}
    defaults:
      run:
        shell: bash
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - uses: dtolnay/rust-toolchain@stable
      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: editor/src-tauri

      - name: Install JS deps
        run: cd editor && bun install --frozen-lockfile

      - name: Typecheck
        run: cd editor && bunx tsc --noEmit

      - name: Module boundaries
        run: cd editor && bun run check:modules

      - name: Invoke arguments
        run: cd editor && bun run check:invoke

      - name: JS tests
        run: cd editor && bun test src

      # verify:intellisense is deliberately NOT run here. It needs a real Unity
      # install and has skip semantics (ARCANE_INTELLISENSE_E2E=required) that
      # make a CI skip indistinguishable from a pass. It stays a local gate via
      # `bun run verify`. Do not "fix" this by adding it with a quiet skip.
      - name: Rust tests
        run: cd editor/src-tauri && cargo test --lib
```

- [ ] **Step 2: Verify the workflow parses**

Run: `cd /Users/inno/Documents/experiments/arcane-editor && bunx yaml-lint .github/workflows/ci.yml 2>/dev/null || node -e "require('js-yaml')" 2>/dev/null || python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml')); print('valid')"`
Expected: `valid` (or no error).

- [ ] **Step 3: Confirm the suite passes locally on macOS first**

Run: `cd editor && bunx tsc --noEmit && bun run check:modules && bun test src && (cd src-tauri && cargo test --lib)`
Expected: all pass. This is the baseline; Windows is the unknown.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run the editor test suite on windows-latest and macos-14

Neither release.yml nor dev-build.yml has ever run a test — they only
build. bun run verify has only ever run on one developer's Mac."
```

**Note for the executor:** the `check:invoke` step will fail until Task 2 lands. Land Task 1 and Task 2 in sequence before pushing, or temporarily drop that step and re-add it in Task 2's commit.

---

## Task 2: Static invoke-argument checker

The root cause of three dead features. `fuzzy_search_files` requires `max_results` and `extra_excludes` (neither `Option`); two call sites pass `limit` and omit `extraExcludes`, and both swallow the rejection.

**Files:**
- Create: `editor/scripts/check-invoke-args.mjs`
- Create: `editor/scripts/check-invoke-args.test.ts`
- Modify: `editor/package.json`

**Interfaces:**
- Produces: `parseRustCommands(source) -> Map<string, {required: string[], optional: string[]}>`, `parseInvokeCalls(source, file) -> Array<{command, keys, line, checked}>`, `checkAll({rustSources, tsSources}) -> {violations, unchecked}`. Exported from the `.mjs` so tests can import them.

- [ ] **Step 1: Write the failing tests**

```ts
// editor/scripts/check-invoke-args.test.ts
import { describe, it, expect } from 'bun:test';
import { parseRustCommands, parseInvokeCalls, checkAll } from './check-invoke-args.mjs';

describe('parseRustCommands', () => {
  it('records required and optional params, skipping Tauri-injected ones', () => {
    const src = `
#[tauri::command]
pub fn fuzzy_search_files(
    state: tauri::State<'_, file_index::FileIndexState>,
    window: tauri::Window,
    workspace_path: String,
    query: String,
    max_results: usize,
    extra_excludes: Vec<String>,
    file_extensions: Option<Vec<String>>,
) -> Result<Vec<FuzzyFileResult>, String> {}
`;
    const cmds = parseRustCommands(src);
    expect(cmds.get('fuzzy_search_files')).toEqual({
      required: ['workspacePath', 'query', 'maxResults', 'extraExcludes'],
      optional: ['fileExtensions'],
    });
  });

  it('handles a single-line signature', () => {
    const src = `#[tauri::command]\nfn read_file(path: String) -> Result<String, String> {}`;
    expect(parseRustCommands(src).get('read_file')).toEqual({ required: ['path'], optional: [] });
  });
});

describe('parseInvokeCalls', () => {
  it('extracts keys from an object literal', () => {
    const src = `await invoke<Foo[]>('fuzzy_search_files', { workspacePath: ws, query: type, limit: 20, fileExtensions: ['cs'] });`;
    const calls = parseInvokeCalls(src, 'a.ts');
    expect(calls[0].command).toBe('fuzzy_search_files');
    expect(calls[0].keys.sort()).toEqual(['fileExtensions', 'limit', 'query', 'workspacePath']);
    expect(calls[0].checked).toBe(true);
  });

  it('marks a non-literal payload as unchecked rather than passing it', () => {
    const src = `await invoke('start_content_search', payload);`;
    const calls = parseInvokeCalls(src, 'a.ts');
    expect(calls[0].checked).toBe(false);
  });
});

describe('checkAll', () => {
  const rust = `
#[tauri::command]
pub fn fuzzy_search_files(workspace_path: String, query: String, max_results: usize, extra_excludes: Vec<String>, file_extensions: Option<Vec<String>>) -> Result<(), String> {}
`;

  it('reports a missing required argument and an unknown key', () => {
    const ts = `invoke('fuzzy_search_files', { workspacePath: ws, query: q, limit: 20 });`;
    const { violations } = checkAll({
      rustSources: [{ file: 'file_scanner.rs', text: rust }],
      tsSources: [{ file: 'open-script.ts', text: ts }],
    });
    const missing = violations.find((v) => v.kind === 'missing');
    expect(missing.missing.sort()).toEqual(['extraExcludes', 'maxResults']);
    const unknown = violations.find((v) => v.kind === 'unknown');
    expect(unknown.unknown).toEqual(['limit']);
  });

  it('passes a correct call', () => {
    const ts = `invoke('fuzzy_search_files', { workspacePath: ws, query: q, maxResults: 100, extraExcludes: [] });`;
    const { violations } = checkAll({
      rustSources: [{ file: 'file_scanner.rs', text: rust }],
      tsSources: [{ file: 'PaletteModal.tsx', text: ts }],
    });
    expect(violations).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd editor && bun test scripts/check-invoke-args.test.ts`
Expected: FAIL — cannot resolve `./check-invoke-args.mjs`.

- [ ] **Step 3: Implement the checker**

Key implementation points (write the full file):
- `parseRustCommands`: regex for `#[tauri::command]` followed by `(pub )?(async )?fn <name>(<params>)`. Params split at depth-0 commas so `Vec<String>` and `tauri::State<'_, T>` survive. Drop any param whose type starts with `tauri::` or is `AppHandle`/`Window`/`State`. A param is optional when its type starts with `Option<`.
- `snakeToCamel(name)`: `max_results` → `maxResults`.
- `parseInvokeCalls`: find `invoke` followed by optional `<...>` generics then `(`; read the first argument — accept `'name'` or `"name"` only; then if the next non-space char is `{`, take the balanced brace span and pull top-level `key:` / `key,` identifiers, ignoring nested braces, strings, and template literals. Otherwise mark `checked: false`.
- `checkAll`: for each checked call whose command exists in the Rust map, report `kind: 'missing'` for required params absent from the keys, and `kind: 'unknown'` for keys in neither required nor optional. Calls naming a command not found in Rust are reported as `kind: 'no-such-command'`.
- CLI entry (only when run directly): walk `src-tauri/src/**/*.rs` and `src/**/*.{ts,tsx}` (skipping `*.test.*` and `node_modules`), print violations with `file:line`, print the unchecked count, exit 1 on any violation.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd editor && bun test scripts/check-invoke-args.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Run the checker against the real codebase**

Run: `cd editor && node scripts/check-invoke-args.mjs`
Expected: FAIL, reporting at minimum `open-script.ts` and `UnityAssetPickerModal.tsx` missing `maxResults` + `extraExcludes` and passing unknown key `limit`. Record the full violation list — it is the input to Task 3.

- [ ] **Step 6: Wire into package.json**

Add to `scripts`: `"check:invoke": "node scripts/check-invoke-args.mjs"`, and insert `bun run check:invoke && ` into `verify` immediately after `bun run check:modules && `.

- [ ] **Step 7: Commit**

```bash
git add editor/scripts/check-invoke-args.mjs editor/scripts/check-invoke-args.test.ts editor/package.json .github/workflows/ci.yml
git commit -m "ci: statically check invoke() args against tauri command signatures

254 invoke sites across 118 commands are matched to 131 Rust commands by
hand, with nothing checking either side. A mismatch fails at runtime and
is swallowed by the caller's catch."
```

---

## Task 3: Fix the three dead invoke call sites

**Files:**
- Modify: `src/features/unity-hierarchy/services/open-script.ts:22-27`
- Modify: `src/features/unity-quick-open/components/UnityAssetPickerModal.tsx:46-51`

**Interfaces:**
- Consumes: the violation list from Task 2 Step 5.

- [ ] **Step 1: Verify the checker currently fails**

Run: `cd editor && bun run check:invoke`
Expected: FAIL naming both files.

- [ ] **Step 2: Fix `open-script.ts`**

Replace the invoke payload:

```ts
    const results = await invoke<FuzzyFileResult[]>('fuzzy_search_files', {
      workspacePath: ws,
      query: type,
      maxResults: 20,
      extraExcludes: useWorkspaceStore.getState().extraExcludePatterns ?? [],
      fileExtensions: ['cs'],
    });
```

Also stop swallowing silently — replace the bare `catch { return false }` with a `catch (err) { console.warn('[Hierarchy] script lookup failed', err); return false; }`. The caller's handling of `false` is fixed in Phase 3.

- [ ] **Step 3: Fix `UnityAssetPickerModal.tsx`**

Change `limit: 50` to `maxResults: 50` and add `extraExcludes: useWorkspaceStore.getState().extraExcludePatterns ?? []`. Replace `catch { setResults([]) }` with a catch that also sets an error string rendered in the modal, so a future failure is visible rather than presenting as "no results".

- [ ] **Step 4: Verify**

Run: `cd editor && bun run check:invoke && bunx tsc --noEmit`
Expected: PASS, zero violations.

- [ ] **Step 5: Commit**

```bash
git add src/features/unity-hierarchy/services/open-script.ts src/features/unity-quick-open/components/UnityAssetPickerModal.tsx
git commit -m "fix(unity): revive three features that never once worked

fuzzy_search_files requires maxResults + extraExcludes; these two call
sites passed 'limit' and omitted extraExcludes, so Tauri rejected every
call and both catch blocks swallowed it. Hierarchy script clicks and
Unity: Open Scene / Find Asset have always been dead."
```

---

## Task 4: Implement the Windows PTY writer

`terminal.rs:430` is an unimplemented stub. `terminal_spawn` opens the PTY and spawns the shell *before* reaching it, so every attempt on Windows also leaks a shell process.

**Files:**
- Modify: `src-tauri/src/terminal.rs:153, 414-433, 569-585`

**Interfaces:**
- Produces: `clone_master_as_writer(&dyn MasterPty) -> Result<Box<dyn Write + Send>, String>` on all platforms.

- [ ] **Step 1: Write the failing test**

```rust
    // in terminal.rs's #[cfg(test)] mod
    #[test]
    fn master_writer_is_available_on_every_platform() {
        // The Windows build shipped a stub that always returned Err, so the
        // terminal could never start on the platform most Unity devs use.
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .expect("openpty");
        let writer = clone_master_as_writer(pair.master.as_ref());
        assert!(writer.is_ok(), "no PTY writer on this platform: {:?}", writer.err());
    }
```

Note: this test is **not** `#[cfg(unix)]`. That gate is what let the stub survive.

- [ ] **Step 2: Run to verify it fails on Windows / passes on macOS**

Run: `cd src-tauri && cargo test --lib master_writer_is_available`
Expected on macOS: PASS (it already worked). Expected on Windows CI: FAIL with "Windows PTY writer not implemented". macOS cannot prove this one — CI is the gate, which is why Task 1 comes first.

- [ ] **Step 3: Change the writer type and implement Windows**

At line 153, change the struct field:

```rust
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
```

Replace both `clone_master_as_writer` implementations:

```rust
#[cfg(unix)]
fn clone_master_as_writer(master: &dyn MasterPty) -> Result<Box<dyn Write + Send>, String> {
    use std::os::unix::io::FromRawFd;

    let raw_fd = master
        .as_raw_fd()
        .ok_or_else(|| "Failed to get raw fd from master PTY".to_string())?;

    let dup_fd = unsafe { libc::dup(raw_fd) };
    if dup_fd < 0 {
        return Err("Failed to duplicate master PTY fd".to_string());
    }

    Ok(Box::new(unsafe { std::fs::File::from_raw_fd(dup_fd) }))
}

/// ConPTY has no fd to dup, so take portable-pty's own writer. `take_writer`
/// may only be called once per master, which is exactly how this is used:
/// `terminal_spawn` calls it a single time and stores the result.
#[cfg(windows)]
fn clone_master_as_writer(master: &dyn MasterPty) -> Result<Box<dyn Write + Send>, String> {
    master
        .take_writer()
        .map_err(|e| format!("Failed to take PTY writer: {}", e))
}
```

At line 636, the `writer: Arc::new(Mutex::new(writer))` needs no change — `writer` is now already boxed.

- [ ] **Step 4: Move the writer acquisition before `spawn_command`**

The current order leaks a shell on any writer failure. Move the `let writer = clone_master_as_writer(pair.master.as_ref())?;` line from after `spawn_command` to **immediately before** `let mut child = pair.slave.spawn_command(cmd)`. Nothing between them depends on the child.

- [ ] **Step 5: Verify**

Run: `cd src-tauri && cargo test --lib && cargo build`
Expected: PASS. Then run the app and open a terminal to confirm no macOS regression: `cd editor && bun run tauri:dev-app`.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/terminal.rs
git commit -m "fix(terminal): implement the Windows PTY writer

clone_master_as_writer was an unimplemented stub returning Err on
Windows, propagated by ? after openpty and spawn_command — so the
terminal could never open and every attempt leaked a cmd.exe. Use
portable-pty's take_writer, and acquire the writer before spawning so
the failure path cannot orphan a shell.

The regression test is deliberately not #[cfg(unix)]: that gate is why
this shipped."
```

---

## Task 5: Explorer Refresh and Collapse All stop destroying unsaved work

Both buttons call `setWorkspace()`, the full workspace-switch action: it closes every tab with no dirty check, kills every terminal, resets the AI conversation, and clears `recentlyClosed` so Cmd+Shift+T cannot recover it.

**Files:**
- Modify: `src/features/explorer/components/ExplorerPanel.tsx:403-405, 512-521`
- Test: `src/features/explorer/refresh-actions.test.ts` (create)

**Interfaces:**
- Consumes: `useWorkspaceStore.getState().refreshTree()` (exists, `workspace.ts:1491`).

- [ ] **Step 1: Write the failing test**

```ts
// src/features/explorer/refresh-actions.test.ts
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const PANEL = readFileSync(
  path.resolve(import.meta.dir, 'components/ExplorerPanel.tsx'),
  'utf8',
);

describe('explorer header actions', () => {
  // A behavioural test would need the whole Tauri surface mocked. What
  // actually regressed is a single wrong call, so assert on that directly:
  // setWorkspace closes every tab without a dirty prompt (audit C2/H5).
  it('never calls setWorkspace — that discards unsaved editor state', () => {
    expect(PANEL).not.toMatch(/setWorkspace\s*\(/);
  });

  it('refreshes the tree instead', () => {
    expect(PANEL).toMatch(/refreshTree\s*\(/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd editor && bun test src/features/explorer/refresh-actions.test.ts`
Expected: FAIL — `setWorkspace(` is present twice.

- [ ] **Step 3: Fix Refresh**

```tsx
  function handleRefresh() {
    void useWorkspaceStore.getState().refreshTree();
  }
```

Remove the now-unused `setWorkspace` selector binding at line 175.

- [ ] **Step 4: Fix Collapse All**

Collapse All must not touch the workspace at all — it is a pure view operation. react-arborist owns the expansion state, and its imperative handle is already wired at `ExplorerPanel.tsx:198` as `treeApiRef` (used today by `revealPath`). `TreeApi` exposes `closeAll()`:

```tsx
          <button
            className="explorer-action-btn"
            title="Collapse All"
            onClick={() => treeApiRef.current?.closeAll()}
          >
            <ChevronsDownUp size={14} />
          </button>
```

Delete the `// Collapse all by re-setting workspace (reloads root)` comment along with the call it explains.

- [ ] **Step 5: Verify**

Run: `cd editor && bun test src/features/explorer/refresh-actions.test.ts && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Manual check**

Open a file, type without saving, click Refresh in the Explorer header. The tab must stay open and still dirty.

- [ ] **Step 7: Commit**

```bash
git add src/features/explorer/
git commit -m "fix(explorer): Refresh no longer discards every unsaved edit

Refresh and Collapse All both called setWorkspace(), which closes all
tabs with no dirty prompt, kills every terminal, resets the AI thread,
and clears recentlyClosed so Cmd+Shift+T cannot undo it. Refresh now
calls refreshTree(); Collapse All is view-only."
```

---

## Task 6: Confirm before discarding changes

`Discard All` runs `git checkout -- .` plus `git clean -fd` immediately, and its button sits directly beside `Stage All`. Untracked files are unrecoverable.

**Files:**
- Create: `src/features/git/components/ConfirmDiscardDialog.tsx`
- Modify: `src/features/git/components/SourceControlPanel.tsx:588-593, 618`

**Interfaces:**
- Produces: `<ConfirmDiscardDialog open scope={'all'|'file'} trackedCount untrackedCount fileName? onConfirm onCancel />`

- [ ] **Step 1: Write the failing test**

```ts
// src/features/git/discard-confirm.test.ts
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const PANEL = readFileSync(
  path.resolve(import.meta.dir, 'components/SourceControlPanel.tsx'),
  'utf8',
);

describe('discard confirmation', () => {
  it('does not call discardAll directly from the button handler', () => {
    // The Discard All button sits beside Stage All; a misclick ran
    // `git checkout -- .` + `git clean -fd` with no dialog (audit H6).
    expect(PANEL).not.toMatch(/onClick=\{[^}]*discardAll\(/s);
  });

  it('routes discard through the confirmation dialog', () => {
    expect(PANEL).toMatch(/ConfirmDiscardDialog/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd editor && bun test src/features/git/discard-confirm.test.ts`
Expected: FAIL on both assertions.

- [ ] **Step 3: Write the dialog**

A modal following the existing app-modal CSS classes (`app-modal-fade` / `app-modal-rise` keyframes exist in `App.css`). Copy requirements:
- Title: `Discard changes?`
- Body names counts explicitly: `N tracked file(s) will be reverted to HEAD.`
- When `untrackedCount > 0`, a separate warning line: `M new file(s) will be deleted permanently. They are not in git and cannot be recovered.`
- Buttons: `Cancel` (default focus) and a destructive-styled `Discard`.
- Escape cancels; Enter does **not** confirm.

- [ ] **Step 4: Wire both call sites**

Discard All (line ~590) and per-file discard (line ~618) both open the dialog with the right scope and counts, calling `discardAll` / `discardFile` only from `onConfirm`. Untracked counts come from `unstagedRows.filter(f => f.status === 'untracked').length`.

- [ ] **Step 5: Verify**

Run: `cd editor && bun test src/features/git/ && bunx tsc --noEmit && bun run check:modules`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/features/git/
git commit -m "fix(git): confirm before discarding, and say what is unrecoverable

Discard All ran git checkout -- . plus git clean -fd on one click, from
a button adjacent to Stage All. The dialog names the tracked count and
warns separately about untracked files, which are in no stash and no
commit."
```

---

## Task 7: Dispose Monaco models on tab close

Models are never disposed. An orphan model still holds text the user explicitly discarded; an LSP rename that touches that file finds the orphan via `findModelForUri` and writes the whole buffer to disk.

**Files:**
- Modify: `src/stores/workspace.ts:1197-1221` (`closeFile`)
- Test: `src/stores/model-disposal.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// src/stores/model-disposal.test.ts
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const STORE = readFileSync(path.resolve(import.meta.dir, 'workspace.ts'), 'utf8');

describe('closeFile', () => {
  it('disposes the Monaco model for the closed path', () => {
    // Undisposed models let an LSP rename write a discarded buffer back
    // to disk, and leak memory for the session (audit H4).
    const closeFile = STORE.slice(STORE.indexOf('closeFile:'), STORE.indexOf('closeFile:') + 2000);
    expect(closeFile).toMatch(/disposeModelForPath|model\.dispose\(\)/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd editor && bun test src/stores/model-disposal.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add the disposal helper**

In `src/utils/model-uri.ts` (created in Task 11 — if executing out of order, create the file now with just this function):

```ts
import * as monaco from 'monaco-editor';
import { toModelUri } from './model-uri';

/** Dispose the Monaco text model backing `path`, if one exists. */
export function disposeModelForPath(path: string): void {
  const model = monaco.editor.getModel(monaco.Uri.parse(toModelUri(path)));
  model?.dispose();
}
```

- [ ] **Step 4: Call it from `closeFile`**

After the `didClose` notification and before the store mutation, call `disposeModelForPath(path)`. Order matters: the LSP must be told the document closed while the model still exists.

- [ ] **Step 5: Verify**

Run: `cd editor && bun test src/stores/ && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Manual check**

Open a file, type, Cmd+W, "Close Anyway". Reopen it — the file must show its on-disk content, not the discarded edits.

- [ ] **Step 7: Commit**

```bash
git add src/stores/workspace.ts src/utils/model-uri.ts
git commit -m "fix(editor): dispose Monaco models on tab close

An undisposed model kept the text the user discarded. findModelForUri
would find that orphan during an LSP rename and write the whole buffer
to disk, reverting the file to a version the user explicitly threw away
and overwriting anything Unity or git had written since."
```

---

## Task 8: Search stops being silently limited to `.cs`

In a Unity project, `fileExtensions: ['cs']` is hardcoded, and the backend ANDs it with the include glob, so `*.shader` in "files to include" can never re-admit a file.

**Files:**
- Modify: `src/stores/search.ts:156`
- Test: `src/stores/search-scope.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// src/stores/search-scope.test.ts
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const STORE = readFileSync(path.resolve(import.meta.dir, 'search.ts'), 'utf8');

describe('content search scope', () => {
  it('does not hardcode a .cs-only extension filter', () => {
    // Shaders, .asmdef, .uxml, .json and prefab/scene YAML were all
    // unsearchable, and the include glob could not override it (audit H7).
    expect(STORE).not.toMatch(/fileExtensions:\s*isUnity\s*\?\s*\['cs'\]/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd editor && bun test src/stores/search-scope.test.ts`
Expected: FAIL.

- [ ] **Step 3: Remove the limit**

Change `fileExtensions: isUnity ? ['cs'] : null,` to `fileExtensions: null,`.

The `.cs` restriction existed to keep Unity searches fast. The real cost driver is `Library/` and `Temp/`, which `walk_policy.rs` already excludes — the extension filter was the wrong lever. If a follow-up shows a genuine perf problem, the fix is a default exclude glob surfaced in the UI, not a silent filter.

- [ ] **Step 4: Verify**

Run: `cd editor && bun test src/stores/ && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Manual check**

In a Unity project, search for a string that exists only in a `.shader` or `.asmdef`. It must be found.

- [ ] **Step 6: Commit**

```bash
git add src/stores/search.ts
git commit -m "fix(search): stop silently restricting Unity search to .cs

Shaders, asmdefs, UXML, JSON and prefab/scene YAML were unsearchable,
and typing *.shader into 'files to include' could not override it — the
backend ANDs the include glob with the extension list. Nothing in the
UI said so; the panel just reported 'No results found'."
```

---

## Task 9: Read `--goto` from argv

Unity launches `Arcane.exe --goto "<path>:<line>:<col>" "<projectPath>"`. Nothing reads it, so double-clicking a script in Unity opens the Welcome window.

**Files:**
- Create: `src-tauri/src/cli.rs`
- Modify: `src-tauri/src/lib.rs:683-689` and the startup path

**Interfaces:**
- Produces: `pub struct GotoTarget { pub file: String, pub line: u32, pub column: u32, pub project: Option<String> }` and `pub fn parse_goto(argv: &[String]) -> Option<GotoTarget>`.

- [ ] **Step 1: Write the failing test**

```rust
// src-tauri/src/cli.rs — #[cfg(test)] mod tests
    #[test]
    fn parses_a_posix_goto() {
        let argv = vec![
            "arcane".into(),
            "--goto".into(),
            "/Users/me/Proj/Assets/Player.cs:42:7".into(),
            "/Users/me/Proj".into(),
        ];
        let t = parse_goto(&argv).expect("parsed");
        assert_eq!(t.file, "/Users/me/Proj/Assets/Player.cs");
        assert_eq!(t.line, 42);
        assert_eq!(t.column, 7);
        assert_eq!(t.project.as_deref(), Some("/Users/me/Proj"));
    }

    #[test]
    fn parses_a_windows_goto_with_a_drive_letter() {
        // C:\... carries its own colon. Splitting from the left loses the drive.
        let argv = vec![
            "Arcane.exe".into(),
            "--goto".into(),
            r"C:\Proj\Assets\Player.cs:42:1".into(),
            r"C:\Proj".into(),
        ];
        let t = parse_goto(&argv).expect("parsed");
        assert_eq!(t.file, r"C:\Proj\Assets\Player.cs");
        assert_eq!(t.line, 42);
        assert_eq!(t.column, 1);
    }

    #[test]
    fn tolerates_a_missing_column() {
        let argv = vec!["arcane".into(), "--goto".into(), "/a/b.cs:9".into()];
        let t = parse_goto(&argv).expect("parsed");
        assert_eq!(t.line, 9);
        assert_eq!(t.column, 1);
    }

    #[test]
    fn returns_none_without_the_flag() {
        assert!(parse_goto(&["arcane".to_string()]).is_none());
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && cargo test --lib cli::`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `parse_goto`**

Split the target **from the right**, at most twice, and only accept a segment as line/column when it parses as `u32`. That is what makes `C:\Proj\Foo.cs:42:1` work while `C:\Proj\Foo.cs` alone still yields no line. The first non-flag argument after the target is the project path.

- [ ] **Step 4: Run tests**

Run: `cd src-tauri && cargo test --lib cli::`
Expected: PASS, 4 tests.

- [ ] **Step 5: Wire both entry paths**

Add `mod cli;` to `lib.rs`. In the single-instance callback, when there is no deep link, call `parse_goto(argv)`; on `Some(target)`, open/focus the project window for `target.project` and emit a `goto-file` event carrying the file, line and column instead of calling `open_or_focus_welcome`. On cold start, do the same from `std::env::args().collect()` in `setup`, before the welcome window would otherwise be shown.

Frontend: listen for `goto-file` and route through the existing `editor-navigation` pending-navigation utility (`src/utils/editor-navigation.ts`), which `EditorPanel` already consumes.

- [ ] **Step 6: Verify**

Run: `cd src-tauri && cargo test --lib && cd .. && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/cli.rs src-tauri/src/lib.rs src/
git commit -m "feat(cli): honour Unity's --goto so double-click opens the script

Unity launches Arcane.exe --goto <path>:<line>:<col> <project>. argv was
never read, so the core Unity-to-IDE workflow opened the 720x480 Welcome
window instead of the file. Parses from the right so a Windows drive
letter colon survives."
```

---

## Task 10: Unity Hub discovery on Windows

The Windows branch builds one hard-coded path from `C:\Program Files\Unity\Hub\Editor`. A Hub installed anywhere else means no `.csproj`, no `.sln`, and silently dead C# IntelliSense. macOS has a Hub-JSON fallback; Windows has none.

**Files:**
- Modify: `src-tauri/src/unity.rs:262-330, 370-389`

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn windows_hub_secondary_install_path_is_honoured() {
        // Unity Hub prompts for an install location at setup and a second
        // drive is a common choice. Probing only C:\Program Files means
        // every hover, completion and diagnostic silently returns nothing.
        let tmp = tempfile::tempdir().unwrap();
        let editor_dir = tmp.path().join("6000.0.23f1").join("Editor");
        std::fs::create_dir_all(&editor_dir).unwrap();
        std::fs::write(editor_dir.join("Unity.exe"), b"").unwrap();

        let found = resolve_from_hub_roots(&[tmp.path().to_path_buf()], "6000.0.23f1");
        assert_eq!(found, Some(editor_dir.join("Unity.exe")));
    }

    #[test]
    fn hub_roots_reads_secondary_install_path_json() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join("secondaryInstallPath.json"),
            r#""D:\\Unity\\Hub\\Editor""#,
        )
        .unwrap();
        let roots = hub_roots_from_config_dir(tmp.path());
        assert!(roots.iter().any(|p| p.ends_with("Editor")));
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && cargo test --lib hub`
Expected: FAIL — functions do not exist.

- [ ] **Step 3: Implement**

Add two platform-neutral helpers so they are testable on macOS:

- `hub_roots_from_config_dir(dir: &Path) -> Vec<PathBuf>` — reads `secondaryInstallPath.json` (a bare JSON string) and returns it plus any `editors-v2.json` locations found there.
- `resolve_from_hub_roots(roots: &[PathBuf], version: &str) -> Option<PathBuf>` — for each root, probe `<root>/<version>/Editor/Unity.exe` on Windows, `<root>/<version>/Unity.app` on macOS.

Then in the `#[cfg(target_os = "windows")]` branch, build the root list as: `%APPDATA%\UnityHub` config dir via `hub_roots_from_config_dir`, then the existing `C:\Program Files\Unity\Hub\Editor` as the last fallback. Keep the existing default-path behaviour intact so nothing regresses for the common case.

- [ ] **Step 4: Run tests**

Run: `cd src-tauri && cargo test --lib hub`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/unity.rs
git commit -m "fix(unity): find Unity Hub installs outside Program Files on Windows

The Windows branch probed exactly one hard-coded path. A Hub installed
on another drive — which its setup actively invites — produced no
.csproj, no .sln and no IntelliSense, with no error anywhere. macOS had
a Hub-JSON fallback; Windows had none.

Helpers are platform-neutral so they are testable off Windows."
```

---

## Task 11: One correct document URI for Monaco and the LSP

`file://` + a drive-lettered path puts `C:` in the URI **authority**, so on Windows every LSP request names a document the server was never told about.

**Files:**
- Create: `src/utils/model-uri.ts`, `src/utils/model-uri.test.ts`
- Modify: `src/features/editor/components/EditorPanel.tsx:130`
- Modify: any other site building a `file://` URI by hand (grep for `` `file://` ``)

**Interfaces:**
- Produces: `toModelUri(absPath: string): string`

- [ ] **Step 1: Write the failing test**

```ts
// src/utils/model-uri.test.ts
import { describe, it, expect } from 'bun:test';
import { toModelUri } from './model-uri';

describe('toModelUri', () => {
  it('keeps a POSIX path in the URI path', () => {
    expect(toModelUri('/Users/me/Proj/Assets/Player.cs'))
      .toBe('file:///Users/me/Proj/Assets/Player.cs');
  });

  it('puts a Windows drive letter in the path, not the authority', () => {
    // file://C:/... parses with authority "C:" — the LSP was told about
    // file:///d:/... and asked about file://d:/..., so nothing matched.
    expect(toModelUri('D:/Unity/MyGame/Assets/Player.cs'))
      .toBe('file:///d%3A/Unity/MyGame/Assets/Player.cs');
  });

  it('normalises backslashes', () => {
    expect(toModelUri('D:\\Unity\\MyGame\\Player.cs'))
      .toBe('file:///d%3A/Unity/MyGame/Player.cs');
  });

  it('encodes spaces and other unsafe characters', () => {
    expect(toModelUri('/Users/me/My Project/A B.cs'))
      .toBe('file:///Users/me/My%20Project/A%20B.cs');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd editor && bun test src/utils/model-uri.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Normalise `\` to `/`, detect a leading `<letter>:` drive, lowercase the drive letter, percent-encode each segment with `encodeURIComponent`, and always produce three slashes after `file:`. Lowercasing the drive matters: `D:` and `d:` must not produce two distinct URIs for one file.

- [ ] **Step 4: Run tests**

Run: `cd editor && bun test src/utils/model-uri.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Adopt it**

Replace `EditorPanel.tsx:130`'s hand-built `modelPath` with `toModelUri(activeFile.path)`. Then grep for every other `file://` construction and route each through the same helper — the LSP client and the diagnostics keying must agree with Monaco byte-for-byte. Check `src/features/lsp/services/client.ts` and `providers.ts` in particular.

- [ ] **Step 6: Verify**

Run: `cd editor && bun test src && bunx tsc --noEmit && bun run verify:intellisense`
Expected: PASS. `verify:intellisense` must still report real Unity members for `transform.` — this task touches the exact plumbing it exercises.

- [ ] **Step 7: Commit**

```bash
git add src/utils/model-uri.ts src/utils/model-uri.test.ts src/features/
git commit -m "fix(lsp): build one document URI both Monaco and the server agree on

On Windows, file:// plus a drive-lettered path parses with authority
'C:', so csharp-ls was told about file:///d:/... and asked about
file://d:/... — every completion, hover and definition returned nothing,
and the client re-sent the whole file on each attempt because the model
URI could never enter the open set."
```

---

## Task 12: Platform-correct title bar

`titleBarStyle`/`hiddenTitle` are macOS-only and `decorations` defaults to true, so Windows draws its own title bar *and* the app's — with 78px of dead space reserved for traffic lights that do not exist.

**Files:**
- Modify: `src/main.tsx`, `src/App.css:141-149`, `src-tauri/tauri.conf.json`, `src-tauri/src/lib.rs` (window builder)

- [ ] **Step 1: Write the failing test**

```ts
// src/app-shell/titlebar-platform.test.ts
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const CSS = readFileSync(path.resolve(import.meta.dir, '../App.css'), 'utf8');

describe('title bar', () => {
  it('reserves the traffic-light gutter only on macOS', () => {
    // 78px is the width of macOS close/minimize/zoom. On Windows it is a
    // dead band, under a second, native title bar (audit H12/M4).
    const rule = CSS.slice(CSS.indexOf('.title-bar {'), CSS.indexOf('.title-bar {') + 400);
    expect(rule).not.toMatch(/padding:\s*0\s+12px\s+0\s+78px/);
    expect(CSS).toMatch(/\[data-os=["']macos["']\][^{]*\.title-bar/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd editor && bun test src/app-shell/titlebar-platform.test.ts`
Expected: FAIL.

- [ ] **Step 3: Stamp the platform**

In `src/main.tsx`, before rendering:

```ts
import { isMac, isWindows } from './utils/platform';

document.documentElement.dataset.os = isMac() ? 'macos' : isWindows() ? 'windows' : 'linux';
```

`utils/platform.ts` already exports these; `isWindows()` currently has zero callers.

- [ ] **Step 4: Split the CSS**

```css
.title-bar {
  height: 35px;
  background: var(--bg-titlebar);
  display: flex;
  align-items: center;
  padding: 0 12px;
  -webkit-app-region: drag;
  user-select: none;
}

/* Room for the macOS close/minimize/zoom buttons, which only exist there. */
[data-os='macos'] .title-bar {
  padding-left: 78px;
}
```

- [ ] **Step 5: Disable native decorations off macOS**

`titleBarStyle: "Overlay"` + `hiddenTitle` are macOS-only, so Windows and Linux need `decorations: false` plus window controls in the custom bar. Set `"decorations": false` in `tauri.conf.json` for the welcome window and in the project-window builder, then add minimize/maximize/close buttons to `.title-bar-right`, rendered only when `data-os` is not `macos`, wired to `getCurrentWindow().minimize() / toggleMaximize() / close()`.

- [ ] **Step 6: Verify**

Run: `cd editor && bun test src && bunx tsc --noEmit`
Expected: PASS. Then launch on macOS and confirm the traffic lights still clear the wordmark.

- [ ] **Step 7: Commit**

```bash
git add src/main.tsx src/App.css src-tauri/tauri.conf.json src-tauri/src/lib.rs src/features/app-shell/
git commit -m "fix(shell): stop drawing a macOS title bar on Windows and Linux

decorations was never disabled, so Windows got the OS title bar plus the
app's own — and the app's reserved 78px for traffic lights that are not
there, leaving a dead band beside the wordmark. Adds real window
controls off macOS."
```

---

## Task 13: No console flash on Windows

70 `Command::new` sites, 61 in `git.rs`. Each pops a console window on Windows.

**Files:**
- Create: `src-tauri/src/process_util.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod process_util;`), `git.rs`, `dap.rs`, `lsp.rs`, `unity_ipc.rs`, `unity_tests.rs`, `unity_diff.rs`

**Interfaces:**
- Produces: `pub fn command<S: AsRef<OsStr>>(program: S) -> std::process::Command` and `pub fn async_command<S: AsRef<OsStr>>(program: S) -> tokio::process::Command`

- [ ] **Step 1: Write the failing test**

```rust
// src-tauri/src/process_util.rs — #[cfg(test)] mod tests
    #[test]
    fn command_runs_and_is_configured() {
        let out = command("git").arg("--version").output().expect("git runs");
        assert!(out.status.success());
    }

    #[cfg(windows)]
    #[test]
    fn windows_commands_set_create_no_window() {
        // Asserted structurally: a raw Command::new anywhere in src/ pops a
        // console window per git call on Windows.
        let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/git.rs")).unwrap();
        assert!(!src.contains("Command::new("), "git.rs must use process_util::command");
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && cargo test --lib process_util`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```rust
//! One place that owns Windows process-creation flags.
//!
//! CREATE_NO_WINDOW keeps a console window from flashing for every git
//! invocation — and git.rs alone spawns 61 of them.

use std::ffi::OsStr;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn command<S: AsRef<OsStr>>(program: S) -> std::process::Command {
    let mut c = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

pub fn async_command<S: AsRef<OsStr>>(program: S) -> tokio::process::Command {
    let mut c = tokio::process::Command::new(program);
    #[cfg(windows)]
    {
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}
```

- [ ] **Step 4: Migrate every call site**

```bash
cd src-tauri/src
sed -i '' 's/\bCommand::new(/crate::process_util::command(/g' git.rs lsp.rs unity_ipc.rs unity_tests.rs unity_diff.rs
sed -i '' 's/tokio::process::Command::new(/crate::process_util::async_command(/g' dap.rs
```

Then read each file's imports and remove any now-unused `use std::process::Command;`. Check `lib.rs`'s three sites by hand — one is a shell invocation that may want different treatment.

- [ ] **Step 5: Verify**

Run: `cd src-tauri && cargo test --lib && cargo build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/
git commit -m "fix(win): route process spawns through one place that sets CREATE_NO_WINDOW

A console window flashed on Windows for every git call, and git.rs alone
spawns 61 processes."
```

---

## Task 14: Mono discovery works on Windows

`dap.rs:66` splits `PATH` on `':'` and joins `"mono"` with no `.exe`, so the Unity debugger can never attach on Windows.

**Files:**
- Modify: `src-tauri/src/dap.rs:51-70`

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn path_entries_split_on_the_platform_separator() {
        // ':' is the POSIX separator. Windows uses ';' — and a Windows PATH
        // entry is itself drive-lettered ("C:\bin"), so splitting on ':'
        // shreds it into garbage.
        let joined = if cfg!(windows) { r"C:\bin;D:\tools" } else { "/usr/bin:/usr/local/bin" };
        let parts: Vec<_> = split_path_var(joined).collect();
        assert_eq!(parts.len(), 2);
    }

    #[test]
    fn mono_binary_name_is_platform_correct() {
        assert_eq!(mono_binary_name(), if cfg!(windows) { "mono.exe" } else { "mono" });
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && cargo test --lib dap::`
Expected: FAIL — helpers do not exist.

- [ ] **Step 3: Implement**

Add `fn split_path_var(v: &str) -> impl Iterator<Item = &str>` using `std::path::MAIN_SEPARATOR`-adjacent logic — specifically `if cfg!(windows) { ';' } else { ':' }` — and `fn mono_binary_name() -> &'static str`. Rewrite `find_mono` to use both. Prefer `std::env::split_paths`, which is the standard-library answer and already platform-correct; keep the named helpers so the tests above stay meaningful.

- [ ] **Step 4: Run tests**

Run: `cd src-tauri && cargo test --lib dap::`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/dap.rs
git commit -m "fix(debugger): make mono discovery work on Windows

PATH was split on ':', which shreds a drive-lettered Windows entry, and
the binary name omitted .exe. The Unity debugger could never attach."
```

---

## Task 15: Free `Cmd+Shift+T` for Reopen Closed Tab

The native macOS menu binds `CmdOrCtrl+Shift+T` to the theme picker, so the chord does different things per OS. Per `editor/CLAUDE.md`, the native menu wins on macOS.

**Files:**
- Modify: `src-tauri/src/menu.rs:109-110`

- [ ] **Step 1: Confirm the collision**

Run: `cd editor && grep -n "mod+shift+t" src/App.tsx && grep -n "Shift+T" src-tauri/src/menu.rs`
Expected: `App.tsx` binds `mod+shift+t` to `workbench.reopenClosedTab`; `menu.rs:110` binds the same chord to `theme.openPicker`.

- [ ] **Step 2: Write the failing test**

```ts
// src/app-shell/keybinding-parity.test.ts
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '../..');
const MENU = readFileSync(path.join(ROOT, 'src-tauri/src/menu.rs'), 'utf8');
const APP = readFileSync(path.join(ROOT, 'src/App.tsx'), 'utf8');

/** 'CmdOrCtrl+Shift+T' -> 'mod+shift+t' */
function toRegistryChord(accel: string): string {
  return accel.replace(/CmdOrCtrl/g, 'mod').toLowerCase();
}

describe('native menu vs command registry', () => {
  it('binds each chord to the same command id on both sides', () => {
    const mismatches: string[] = [];
    const re = /with_id\(\s*"([^"]+)"[^)]*\)[\s\S]{0,200}?\.accelerator\("([^"]+)"\)/g;
    for (const [, menuId, accel] of MENU.matchAll(re)) {
      const chord = toRegistryChord(accel);
      // Find which command id App.tsx gives this chord.
      const m = APP.match(
        new RegExp(`id:\\s*'([^']+)'[\\s\\S]{0,300}?keybinding:\\s*'${chord.replace(/[+]/g, '\\+')}'`),
      );
      if (m && m[1] !== menuId) mismatches.push(`${accel}: menu=${menuId} registry=${m[1]}`);
    }
    expect(mismatches).toEqual([]);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd editor && bun test src/app-shell/keybinding-parity.test.ts`
Expected: FAIL — `CmdOrCtrl+Shift+T: menu=theme.openPicker registry=workbench.reopenClosedTab`.

- [ ] **Step 4: Fix**

Remove `.accelerator("CmdOrCtrl+Shift+T")` from the theme picker menu item. The theme picker stays reachable from the menu and the command palette; it does not need a chord. Then add a `Reopen Closed Tab` menu item with `CmdOrCtrl+Shift+T` and id `workbench.reopenClosedTab`, so the macOS menu and the registry agree.

- [ ] **Step 5: Verify**

Run: `cd editor && bun test src/app-shell/keybinding-parity.test.ts && cd src-tauri && cargo build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/menu.rs src/app-shell/
git commit -m "fix(keys): stop the native menu stealing Cmd+Shift+T from Reopen Closed Tab

On macOS the native menu wins, so the same chord opened the theme picker
there and reopened a closed tab everywhere else. Adds a parity test that
compares every menu accelerator against the command registry — the trap
CLAUDE.md documents, now enforced."
```

---

## Final verification

- [ ] Run the full local gate

Run: `cd editor && bun run verify`
Expected: every stage passes, and `verify:intellisense` reports real Unity members — **not** `SKIPPED`. A skip is not a pass; if it skips, set `ARCANE_SMOKE_UNITY_PROJECT=<path>` and re-run.

- [ ] Push and confirm the Windows CI job is green

This is the deliverable of Phase 0. Until `test (windows-latest)` passes, none of the Windows fixes in this plan are verified — they are only written.
