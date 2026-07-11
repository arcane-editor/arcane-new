# Arcane Editor — Tasks Tracker Bug-Fix & Revamp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all 18 bug/polish items from the Notion Tasks Tracker export (hotkeys, focus, search, explorer actions, multi-instance crash, agent cleanup) and fully revamp the git flow.

**Architecture:** Three workstreams over the existing Deep-Modules Tauri app — A: git revamp (branch lifecycle, watcher correctness, commit visibility, remote robustness, stash/amend), B: search overhaul (streaming Rust search, persistent file index, virtualized UI, dotfile policy), C: shell/UX fixes (hotkeys, focus, links, reveal, clipboard, crash hardening, agent removal, reload fixes). Workstream sections appear in file order B, C, A; execution order is defined at the end.

**Item → task map:** 1→C1 · 2→C6 · 3→B6 · 4→A3 · 5→A2 · 6→A1+A3 · 7→C7 · 8→A4+A5+A6 · 9→C5 · 10→C5 · 11→A1–A8 · 12→B1–B8 · 13→B2–B4 · 14→C8 · 15→C2 · 16→C3 · 17→C4 · 18→B1

**Scope confirmed with user:**
- Everything in one plan (all 18 CSV items)
- Git: FULL revamp (staging, diffs, history, branch management)
- Search: perf + core UX (fast non-blocking content search, debounce, streaming, include/exclude filters, result grouping) — full Zed-parity polish deferred
- Reload/state issues: fix the concrete issues exploration surfaces
- Agent cleanup: HARD DELETE all Claude/non-Arcane agent code (services, ACP client, pickers, claude* store state, Rust claude.rs commands) — user wants it simple
- Instance crash coupling: PRAGMATIC HARDENING of the shared Rust process (poison recovery, unwrap audit, catch_unwind); full process isolation = explicit future work

## Source: Tasks Tracker CSV items

1. Hotkeys don't work when editor panel is focused (Bug)
2. Many reload/state related issues (Bug — audit and fix findings)
3. Jittering/loading flicker in file search panel (Bug)
4. Jittering/loading flicker in branch search panel (Bug)
5. Branch created in terminal not reflected in bottom/status bar (Bug)
6. Branch creation not possible from editor (Polish)
7. Keep only Arcane agent; remove other agent integrations (Polish)
8. Changes/commits not clearly visible (git UI visibility)
9. Copy Path not working
10. Reveal in Finder not working
11. Full revamp of git flow (confirmed: full revamp in this plan)
12. Search panel as good as Zed (confirmed: perf + core UX)
13. File content search super slow, blocks editor
14. One instance crash kills other instances
15. Opened file should automatically receive focus
16. Right-click on import path doesn't open the file
17. Focused file should auto-reveal in file explorer
18. Env files (dotfiles) not visible in file search panel

## Global Constraints

- Deep Modules architecture: features self-contained under `src/features/<name>/`, public API only via `index.ts` barrel; stores centralized in `src/stores/`; no cross-feature internal imports.
- Tech stack fixed: Tauri v2 (Rust backend), React 19, TypeScript, Vite, Monaco via `@monaco-editor/react`, Zustand, xterm.js, Bun as package manager.
- LSP (`csharp-ls`) remains sole source of C# IntelliSense.

## Exploration Findings (working notes)

### Search subsystem (items 3, 4, 12, 13, 18)

**File search panel jitter (item 3)** — `src/features/command-palette/components/PaletteModal.tsx`
- Debounce 150ms (`useDebouncedValue`, line 79); search effect lines 99–161 flips `isSearching` false→true→false per settled keystroke; `Searching...` row (306–317) renders ABOVE the results list → layout jump each keystroke.
- Effect dep array (line 161) includes `openFiles` + `extraExcludePatterns` — `openFiles` gets new array ref on any workspace store update, re-running search + re-flipping loading even when query unchanged.
- Backend `fuzzy_search_files` (`src-tauri/src/file_scanner.rs:181`, **sync** fn, lib.rs:371) re-walks the entire workspace with a fresh `ignore::WalkBuilder` + fresh `nucleo` matcher **on every keystroke** — no persistent index.

**Branch search panel jitter (item 4)** — `src/features/git/components/BranchPicker.tsx`
- `refreshBranches` called on every mount (33–35) with no loading flag → "No matching branches" renders first, then list pops in.
- Empty-query sort comparator (line 42) is not a consistent total ordering → unstable reshuffles.
- `git-state-changed` listener (`workspace.ts:847–852`) rewrites branch concurrently; `scrollIntoView` (56–60) amplifies jitter.
- Store: `refreshBranches` `src/stores/git.ts:138–145` → `git_list_branches` (lib.rs:337). No cache/guard.

**Content search slow + blocks editor (item 13)** — `src-tauri/src/search.rs:30` `search_in_files`
- **Synchronous** Tauri command (lib.rs:329) → runs on main thread, blocks app.
- Raw `walkdir`, `fs::read_to_string` every file, no `.gitignore` respect (hardcoded `skip_dirs` line 41, dot-dirs line 95), no streaming — returns one blob up to 10k matches.
- Frontend `src/stores/search.ts:52–87` awaits whole blob; `SearchPanel.tsx:165–215` renders ALL results unvirtualized → React blocks on big result sets. Debounce 300ms/≥3 chars exists.

**Env files invisible (item 18)** — three filter sites:
1. Explorer tree: `src-tauri/src/lib.rs:54–57` — `if name.starts_with('.') { return None; }`
2. Quick-open: `file_scanner.rs:197` `.hidden(true)` + `.git_ignore(true)` (and same at 136–139 for `scan_all_files_v2`)
3. Content search already searches dotfile CONTENT (only dot-dirs skipped) — gap is tree + quick-open.

**Search panel current features (item 12 baseline)** — case/whole-word/regex toggles exist and backend honors them; single include/exclude glob each; grouped-by-file results; NO replace, no multi-glob, no gitignore respect, no virtualization/streaming, truncated flag not surfaced.

### Hotkeys & focus (items 1, 15, 16, 17)

**Architecture:** two parallel shortcut systems — global `KeyboardShortcutManager.tsx` (react-hotkeys-hook v5, document-level listeners, mounted `App.tsx:891`) + Monaco mirror `src/features/editor/services/bind-shortcuts.ts` (`bindGlobalShortcutsToMonaco`, called in `EditorPanel.tsx:314` onMount). Commands + keybindings declared in `App.tsx:330–718`, stored in `src/stores/commands.ts`.

**Hotkeys dead when editor focused (item 1)**
- Monaco swallows keydown before document listeners see it; the mirror re-registers commands via `editor.addCommand` — but `src/utils/hotkey-to-monaco.ts` `parseHotkeyToMonaco` returns `null` for backtick and raw `,` (NAMED_KEYS has `comma`/`period` words, no `` ` `` entry) and `bind-shortcuts.ts:19` silently skips nulls. Dead while editor focused: ``mod+` `` (toggle terminal, App.tsx:330), ``mod+shift+` `` (App.tsx:348), `mod+,` (settings, App.tsx:436).
- `mod+k` (AI panel, App.tsx:488) collides with Monaco's built-in Cmd+K chord prefix → never fires.
- Parse failures have no warning; mirror de-dupes on `${id}|${keybinding}` and re-syncs via `useCommandsStore.subscribe` (bind-shortcuts.ts:32).

**Opened file not auto-focused (item 15)**
- `openFile` (`workspace.ts:909–939`) sets `activeFilePath` but never focuses; the only `editor.focus()` calls (`EditorPanel.tsx:77, 95, 328`) are gated behind pending-navigation (go-to-def) or `navigate-to-line`. Fix: focus editor when `activeFilePath` changes, independent of pending nav.

**Right-click import path doesn't open file (item 16)**
- No `registerLinkProvider`/DocumentLink provider exists anywhere. Go-to-definition only for LSP-backed languages (csharp/ts/js/tsx/jsx, `providers.ts:494–540`); C# `using` = namespaces not files. Shader `#include` has its own resolver (`include-resolver.ts:207–245`). Cross-file opens route through `registerEditorOpener` (`providers.ts:877–919`) + `editor-navigation.ts` pending-nav handoff. Fix area: add a link provider for import specifiers (per-language path resolution), riding the existing opener.

**Active file not revealed in explorer (item 17)**
- Explorer uses `react-arborist`; `<Tree>` (`ExplorerPanel.tsx:350–378`) has NO ref/selection prop. `reveal-in-tree` listener exists (`ExplorerPanel.tsx:184–202`) but `onReveal` is an empty stub. Only manual dispatcher is `mod+shift+r` (`App.tsx:667–680`). Fix: TreeApi ref + expand lazy-loaded ancestors (`loadChildren` in workspace.ts) + select/scroll, driven by `activeFilePath` effect + the event.

### Git, explorer, windows, agents (items 2, 5–11, 14)

**Architecture:** git backend shells out to `git` CLI (no git2), all in `src-tauri/src/git.rs`, registered `lib.rs:336–360`; store `src/stores/git.ts`. Multi-window = webview windows in ONE shared Rust process (`src/features/project/services/multi-window.ts`); no single-instance plugin. Agents = `arcane` | `claude` only (`ai-panel/services/types.ts:13`).

**Branch not reflected in status bar (item 5)**
- StatusBar reads `useGitStore.branch` (`StatusBar.tsx:42, 92–101`); `refreshStatus` (`git.ts:109–136`) parses `git status --porcelain=v2 --branch`.
- Watcher exists: Rust emits `git-state-changed` (`file_scanner.rs:480–488`, paths matched by `is_git_state_path` `file_scanner.rs:97–104`); frontend handler (`workspace.ts:847–852`) calls `refreshStatus` but NEVER `refreshBranches` → created (not switched-to) branches invisible until picker remounts.
- Linked worktrees: `<ws>/.git` is a file pointer; real HEAD lives outside watched root → no event on switch in worktree.
- Leading-edge emit race: emit fires on first event of checkout burst then 100ms suppression (`file_scanner.rs:476–489`) → can read pre-rewrite HEAD with no corrective re-fire.

**No create-branch from editor (item 6)** — confirmed absent: BranchPicker only switches (`BranchPicker.tsx:62–69`); no `createBranch` store action; no `git_create_branch` Rust command. Only `AddWorktreeDialog` creates branches (in new worktrees, `git.rs:582–609`).

**Changes/commits not clearly visible (item 8)**
- SourceControlPanel: flat rows + status letter; diff view EXISTS (`openDiffTab` → `diff://` tab → Monaco DiffEditor `EditorPanel.tsx:214`); explorer git badges exist.
- Gaps: Commits section collapsed by default (`SourceControlPanel.tsx:135` useState(false)); bare commit list, no per-commit diff/detail; NO editor gutter decorations for modified lines (only breakpoint gutter); no changed-count badge on activity bar.

**Git flow map for revamp (item 11)**
- Commands: status/branches/switch/diff/stage/unstage(all)/commit/show_head/discard(all)/fetch/pull/push/log/worktree list-add-remove-prune/blame/unityyamlmerge/resolve_conflict/append_gitignore.
- Gaps: no create/rename/delete branch, no stash, no amend, no per-commit diff or graph, no set-upstream surfaced, push/pull/fetch have no credential handling (CLI will hang/fail silently on auth prompts, `git.rs:402–445`), refreshBranches not watcher-wired, no gutter diff, commits collapsed, worktree HEAD not watched.

**Copy Path / Reveal in Finder (items 9, 10)** — NOT IMPLEMENTED anywhere (explorer ContextMenu.tsx has only New/Rename/Delete; TabMenu only close ops). Implementation notes: opener plugin installed + `opener:default` granted (`capabilities/default.json:20`) but `revealItemInDir` needs `opener:allow-reveal-item-in-dir` (missing). Copy Path can use `navigator.clipboard.writeText` (precedent: `SceneContextPanel.tsx:190`); clipboard-manager plugin NOT installed.

**Instance crash coupling (item 14)** — all windows share one Rust process; process-global Mutex state (`LspState, TerminalState, ClaudeState, FileWatcherState, UnityIpcState, DapState`, lib.rs:309–314). Any Rust panic aborts every window; panic while holding a lock poisons it for all windows (`.lock().map_err` sites e.g. `file_scanner.rs:410`). Per-window React ErrorBoundary exists; coupling is at Rust layer.

**Remove non-Arcane agents (item 7)** — "other agent" = Claude (local Claude Code via ACP bridge). Touches: `claude-agent-service.ts`, `claude-acp-client.ts`, `mcp-config.ts`(?), `ClaudeModelPicker/EffortPicker/PermissionModePicker`, `selectedAgent === 'claude'` branches in ChatInput/AiChatPanel/PermissionRequestBlock/PlanList/SessionHistory/SlashTriggerPlugin/SlashCommandPopover, AgentPicker AGENTS array (+ disabled "coming soon" group), `ai.ts` claude* state (lines 161–182, 213, 270–271), Rust `claude.rs` commands + `ClaudeState` + drop_window cleanup (lib.rs:311, 413–416, 451–458), `AgentKind` type.

**Reload/state smells (item 2)**
- `diff://`/`auth://` tabs stripped on persist AND restore (`App.tsx:311–314, 139–153`) → diff views vanish on reload.
- Terminals: store resets on reload but Rust PTYs keep running until window destroyed → orphaned PTYs, lost scrollback.
- Watchers/LSP/git only re-established via `setWorkspace`; reload without URL `path` param + stale/missing persisted state → dead workspace.
- Branch list vs status drift (dual source of truth, different refresh triggers).
- Debounced 1s persistence write + separate AI session restore subscription → fast reload can persist partially-restored state.

---

# WORKSTREAM B — Search Overhaul (items 3, 12, 13, 18)

**Test infra (verified):** frontend = `bun test src` with co-located `*.test.ts` (pure functions only, no DOM); Rust = in-file `#[cfg(test)]` via `cargo test` (no dev-deps yet → add `tempfile = "3"`). Window events are kebab-case via `@tauri-apps/api/event`.

**Extra findings:** latent bug — `matchStart/matchEnd` are Rust BYTE offsets but frontend slices with JS UTF-16 units (SearchPanel.tsx:191–193); 4th dotfile filter site `scan_all_files` (lib.rs:144, AI mention popover).

**Decisions:**
- D1: use ripgrep internals (`grep-searcher`/`grep-regex`/`grep-matcher` + `globset`) — binary detection, unicode whole-word, one code path for all toggles.
- D2: streaming via window events `search-results-batch`/`search-complete` with FRONTEND-supplied `searchId` (kills batch-before-invoke-resolves race); backend `AtomicU64` latest-id; workers quit on stale id.
- D3: dotfile policy in new `src-tauri/src/walk_policy.rs`: ALWAYS_HIDDEN = [.git, .DS_Store]; dotfiles visible; gitignore respected in quick-open + content search (NOT in tree); `.env`/`.env.*` whitelisted via root read_dir supplement (nested gitignored env = documented limitation).
- D4: keep-stale-results in both search surfaces; loading = 2px overlay bar, zero layout impact.

### Task B1 — Rust walk policy + env/dotfile visibility (S)
- Create `src-tauri/src/walk_policy.rs`: `is_always_hidden(name)`, `is_env_file(name)` (".env" || ".env.*"), `policy_walker(root) -> WalkBuilder` (`.hidden(false).git_ignore(true).git_global(true).git_exclude(true).filter_entry(!is_always_hidden)`), `root_env_files(root)`, `apply_extra_excludes(builder, root, excludes)` (extracted from duplicated OverrideBuilder blocks in file_scanner.rs:144–161/202–219).
- Modify `lib.rs read_directory` (54–57): replace dot-skip with `is_always_hidden`. Modify `scan_all_files_v2` + `fuzzy_search_files` to use policy walker + append `root_env_files` (interim until B5). Optional: `scan_all_files` (lib.rs:144) consistency.
- Tests: cargo test w/ tempfile fixture (.gitignore with `.env` + `secret.txt` → walker yields .gitignore, not secret.txt; root_env_files returns .env/.env.local).

### Task B2 — Rust streaming cancellable content search (L)
- Rewrite `src-tauri/src/search.rs`: `#[tauri::command(async)] start_content_search(app, state, search_id: u64, options: ContentSearchOptions) -> Result<(), String>` + `cancel_content_search(state, search_id)`. `ContentSearchState { latest: Arc<AtomicU64> }` managed in lib.rs.
- `ContentSearchOptions` (camelCase serde): workspace_path, query, is_regex, case_sensitive, whole_word, include_patterns: Vec<String>, exclude_patterns: Vec<String>, file_extensions: Option<Vec<String>> (Unity 'cs' parity), max_total_matches (def 10k), max_matches_per_file (def 200).
- Matcher built up front (`RegexMatcherBuilder.case_insensitive(!cs).word(ww)`, literal → `regex::escape`) so pattern errors return sync. Multi-glob via globset (normalize bare "x" → "**/x", "**/x/**").
- Parallel walker (`policy_walker().threads(...).build_parallel()`) on own thread; workers: quit on stale id or total cap; `BinaryDetection::quit(b'\x00')`; per-file matches with byte→UTF-16 offset conversion (`chars().map(char::len_utf16).sum`) + preview trim >~500 chars; send `FileSearchResult { path, matches, truncated }` over mpsc.
- Emitter thread: batch 50 files / 40ms → `search-results-batch` `{ searchId, results }`; on drain → `search-complete` `{ searchId, totalMatches, fileCount, truncated, cancelled, elapsedMs }`; skip emits when cancelled.
- Extract pure `search_file(...)` + `build_globset(...)` for tests. Tests: toggle matrix, gitignore+env whitelist, multi-glob, per-file/total caps, binary skip, UTF-16 offsets (é/emoji), invalid regex → Err.

### Task B3 — Frontend streaming store + pure search model (M)
- Create `src/features/search/services/search-model.ts` (+ .test.ts): `parseGlobList(raw)`, `applyBatch(state, payload)` (stale-id no-op; first batch REPLACES results; later append), `applyComplete(...)` (stale/cancelled no-op; zero-batch → results=[]); `StreamState` shape. Export via feature barrel.
- Rewrite `src/stores/search.ts`: module `searchGeneration`; lazy `ensureListeners()` registering the two event listeners once; `search()` keeps previous results visible (only flips `isSearching`, `activeSearchId`, `receivedFirstBatch`), invokes `start_content_search` with `parseGlobList(includePattern/excludePattern)`; `clearResults` also invokes cancel. Add `truncated` to `FileSearchResult` type (src/types/index.ts).
- Tests: bun test on search-model (parseGlobList edge cases; batch/complete semantics).

### Task B4 — Virtualized SearchPanel + stable loading UI (M)
- Add `flattenRows(results, collapsed) -> SearchRow[]` ({kind:'file'|'match'}) to search-model.
- SearchPanel.tsx: replace nested .map (165–215) with `useVirtualizer` (count=rows.length, estimateSize 24/22, overscan 10; absolute-positioned rows + spacer div = getTotalSize; same pattern as PaletteModal:319–326; `.search-results` = relative + overflow-y auto).
- Stable loading: delete displacing 'Searching...' branch (153–155); always-rendered fixed-height summary row; 2px indeterminate overlay bar at top while searching; truncation notice when `truncated`. "No results" only when `!isSearching && query>=3 && results.length===0 && activeSearchId>0`.
- Filter input placeholders: "files to include (e.g. src/**, *.ts)".
- Tests: bun test flattenRows (collapse/ordering); UI manual in B8.

### Task B5 — Rust persistent quick-open file index (M)
- Create `src-tauri/src/file_index.rs`: `FileIndexState(Mutex<Option<FileIndex>>)`; `FileIndex { workspace_path, extra_excludes, files: Vec<String>, stale: bool }`; `#[tauri::command(async)] build_file_index(app, workspace_path, extra_excludes) -> Result<usize, String>` (policy walk + root_env_files); `apply_delta(state, delta)` (add: skip always-hidden segments, dedup, env always allowed; remove: retain; `.gitignore`/`.ignore` change → stale=true).
- `fuzzy_search_files`: same FE signature; body = use cached index when workspace+excludes match && !stale, else rebuild inline; extract `score_files(...)` (preserve nucleo ranking — regression tests reuse existing style file_scanner.rs:561–591). Make `#[tauri::command(async)]`.
- Watcher hook: in start_file_watcher debounce task (~file_scanner.rs:524) call `apply_delta` before emitting `file-index-changed`.
- `stores/workspace.ts`: invoke `build_file_index` in openWorkspace (~816) and setExcludePatterns (~881).

### Task B6 — PaletteModal jitter fixes (S)
- Split effect 99–161: recent-files effect (empty query; read openFiles via getState(), DROP the line-61 subscription) + search effect (deps only `[isCommandMode, debouncedFileQuery, workspacePath, isUnityProject]`; extraExcludePatterns via getState()).
- Keep stale results on search start/error; delete 'Searching...' row (306–317) → 2px overlay bar on `.palette-list` (optional 100ms delay gate); "No matching files" only when `!isSearching && query && fileResults.length===0`; verify selectedIndex clamps.

### Task B7 — Cleanup + registration sweep (S)
- Remove `search_in_files` from generate_handler (lib.rs:329) + confirm no FE callers; `.manage(ContentSearchState)`, `.manage(FileIndexState)`; drop `glob` crate if unused; gate = `cargo build` + `bun run build`.

### Task B8 — Integration verification (manual)
- `bun test src`, `cargo test`, `bun run tauri dev` on large workspace: streaming progressiveness, mid-search interactivity, stale-search cancellation, toggles, globs, gitignore, truncation notice, smooth 10k-row scroll, quick-open <50ms keystrokes, no layout jumps, watcher-driven index updates, .env visible everywhere, .git never visible.

Sequencing: B1 → (B2 → B3 → B4) ∥ (B5 → B6); B7 after B2+B5; B8 last.

---

# WORKSTREAM C — Shell/UX Fixes (items 1, 2, 7, 9, 10, 14, 15, 16, 17)

**Verified facts:** `@tauri-apps/plugin-opener` ^2 in package.json + Cargo.toml; `opener:allow-reveal-item-in-dir` MISSING from `src-tauri/capabilities/default.json`; plugin-fs path scope doesn't cover workspace (session-persistence.ts:199) → custom Rust `path_exists` needed; tauri 2.11.3 does NOT catch command panics (async isolated by tokio task boundary; sync runs on main thread — verify empirically); `LspState/ClaudeState/UnityIpcState/DapState` use tokio::sync::Mutex (no poisoning) — poisoning risk confined to `TerminalState` + `FileWatcherState` (std Mutex); production unwrap/expect audit CLEAN (only infallible static regex + test code).

### Task C1 — Hotkey key-map fix + dev warning (XS)
- `src/utils/hotkey-to-monaco.ts` NAMED_KEYS additions: `` '`': 'Backquote' ``, `backquote`, `backtick`, `',': 'Comma'`, `'.': 'Period'`, `'/': 'Slash'`, `'\\': 'Backslash'`, `';': 'Semicolon'`, `"'": 'Quote'` (raw `[ ] - =` already mapped).
- `bind-shortcuts.ts:19`: `if (bitfield === null) { if (import.meta.env.DEV) console.warn('[Shortcuts] Unparseable keybinding, not bound in editor:', cmd.keybinding, cmd.id); continue; }`
- Cmd+K collision: two-step — ship key-map fix, manually test Cmd+K in editor; ONLY if chord still swallows it add `monaco.editor.addKeybindingRules([{ keybinding: KeyMod.CtrlCmd | KeyCode.KeyK, command: null }])` (cost: in-editor Cmd+K chords like Cmd+K Cmd+C die — document).
- Test: new `src/utils/hotkey-to-monaco.test.ts` (bun) with mock monaco KeyCode/KeyMod objects; assert mod+`, mod+shift+`, mod+, parse non-null; unknown → null. Manual: editor focused → Cmd+` terminal, Cmd+, settings, Cmd+K sidebar.

### Task C2 — Editor auto-focus on open (XS)
- Policy: focus on EVERY activeFilePath change (all openFile callers audited = explicit user actions; no preview flow exists; `focusEditor` flag = future escape hatch).
- `EditorPanel.tsx` effect (65–79): always `requestAnimationFrame(() => { if (nav) { setPosition + revealPositionInCenter } editor.focus(); })`; add final `editor.focus()` in onMount (~329); add `editor.onDidDispose(() => { if (editorRef.current === editor) editorRef.current = null; })` guard (AssetViewer/SceneDiffViewer/AuthTab early-return paths).
- Manual: open via explorer/Cmd+P/tab → typing goes to editor; search-result click still lands on match line.

### Task C3 — Import-path link/definition provider (M)
- Scope v1: relative specifiers (`./`, `../`) in `typescript`+`javascript` Monaco langs; candidates: spec, spec.{ts,tsx,js,jsx,mjs,cjs}, spec/index.{ts,tsx,js,jsx}. Skip bare specifiers/tsconfig-paths/json/yaml. C# using = namespaces, correctly out of scope.
- Create `src/features/editor/services/import-link-provider.ts`: module-level `registered` guard (pattern: shader-languages/index.ts:11); `registerLinkProvider` + `registerDefinitionProvider` per lang; pure `extractSpecifiers(lineText)` (from '...', import('...'), require('...'), side-effect imports); `resolveSpecifier(currentFilePath, spec)` via new Rust `path_exists` command with Map cache invalidated on workspace change. DefinitionProvider returns `{ uri: Uri.file(target), range 1,1,1,1 }` riding existing registerEditorOpener + pendingNavigation (same as include-resolver.ts:207–245) → right-click Go to Definition/Peek + F12 work without LSP. LinkProvider adds underline + Cmd+click; if link clicks bypass opener in testing, drop LinkProvider (def provider covers both gestures).
- `EditorPanel.tsx` beforeMount (~283): `registerImportLinkProvider(monaco)`. `lib.rs`: `#[tauri::command] fn path_exists(path: String) -> bool { Path::new(&path).is_file() }` + register.
- Coexistence with TS LSP: duplicate definitions acceptable (or gate via lsp barrel if exported).
- Tests: bun test extractSpecifiers + candidate generation. Manual: underline on Cmd+hover; Cmd+click + right-click open; `./foo` → foo/index.ts; `../missing` no-op.

### Task C4 — Reveal active file in explorer (M)
- Create `src/features/explorer/services/reveal.ts`: pending-reveal slot (`setPendingReveal`/`consumePendingReveal`, mirrors editor-navigation.ts) — fixes event-before-mount loss (App.tsx:677 dispatches synchronously after setSidebarVisible).
- `ExplorerPanel.tsx`: `treeApi = useRef<TreeApi<TreeNode>>`; `<Tree ref={treeApi}>`; `revealPath(path)`: root = assetsRootPath ?? workspacePath; bail if path outside root; walk ancestor dirs — `loadChildren(dir)` when children missing, `treeApi.current?.open(dir)`; then rAF → `select(path)` + `scrollTo(path, 'center')`. Replace empty onReveal stub (192–195); consume pending reveal on mount.
- Auto-reveal: subscribe to activeFilePath; skip diff:///auth://; gate on new setting `explorer.autoReveal` (default ON) AND explorer visible (`activeSidebarView === 'explorer' && sidebarVisible`).
- `App.tsx` (~672): setPendingReveal(path) before dispatching event. `stores/settings.ts` + SettingsPanel: add `explorer.autoReveal` boolean.
- Caveat: .meta files hidden by applyUnityTreeView silently no-op.
- Manual: deep file via Cmd+P → expands/scrolls/selects; Cmd+Shift+R with hidden sidebar works; setting off → manual command still works.

### Task C5 — Copy Path / Copy Relative Path + Reveal in Finder (S, one commit)
- `capabilities/default.json`: add `"opener:allow-reveal-item-in-dir"` (object form with `{"path": "**"}` if runtime scope-rejects). App restart needed after capability change.
- `ContextMenu.tsx`: optional props `onCopyPath`, `onCopyRelativePath`, `onRevealInOs`; render after separator (lucide Copy/FolderSymlink icons).
- `ExplorerPanel.tsx`: `navigator.clipboard.writeText(contextMenu.path)`; relative = strip `workspacePath + '/'` prefix (precedent SceneContextPanel.tsx:190). Reveal: `revealItemInDir(path)` from `@tauri-apps/plugin-opener`; label `isMac() ? 'Reveal in Finder' : 'Reveal in File Manager'`.
- `TabBar.tsx` TabMenu (129–135): build items from path; add Copy Path/Copy Relative Path/Reveal after Close group; diff:// tabs → underlying `${workspacePath}/${diff.filePath}`; hide for auth://.
- Manual: copy/paste from explorer + tab; Finder opens with file selected (file + folder nodes).

### Task C6 — Terminal PTY reset + reload/state fixes (S)
- **PTY orphans:** `terminal.rs`: `#[tauri::command] pub fn terminal_reset_window(window: Window, state: State<TerminalState>) { state.drop_window(window.label()); }` (drop_window already kills interactive+ACP PTYs, terminal.rs:58–77); register in lib.rs; `App.tsx` mount/restore effect (~110, before any createTerminal): `void invoke('terminal_reset_window')` — no-op on first launch, reaps previous incarnation on reload.
- **diff:// tab persistence:** `utils/persistence.ts` entry shape → `{ path, name, diff?: { filePath, staged } }` (backward compat); App.tsx persist (309–314): stop filtering diff://, keep stripping auth://; restore loop (143–149): `if (file.diff) openDiffTab(file.diff.filePath, cleanName, file.diff.staged) else openFile(...)` in try/catch (content refetched from git = never stale).
- **Boot-path hardening:** App.tsx:141 `setWorkspace(workspacePath)` has no .catch → add notification "Couldn't open <path> — moved or deleted."
- Tests: bun test persistence migration (old shape → new loader). Manual: diff tab + 2 terminals → Cmd+R → diff restored, `ps aux | grep -c zsh` stable across reloads.

### Task C7 — HARD DELETE Claude/non-Arcane agent integration (M)
**USER DECISION: hard delete (overrides design agent's Variant B recommendation).** Use Variant A file list:
- Rust: delete `src-tauri/src/claude.rs`; lib.rs — remove `ClaudeState` (311), command registration (413–416), drop_window cleanup (451–458). Delete the 5 `acp_terminal_*` commands + `AcpTerminal` from terminal.rs (only caller is claude-agent-service) — verify with grep first.
- FE services: delete `claude-agent-service.ts` (961 lines), `claude-acp-client.ts` (285), `mcp-config.ts` (71, only imported by claude-agent-service — verify).
- FE components: delete `ClaudeModelPicker.tsx`, `ClaudeEffortPicker.tsx`, `ClaudePermissionModePicker.tsx`; strip `selectedAgent === 'claude'` branches in ChatInput.tsx (52–104), AiChatPanel.tsx (32–48), PermissionRequestBlock.tsx (54–55), PlanList.tsx (28–31), SessionHistory.tsx (79–108), SlashTriggerPlugin.tsx (37), SlashCommandPopover.tsx; AgentPicker.tsx — remove claude from AGENTS (29–34) + External Agents section (169–199), keep "Coming soon" placeholder or simplify.
- Store `ai.ts`: remove `claude*` state (161–182), setters (213–222), handleAgentEvent claude handling (308–317), restore/persist claude paths (508–543, 561–572); narrow `AgentKind` to `'arcane'` (types.ts:13).
- **MIGRATION (critical):** session persistence must keep reading `agentKind` as a string and COERCE `'claude'` → `'arcane'` on restore (`ai.ts:535` restoreSession + `session-restore.ts:35–36` resume branch → no-op; old sessions render transcript read-only, run as arcane). SessionHistory may keep rendering old badges.
- Verify: `grep -rn "claude" src/ src-tauri/src/` post-delete (excluding comments/session data handling); `bun run build` (tsc) + `cargo build` gates.
- Manual: picker shows only Arcane; restoring old claude session doesn't wedge panel.

### Task C8 — Rust crash hardening (M)
1. `src-tauri/src/sync_util.rs`: `pub fn lock_recover<T>(m: &Mutex<T>) -> MutexGuard<'_, T> { m.lock().unwrap_or_else(|p| p.into_inner()) }`; replace ~15 `.lock().map_err(...)?` sites in terminal.rs + file_scanner.rs lock sites (plain maps/flags = safe to recover).
2. Panic hook in `lib.rs::run()`: `std::panic::set_hook(...)` logging to stderr (+ optional panics.log under data dir) — logs contained tokio-task panics without changing abort semantics.
3. Verify command-panic behavior empirically (dev-only `debug_panic` sync + async commands): if sync panics kill the process, convert the heavier sync commands to `async fn` (tokio task isolation) — candidates: `read_files_bulk`, `scan_workspace_files`. Record results. Skip blanket catch_unwind (tokio already provides unwind boundary).
4. Future work note (code comment/README): process-per-window isolation.
- Manual: kill a PTY's shell externally, spam terminal commands → no lock-up; panic hook line in stderr on debug_panic.

**C ordering:** C1, C2 (XS, first) → C5 → C6 → C3 (lib.rs edits merged with C6's) → C4 → C7 → C8. lib.rs additions (`path_exists`, `terminal_reset_window`) land in one commit.

# WORKSTREAM A — Git Flow Revamp (items 4, 5, 6, 8, 11)

**Decision: keep shelling out to `git` CLI** (consistent with all existing code in `src-tauri/src/git.rs`; git2 adoption = churn with no user-visible gain). All new Rust commands follow the existing pattern: `Command::new("git").args(["-C", &workspace_path, ...])`, stderr → `Err(String)`. Store actions follow existing style (invoke → refresh → `notify.error` on failure). Deep Modules: new git UI/services export only via `src/features/git/index.ts`.

### Task A1 — Branch lifecycle: Rust commands + store actions (S)
**Files:** modify `src-tauri/src/git.rs`, `src-tauri/src/lib.rs` (register), `src/stores/git.ts`.
- Rust (pattern-match `git_switch_branch` at git.rs:219–232):
```rust
#[tauri::command]
pub fn git_create_branch(workspace_path: String, name: String, base: Option<String>, checkout: bool) -> Result<(), String>
// checkout: git switch -c <name> [<base>] ; else: git branch <name> [<base>]
#[tauri::command]
pub fn git_rename_branch(workspace_path: String, old_name: String, new_name: String) -> Result<(), String>
// git branch -m <old> <new>
#[tauri::command]
pub fn git_delete_branch(workspace_path: String, name: String, force: bool) -> Result<(), String>
// git branch -d|-D <name>; pass stderr through so FE can detect "not fully merged" and offer force
```
- Store actions (mirror `switchBranch` style, git.ts:156–188):
```ts
createBranch: (workspacePath: string, name: string, opts?: { base?: string; checkout?: boolean }) => Promise<void>
// invoke → if checkout: invalidateBlameAll + refreshStatus + open-file reload flow like switchBranch → refreshBranches
renameBranch: (workspacePath: string, oldName: string, newName: string) => Promise<void>
deleteBranch: (workspacePath: string, name: string, force?: boolean) => Promise<void>
// on Err containing 'not fully merged': notify with hint; caller may re-call with force=true
```
- Tests: cargo test with `tempfile` — `git init` fixture repo + one commit; call the commands directly (plain fns) and assert via `git_list_branches`. Deleting an unmerged branch without force → Err containing "not fully merged".

### Task A2 — Watcher correctness: worktree HEAD, emit race, refreshBranches wiring (M)
**Files:** modify `src-tauri/src/file_scanner.rs`, `src/stores/workspace.ts` (~847–852).
- **Resolve linked-worktree git dir** — new pure fn wired into `start_file_watcher`:
```rust
/// If <ws>/.git is a gitdir pointer file (linked worktree), return the real git dir.
fn resolve_linked_git_dir(ws_path: &str) -> Option<std::path::PathBuf> {
    let dot_git = std::path::Path::new(ws_path).join(".git");
    if !dot_git.is_file() { return None; }
    let content = std::fs::read_to_string(&dot_git).ok()?;
    let gitdir = content.strip_prefix("gitdir:")?.trim();
    let p = std::path::PathBuf::from(gitdir);
    Some(if p.is_absolute() { p } else { std::path::Path::new(ws_path).join(p) })
}
```
  In `start_file_watcher` (after watching ws root, ~line 540): if `Some(git_dir)`, also `watcher.watch(&git_dir, RecursiveMode::Recursive)` (worktree gitdirs are tiny). Extend `is_git_state_path` (97–104): also treat paths under the resolved gitdir as git-state when they end with `/HEAD`, contain `/refs/`, or end with `/packed-refs` — pass the gitdir string into the event-loop closure.
- **Fix leading-edge race** (476–489): keep the immediate emit for responsiveness, add a **trailing re-emit**: track `git_state_touched` across the drain loop too (500ms sleep + try_recv drain, 491–522); if any git-state path appeared in the burst, emit `git-state-changed` once more AFTER the drain and reset `last_git_emit`. One redundant refreshStatus per checkout, never a stale read.
- **Wire refreshBranches:** workspace.ts `git-state-changed` handler calls both `refreshStatus` and `refreshBranches` (kills branch-list/current-branch drift; terminal-created branches appear everywhere).
- Tests: cargo test `resolve_linked_git_dir` (tempfile: real dir → None; pointer file abs/rel → resolved) + extended `is_git_state_path` cases (worktrees HEAD path).

### Task A3 — BranchPicker: jitter fixes + create-branch affordance (S)
**Files:** modify `src/features/git/components/BranchPicker.tsx`, `src/App.tsx` (command), `src/stores/git.ts` (loading flag).
- Add `isBranchesLoading` to git store (true in refreshBranches, false in finally).
- **Jitter:** cached `branches` render immediately (store persists across mounts — mount refresh becomes background update); "Loading branches…" ONLY when `branches.length === 0 && isBranchesLoading`; "No matching branches" only when `!isBranchesLoading`. **Stable sort** (line 42): `(a, b) => a.name === currentBranch ? -1 : b.name === currentBranch ? 1 : a.name.localeCompare(b.name)`.
- **Create affordance:** when `query.trim()` non-empty and no exact branch match, append synthetic row `{ kind: 'create', name: query }` → renders "＋ Create branch '<query>'"; Enter/click → `createBranch(workspacePath, query, { checkout: true })` then onClose. Keyboard nav includes the row.
- Command palette: add `git.createBranch` command in App.tsx (near `git.switchBranch`, 682–688) that opens BranchPicker.
- Manual: second open shows list instantly with no flash; type new name → create row → switched; `git branch x` in terminal → appears without reopening (A2).

### Task A4 — Commit visibility: expanded section + per-commit detail + diffs (M)
**Files:** modify `src-tauri/src/git.rs` + `lib.rs`, `src/stores/git.ts`, `src/stores/workspace.ts` (diff tab variant), `src/features/git/components/SourceControlPanel.tsx`, `src/types/index.ts`.
- `SourceControlPanel.tsx:135`: `commitsOpen` default → `useState(true)`.
- Rust:
```rust
#[derive(Serialize)] pub struct CommitFileChange { pub path: String, pub status: String } // A/M/D/R
#[derive(Serialize)] pub struct CommitDetail { pub hash: String, pub message: String, pub author: String, pub date: String, pub files: Vec<CommitFileChange> }
#[tauri::command] pub fn git_show_commit(workspace_path: String, hash: String) -> Result<CommitDetail, String>
// git show <hash> --name-status --format=%H%x00%s%x00%an%x00%aI ; parse header + status lines
#[tauri::command] pub fn git_show_file_at(workspace_path: String, rev: String, file_path: String) -> Result<String, String>
// git show <rev>:<file_path> ; file missing at rev (added/deleted) → Ok("")
```
- Store: `commitDetails: Map<string, CommitDetail>` cache + `getCommitDetail(workspacePath, hash)` (fetch-once).
- Workspace store: `openCommitDiffTab(hash, filePath, title)` — new `diff://commit/<hash>/<relpath>` tab variant; EditorPanel's existing DiffEditor path (EditorPanel.tsx:214) gets original = `git_show_file_at(<hash>^, path)`, modified = `git_show_file_at(<hash>, path)` (same plumbing as `openDiffTab`/workspace.ts:1062, different revs).
- UI: commit row (465–473) becomes expandable — click toggles inline file list from `getCommitDetail`; file click → `openCommitDiffTab`; reuse `statusLabel` (38–47) for per-file letters.
- Manual: commits visible by default; click commit → files; click file → side-by-side diff of that commit.

### Task A5 — Editor gutter decorations for changed lines (M)
**Files:** create `src/features/git/services/gutter-decorations.ts` (+ `.test.ts`); modify `src/features/git/index.ts` (export), `src-tauri/src/git.rs` + `lib.rs` (one command), `src/features/editor/components/EditorPanel.tsx` (attach in onMount), `src/App.css`.
- Rust: `#[tauri::command] pub fn git_diff_file_head(workspace_path: String, file_path: String) -> Result<String, String>` — `git diff HEAD -- <path>` (staged+unstaged vs HEAD, which is what a gutter should show).
- Service:
```ts
export interface GutterRanges { added: Array<[number, number]>; modified: Array<[number, number]>; deletedAt: number[] }
export function parseDiffHunks(unifiedDiff: string): GutterRanges  // pure — parse @@ -a,b +c,d @@ hunks
export function attachGitGutter(editor: IStandaloneCodeEditor, monacoNs: typeof monaco): () => void
// createDecorationsCollection; refresh(path): invoke git_diff_file_head → parseDiffHunks →
// linesDecorationsClassName 'git-gutter-added'|'git-gutter-modified'|'git-gutter-deleted';
// triggers: model change (file switch), 'git-state-changed' Tauri event, save (hook the existing save
// path or dirty→clean transition); returns dispose fn
```
- Limitation (documented in code): decorations reflect DISK state vs HEAD — unsaved buffer edits shift lines until save. Accepted for v1.
- CSS: `.git-gutter-added/modified` = 3px left border via existing `--git-added`/`--git-modified` vars; `.git-gutter-deleted` = small edge triangle.
- EditorPanel onMount: `const disposeGutter = attachGitGutter(editor, monaco)` (import from git feature barrel — allowed); dispose on unmount.
- Tests: bun test `parseDiffHunks` (add-only, delete-only, mixed, multiple hunks, rename-header noise).

### Task A6 — SCM activity-bar changed-count badge (XS)
**Files:** modify the activity bar component in `src/features/app-shell/components/` (the SCM icon that sets `activeSidebarView` to source control).
- Badge = `new Set([...stagedFiles, ...unstagedFiles].map(f => f.path)).size` from `useGitStore`; VS Code-style count bubble (absolute-positioned, `--accent` bg) when > 0.
- Manual: modify 2 files → badge "2"; commit → clears.

### Task A7 — Push/pull/fetch robustness + auto set-upstream (S)
**Files:** modify `src-tauri/src/git.rs` (fetch/pull/push, 402–445), `src/stores/git.ts` (error mapping).
- Shared runner for the three remote commands:
```rust
fn run_git_remote(workspace_path: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(["-C", workspace_path]).args(args)
        .env("GIT_TERMINAL_PROMPT", "0")                 // fail fast instead of hanging
        .env("GIT_SSH_COMMAND", "ssh -oBatchMode=yes")   // no interactive ssh prompt (agent/key still works)
        .output().map_err(|e| e.to_string())?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).to_string()); }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}
```
- `git_push`: on Err, if stderr contains "has no upstream branch" → retry `["push", "-u", "origin", &branch]` (branch via `git rev-parse --abbrev-ref HEAD`).
- Store: map auth-ish stderr ("Authentication failed", "could not read Username", "terminal prompts disabled", "Permission denied (publickey)") → actionable notify: "authentication required — set up a credential helper or SSH key". Keep `lastError` behavior.
- Manual: push new local branch → auto set-upstream; push without credentials → immediate actionable error, no hang.

### Task A8 — Stash + amend (M)
**Files:** modify `src-tauri/src/git.rs` + `lib.rs`, `src/stores/git.ts`, `src/features/git/components/SourceControlPanel.tsx`, `src/types/index.ts`.
- Rust:
```rust
#[derive(Serialize)] pub struct StashEntry { pub index: u32, pub message: String, pub date: String }
#[tauri::command] pub fn git_stash_push(workspace_path: String, message: Option<String>, include_untracked: bool) -> Result<(), String>
#[tauri::command] pub fn git_stash_list(workspace_path: String) -> Result<Vec<StashEntry>, String>
// git stash list --format=%gd%x00%gs%x00%ci ; index parsed from stash@{N}
#[tauri::command] pub fn git_stash_apply(workspace_path: String, index: u32) -> Result<(), String>
#[tauri::command] pub fn git_stash_pop(workspace_path: String, index: u32) -> Result<(), String>
#[tauri::command] pub fn git_stash_drop(workspace_path: String, index: u32) -> Result<(), String>
```
- `git_commit`: add `amend: Option<bool>` param → `git commit --amend -m <msg>` when true (backward compatible).
- Store: `stashes: StashEntry[]`, `refreshStashes`, `stashPush(ws, message?, includeUntracked=true)`, `stashApply/Pop/Drop(ws, index)` (each → refreshStashes + refreshStatus + invalidateBlameAll); `amendMode: boolean` + `setAmendMode` — enabling with empty message prefills from `commitLog[0]?.message`; `commit()` passes amend flag, resets amendMode.
- UI: "Stashes" collapsible section modeled on Worktrees (476–484) — header count + stash-all button; rows with message/date + apply/pop/drop icons. "Amend" checkbox under commit input; button label → "Amend Last Commit"; `refreshStashes` next to `refreshWorktrees` in mount effect (153–155).
- Tests: cargo test stash-list parsing + amend on fixture repo. Manual: stash dirty tree → clean; pop → restored.

**A ordering:** A2 first (fixes two reported bugs) → A1 → A3 → A4 → A6 → A7 → A5 → A8.

---

# Execution Order & Verification

## Suggested overall order
1. **Quick wins:** C1 (hotkeys), C2 (auto-focus), C5 (copy path/reveal), C6 (PTY reset + reload fixes) — small, independent, immediately felt.
2. **Workstream A (git):** A2 → A1 → A3 → A4 → A6 → A7 → A5 → A8.
3. **Workstream B (search):** B1 → (B2→B3→B4) ∥ (B5→B6) → B7 → B8.
4. **Remaining C:** C3 (import links), C4 (explorer reveal), C7 (Claude hard delete), C8 (crash hardening).
Workstreams are independent of each other; within a workstream follow the stated ordering. Each task = one commit (or a small commit series), message style `fix:`/`feat:` matching repo history.

## Global verification gates (every task)
- `bun run build` (tsc + vite) and `cargo build` (in `src-tauri/`) pass.
- `bun test src` and `cargo test` pass.
- Deep Modules check: no new cross-feature internal imports (only barrels).

## End-to-end verification (after each workstream)
- `bun run tauri dev` against a real Unity or TS workspace; walk the per-task manual checklists (B8 for search; per-task manual steps for A and C).
- Full CSV sweep at the end: re-test all 18 items against the running app; mark each fixed/deferred in the PR description.

## Plan copy
At execution start, copy this plan to `docs/superpowers/plans/2026-07-11-tasks-tracker-fixes.md` in the repo (writing-plans convention) so the executing session can check off steps.
