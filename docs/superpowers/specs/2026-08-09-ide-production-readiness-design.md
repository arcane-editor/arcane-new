# IDE Production Readiness: Correctness, Foundation, and the Two Unity Surfaces

**Date:** 2026-08-09
**Status:** Approved, planning
**Scope:** `editor/src-tauri/src/`, `editor/src/`, `editor/src/App.css`,
`arcane-extension/Editor/`, `.github/workflows/`

Findings referenced as **C1–C3 / H1–H12 / M1–M27 / L1–L7** are catalogued in
[the audit appendix](2026-08-09-ide-production-readiness-audit.md).

Two pairs in that catalogue are the same defect reported by two domains: C1 and
C3 are both the Windows terminal stub, and C2 and H5 are both the Explorer
Refresh button. There are **47 distinct defects**, not 49.

One finding is **out of scope here**: H8 (a slow Unity RPC handler starves the
heartbeat, so the IDE declares Unity dead) has its root cause —
`MainThreadDispatcher.EnqueueAndWait` parking the bridge worker — already
addressed by the in-flight
[bridge reconnection design](2026-08-09-unity-bridge-reconnection-design.md).
It is tracked there, not duplicated into Phase 4.

## Problem

The editor is feature-rich — 33 feature modules, 56k lines of TypeScript, 22k
lines of Rust — but it does not feel finished next to VS Code or Cursor, and the
reason has never been diagnosed. "Add polish" is not actionable. This design
starts from a measured audit instead.

Four distinct problems are tangled together in that feeling. Only one of them is
about appearance.

### P1 — Features that have never worked once

Three user-facing Unity verbs are dead on arrival, all from the same defect.
`fuzzy_search_files` (`file_scanner.rs:279`) declares `max_results: usize` and
`extra_excludes: Vec<String>` — neither `Option`, neither defaulted. Tauri
camel-cases these to `maxResults` / `extraExcludes`.

`PaletteModal.tsx:151` passes both and works. `open-script.ts:25` and
`UnityAssetPickerModal.tsx:46` pass `limit` instead and omit `extraExcludes`
entirely, so Tauri's deserializer rejects the call before the command body runs.
Both call sites wrap the invoke in `catch { return false }` / `catch { setResults([]) }`,
so the rejection is swallowed with no toast, no log, and no visible failure.

The result: clicking a script component in the Unity Hierarchy has never opened
a file (**H11**), and "Unity: Open Scene…" and "Unity: Find Asset…" have always
reported zero results in every project (**H10**).

This is not an isolated slip. There are **254 `invoke()` call sites covering 118
distinct commands** against **131 registered Rust commands**, and every argument
name is matched by hand across a language boundary with no checking on either
side. Nothing fails at build time; everything fails silently at runtime.

### P2 — Windows is unverified, and partly unimplemented

Most Unity developers work on Windows. Development happens on macOS. Nothing
bridges that gap:

- **No CI job runs any test for the editor app.** `release.yml` and
  `dev-build.yml` build on `windows-latest`, but neither runs `bun test`,
  `cargo test`, `tsc --noEmit`, or `check:modules`. The only `pnpm test` in the
  repo belongs to the landing page. `bun run verify` — which `CLAUDE.md` calls
  unconditional — has only ever run on one developer's Mac, by hand.
- **The integrated terminal cannot start on Windows at all** (**C1**).
  `terminal.rs:430` is an unimplemented stub returning
  `Err("Windows PTY writer not implemented")`, propagated by `?` at line 585 —
  *after* `openpty` and `spawn_command`, so every attempt also leaks a `cmd.exe`.
  portable-pty 0.9 does implement a ConPTY writer (`take_writer`); this is
  unfinished work, not a platform limit. Every PTY test in the file is
  `#[cfg(unix)]`.
- Ten findings are Windows-only, and several are silent: a Unity Hub
  installed outside `C:\Program Files` kills all C# IntelliSense with no error
  (**H1**); the Monaco model URI puts the drive letter in the URI *authority*,
  so every LSP request names a document the server was never told about
  (**H3**).

### P3 — No shared foundation, so every surface drifts

| Measure | Value |
|---|---|
| Inline `style={{…}}` objects | 362 |
| CSS files | 2 (`App.css` at 5,847 lines, plus 43 lines of comment styling) |
| Non-color design tokens | 0 |
| Native `title=` tooltips | 149 |
| `catch` sites that swallow silently | 115 of 326 |

Colors *are* tokenised — `theme/apply.ts:26` writes each theme key to `:root`
as a custom property. Nothing else is. There are no tokens for spacing, radius,
type scale, elevation, or motion, so every panel re-derives its own row height
and padding inline and they disagree. Motion exists (17 `@keyframes`) but is
applied to modals and not to sidebars, panels, tabs, or trees.

The 149 `title=` attributes are the single loudest cheap-tell: the OS tooltip is
slow, unstyleable, and cannot present a keyboard chord. Five of them hardcode
`⌘`/`⇧` and render those glyphs verbatim on Windows (**M24**).

Three status-bar items are worse than unstyled — they are untrue. `Spaces: 4`,
`UTF-8` and `LF` are hardcoded literals never derived from the open file
(**M23**); a second Unity connection indicator contradicts the first and is
never hidden for non-Unity projects (**M21**); the bottom panel ships an
"Output" tab that nothing in the codebase can write to (**M22**).

### P4 — Three paths that destroy work silently

Independent of platform or polish, and the reason "no weird bugs" is not a
polish request:

- Explorer **Refresh** and **Collapse All** both call `setWorkspace()`
  (`ExplorerPanel.tsx:404,517`), the full workspace-switch action. It closes
  every tab **without a dirty check**, kills every terminal mid-command, resets
  the AI conversation, and clears `recentlyClosed` — so Cmd+Shift+T cannot undo
  it and the persistence subscriber writes the empty tab list a second later
  (**C2/H5**). Every other close path in the app awaits `confirmCloseDirty`.
  `refreshTree()` exists on the same store.
- **Discard All Changes** runs `git checkout -- .` plus `git clean -fd`
  immediately, with the button adjacent to Stage All (**H6**). Untracked new
  assets are not in git and not in a stash. VS Code gates this behind an
  explicit irreversibility modal.
- **Closing a tab never disposes its Monaco model** (**H4**). Discard the
  unsaved changes on a file, then run an LSP rename that touches it: the
  orphaned model still holds the discarded text, `findModelForUri` finds it,
  and the whole buffer is written back to disk. The file becomes the version
  the user explicitly threw away — and anything Unity, git, or another editor
  wrote to it since is overwritten too.

## Design decisions

Eight forks were resolved before this document:

| Decision | Choice |
|---|---|
| Sequencing | Windows blockers → foundation → features → remaining bugs |
| Windows verification | CI matrix + platform-parameterised tests; no interactive Windows machine |
| Visual direction | Familiar VS Code skeleton, distinctive Arcane surfaces |
| Onboarding | Contextual one-time coach marks, not a tour |
| Plan suggestions | Select text → suggest change, batched into one revise |
| Plan progress | Live step state rendered in the document, model/effort in the footer |
| Plan history | Plans are artifacts of the chat session that produced them |
| Scene switching | Browse any scene offline; open the live one on demand |

The visual decision is the load-bearing one. Layout, density, and every chord
stay VS Code-identical so a developer arriving from VS Code or Rider relearns
nothing. The surfaces that are uniquely Arcane — AI panel, plan preview, Unity
Hierarchy, Unity status, welcome — carry the distinctive treatment. Familiar
enough to switch to; distinctive enough to screenshot.

## Phase 0 — Make Windows verifiable

Everything downstream depends on this, so it lands first and alone.

A new `.github/workflows/ci.yml`, triggered on push and pull request:

- Matrix `[windows-latest, macos-14]`.
- Steps: `tsc --noEmit`, `bun run check:modules`, `bun test src`,
  `cd src-tauri && cargo test --lib`.
- `verify:intellisense` stays out of CI: it needs a real Unity install and its
  own skip semantics (`ARCANE_INTELLISENSE_E2E=required`) make it a local gate,
  not a CI one. Documented in the workflow so nobody "fixes" it by adding a
  quiet skip.

The Rust suite has never been compiled for `x86_64-pc-windows-msvc` in test
configuration. Expect this job to fail on first run for reasons unrelated to any
finding here; getting it green *is* the deliverable.

### The invoke-argument guard

P1 is a class, not an incident, so it gets a structural fix rather than three
one-line patches.

A new `scripts/check-invoke-args.mjs`, run in CI beside `check:modules`:

1. Parse `src-tauri/src/**/*.rs` for `#[tauri::command]` functions, recording
   each parameter name and whether it is `Option<…>` or carries a serde default.
   Skip Tauri-injected parameters (`tauri::State`, `tauri::Window`,
   `tauri::AppHandle`).
2. Parse `src/**/*.ts{,x}` for `invoke('name', { … })` calls with an object
   literal, recording its keys.
3. Camel-case the Rust names and compare. Report any missing required argument
   or any key the command does not accept.

Call sites whose payload is not a literal are reported as unchecked rather than
passing silently — an honest count beats a green light that means nothing.

This catches H10 and H11 as its first output, and prevents every future
recurrence across all 254 sites. A per-command typed wrapper layer would also
work but requires touching 118 commands; the static check is a fraction of the
work for the same guarantee, and does not need callers to cooperate.

## Phase 1 — Blockers: Windows, data loss, dead features

| Fix | Location | Notes |
|---|---|---|
| Implement `clone_master_as_writer` for Windows | `terminal.rs:430` | Use portable-pty's `take_writer()`. Restructure so the writer is obtained *before* `spawn_command`, or kill the child on the error path — the current order leaks a shell per attempt. Lift the `#[cfg(unix)]` gate off the PTY tests that can run on both. |
| Refresh / Collapse All stop calling `setWorkspace` | `ExplorerPanel.tsx:404,517` | Refresh → `refreshTree()`. Collapse All → collapse local tree state; it should never touch the workspace at all. |
| Confirm before discarding | `SourceControlPanel.tsx:590,618` | Explicit modal naming the file count and stating irreversibility; untracked files called out separately, since those are the unrecoverable ones. |
| Dispose Monaco models on tab close | `workspace.ts:1197`, `workspace-edit.ts:304` | **H4** — models are never disposed, so `findModelForUri` can find an orphan holding edits the user explicitly discarded and write that whole buffer to disk during an LSP rename, silently reverting anything Unity or git wrote since. Same data-loss class as the two rows above, so it lands here rather than Phase 4. Also stops unbounded memory growth across a day's browsing. |
| Stop hard-limiting search to `.cs` | `search.ts:156` | **H7** — searching a Unity project for a shader property, an `.asmdef` define, a `.uxml` key or a component name inside a `.prefab` reports "No results found", and typing `*.shader` into the include filter cannot override it because the backend ANDs the glob with the hardcoded extension list. Nothing in the UI says so. A core IDE verb returning confident wrong answers. |
| Read argv on launch | `lib.rs:683` | Parse `--goto <path>:<line>:<col> <projectPath>` from both the cold-start and single-instance paths. Split from the **right** on `:` — a Windows path carries a drive-letter colon (`C:\Proj\Foo.cs:42:1`). |
| Unity Hub discovery on Windows | `unity.rs:373` | Add the Windows equivalent of the existing macOS `resolve_from_hub_json` (`unity.rs:262`), reading the Hub's `secondaryInstallPath` / `editors-v2.json` rather than assuming `C:\Program Files\Unity\Hub\Editor`. |
| Monaco model URI | `EditorPanel.tsx:130` | `file://` + a drive-lettered path puts `C:` in the URI authority. Build the URI so the drive letter lands in the path, and assert the LSP-side and Monaco-side URIs are byte-identical in a test. |
| Fix the three dead invokes | `open-script.ts:22`, `UnityAssetPickerModal.tsx:46` | Falls out of the Phase 0 guard. |
| Platform-correct title bar | `App.css:146`, `tauri.conf.json` | 78px traffic-light gutter is macOS-only; `decorations` is never disabled, so Windows gets two stacked title bars. `isWindows()` already exists in `utils/platform.ts` and is called zero times. |
| `CREATE_NO_WINDOW` on spawned processes | git, LSP, Unity, dotnet call sites | A console window flashes on Windows for every git call. |
| Mono discovery | debugger paths | Splits `PATH` on `:` and omits `.exe`; the Unity debugger can never attach on Windows. |
| `Cmd+Shift+T` collision | `menu.rs` | The native macOS menu binds it to the theme picker, so Reopen Closed Tab does different things per OS. Per `CLAUDE.md`, every keybinding change in this project checks both sides. |

Path handling gets platform-parameterised tests — the same functions exercised
with `C:\…`, `\\?\C:\…`, UNC, and POSIX inputs — so they run and fail on macOS
too, rather than waiting for a Windows runner.

## Phase 2 — The foundation

### Tokens

A new `src/styles/tokens.css`, imported before `App.css`, defining on `:root`:

- `--space-1` … `--space-8` (4px base scale)
- `--radius-sm|md|lg|full`
- `--text-xs|sm|base|lg` with matching line heights
- `--shadow-1|2|3`
- `--motion-fast` 120ms, `--motion-base` 180ms, `--motion-slow` 280ms
- `--ease-out` `cubic-bezier(.16,1,.3,1)`, `--ease-in-out` `cubic-bezier(.65,0,.35,1)`
- `@media (prefers-reduced-motion: reduce)` collapses all three durations to 1ms

Geometry and motion are **not** themeable and deliberately do not go through
`theme/apply.ts`. Themes own color; this sheet owns everything else. Three new
*color* tokens do join the theme contract — `modeAsk`, `modeAgent`, `modePlan` —
added to all six theme definitions. `theme-contract.test.ts:100` already asserts
`{missing, extra}` is empty for every theme, so a theme that forgets one fails
the suite; the same file's WCAG AA contrast rules apply to the new tokens, which
constrains how saturated the mode accents can be on light themes.

`App.css` is **not** reorganised. Moving 5,847 lines produces an enormous diff
with no user-visible benefit and real regression risk. New rules go in the new
sheets; existing rules are edited in place as their components are touched.

### Primitives

`src/components/primitives/`: `Panel`, `PanelHeader`, `PanelBody`, `Row`,
`IconButton`, `Tooltip`, `EmptyState`, `Skeleton`. Adoption is incremental and
ordered by the inline-style census — `SceneDiffViewer` (31), `AssetViewer` (27),
`AddWorktreeDialog` (25), `TestPanel` (23), `UnityConsolePanel` (23),
`SourceControlPanel` (22), `WelcomeApp` (19), `HierarchyPanel` (17) — plus every
panel Phase 3 rewrites anyway.

### Tooltips

One portal-rendered tooltip instance, ~500ms warm-up, instant hand-off between
adjacent targets, dismissed on Escape and scroll.

```tsx
<Tooltip label="AI Assistant" commandId="view.aiPanel">
```

The chord is read from the command registry and rendered through the existing
`formatKeybinding` — never written at the call site. This is why the whole
"show me the shortcut" request is one change rather than one change per button:
every migrated `title=` gains its chord automatically, and the five tooltips
hardcoding `⌘` on Windows stop lying.

### Motion

Applied to sidebar and panel show/hide, tab switch, modal and popover entry,
toast, and tree expand/collapse. Motion communicates state change and direction;
nothing animates purely for decoration, and everything respects
`prefers-reduced-motion`.

### AI mode affordances

- `mod+.` cycles Ask → Agent → Plan.
- `mod+shift+l` new chat, `mod+shift+h` chat history.
- Each mode carries its token color on the pill, the popover's selected row, and
  a hairline on the composer, so the active mode is legible without reading.

All three chords were checked free against both `App.tsx` and `menu.rs`.

### Settings controls

`SettingRow` currently renders exactly three control types, which is why
`terminal.fontFamily` displays `ui-monospace, SFMono-Regular, Menlo, Monaco,
'Cascadia Mono', 'Courier New', monospace` as its own dropdown label. Two new
types:

- `font` — each option rendered **in the font it names**, with a short preview
  strip beneath showing real terminal text at the current size. The stack stays
  the stored value; the label becomes a human name.
- `range` — slider plus numeric input for font sizes and delays.

The Terminal section additionally gets a live preview panel so font and size
changes are visible without closing the modal.

### Coach marks

A registry of `{ id, trigger, anchor, message, commandId? }`. Triggers are
events, not timers — Unity connects for the first time, the first `.cs` file
opens, the first compile error arrives. One at a time, at most once ever,
persisted in settings, dismissible, with a "Show tips again" reset in Settings.

### Honesty and felt performance

Derive `Spaces: N`, encoding, and line endings from the active file rather than
printing literals — the values are cheaply available from the Monaco model, and
a status bar that is merely *correct* stops reading as a mockup. Delete the
duplicate Unity indicator and the dead Output tab outright; neither has a
correct version to fall back to.

Two performance findings are promoted into this phase because they are felt
rather than theoretical:

- **M9** — the file watcher watches the project root recursively with no ignore
  filtering, so Unity's constant `Library/` and `Temp/` writes drive a
  continuous git-status and tree-refresh storm. This runs the entire time a
  Unity project is open.
- **M13/M17** — the Unity Console renders all 10,000 rows unvirtualized and
  re-filters every one of them on each 100ms batch, freezing the window under
  ordinary Play-Mode logging.

## Phase 3 — The two Unity surfaces

### 3C — Unity Hierarchy

**Protocol.** `HierarchySerializer.SerializeGameObject` currently emits
`{ type }` per component — a bare type name with no asset identity, which is why
the frontend cannot distinguish `PlayerController` from `Rigidbody` and resorts
to guessing at a filename. It gains, for `MonoBehaviour` components only:

```
{ type, script?: { path, guid } }
```

resolved via `MonoScript.FromMonoBehaviour(mb)` → `AssetDatabase.GetAssetPath` →
`AssetDatabase.AssetPathToGUID`, and emitted **only** when the path is under
`Assets/`. Package and built-in components carry no `script` key. The existing
byte budget accounts for the new strings.

This makes the mapping exact. Filename-based lookup disappears entirely — the
panel opens `script.path` directly, which also handles namespaces, nested types,
and files whose name genuinely differs from the class.

**Two new RPCs.**

- `listScenes` → `{ scenes: [{ name, path, guid }] }`, from
  `AssetDatabase.FindAssets("t:Scene")` filtered to `Assets/`.
- `openScene(path, mode)` → `EditorSceneManager.SaveCurrentModifiedScenesIfUserWantsTo()`
  first, then `OpenScene`. Refused with a typed error while
  `EditorApplication.isPlaying` or `isCompiling`; the UI disables the action and
  says why rather than failing on click.

**Offline scenes.** A Rust command parses an unopened `.unity` file into the
same `SceneHierarchy` shape, reusing `unity_yaml.rs`: GameObjects, the Transform
`m_Father`/`m_Children` graph for nesting, and `MonoBehaviour.m_Script` GUID
references resolved to script paths through the existing Unity index. It runs
off the main thread with a file-size guard — **M15** records the existing YAML
path parsing synchronously on the main thread with a regex compiled per
GameObject, and this must not repeat that.

The panel becomes source-agnostic: loaded scenes render live from the bridge,
unloaded ones from disk with a "Preview" badge and an "Open in Unity" action.
**The Hierarchy stops being dead when Unity is not running**, which is the
single largest behavioural gain in this phase.

**Panel.** Header becomes a scene picker listing every project scene, loaded
ones marked live. Rows show the GameObject and only its `Assets/**` scripts —
no `Transform`, no `BoxCollider`. Clicking a script opens it. The trailing
badge counts scripts rather than components.

**Version skew.** An older installed package sends no `script` key anywhere. The
panel detects that and surfaces the existing outdated-package affordance
(shipped in 34bb847) rather than silently showing empty GameObjects.

### 3D — Markdown and plan preview

**New feature** `src/features/markdown-preview/`, rendering through the
`react-markdown` + `remark-gfm` pair already used by `AssistantMessage`. Raw
HTML stays disabled (no `rehype-raw`) — plan documents are model output.

**View mode.** Per-path, in the ui store, exactly the pattern `assetViewerMode`
and `diffViewMode` already establish. `.md` opens in Preview by default with a
`markdown.defaultView` setting for people who would rather edit; plan files
always open in Preview. `mod+shift+v` toggles.

**Select to suggest.** Selecting text in the preview raises a floating "Suggest
change" affordance; the note is captured as
`{ quotedText, headingPath, contextBefore, contextAfter }`.

Anchoring is by **quoted text plus nearest heading**, never by character offset.
The AI rewrites the whole document on revise, so offsets are guaranteed to move.
After a rewrite each note re-anchors by searching for its quoted text; a note
that no longer matches becomes *unanchored* and stays visible in the footer list
rather than vanishing. Losing a user's note silently would be worse than showing
it without a highlight.

Notes live in the session record, not in the `.md`. The file stays clean, since
execution re-reads it from disk.

**Revise.** The footer collects pending notes; "Revise plan" sends them as one
structured message in plan mode — each note as its quoted text under its
heading — and the AI rewrites the file. The preview re-renders and re-anchors.

**Execution.** Steps are parsed from markdown task-list items and numbered
headings, then correlated with the live `arcanePlan` entries (which `todo_update`
already maintains and `SessionData` already persists) to mark the running step.
The document itself is the progress view: `✓` done, `◐` running, `○` pending,
`✗` failed, with `step N of M` and a progress bar in the header.

The footer carries **Execute**, then **Stop** while running, plus model and
effort pickers. **Pause is out of scope**: `agent-loop.ts` checks
`config.signal?.aborted` at its loop boundaries and has no suspension point, so
a Pause button would either be a relabelled Stop or require restructuring the
loop. Stop maps to the existing `planController.abortExecution`.

**Session linkage.** `SessionData` gains an optional
`plans?: Array<{ path, title, createdAt, status, revisions }>` and
`SessionSummary` gains `planCount` — the same backward-compatible optional-key
pattern `arcanePlan` uses, so sessions written before this change load
unchanged. `SessionHistory` rows show a plan chip that reopens the plan in
preview with its notes and outcome intact.

`plan-files.ts` also stops building paths with hardcoded `/` and
`lastIndexOf('/')`, which produces mixed separators on Windows.

## Phase 4 — Remaining findings

The medium and low findings not promoted into Phases 1 and 2, less H8 (owned by
the bridge reconnection design). Highest-value cluster:

- **M5** — `saveFile` clears `isDirty` *after* the write, so keystrokes typed
  during the write are marked saved, never written, then silently reverted by
  the watcher.
- **M6** — closing a tab never clears its diagnostics; Problems keeps reporting
  closed and deleted files.
- **M7** — drag-and-drop copy breaks the Unity asset ↔ `.meta` pairing on name
  collision, producing a new GUID and an orphan `.meta`.
- **H9** — PlayMode test runs never finish, because the play-mode domain reload
  unregisters the TestRunnerApi callbacks and nothing re-registers them. The
  panel sits at "Running 0/12" forever while the tests actually complete.
- **M16/M20** — Unity editor state is not seeded on handshake, so Play/Pause/Stop
  are wrong whenever Unity was already playing at connect time; and console
  history plus the last compile report survive a workspace switch, showing
  project A's errors as project B's.
- **M10/M11/M12** — terminal lifecycle: the panel cannot be emptied, the first
  toggle spawns two shells, and a workspace switch leaves a terminal in the
  previous project's cwd.
- **M14 / L3 / L4 / L5** — the remaining unvirtualized surfaces and per-render
  allocations, after the Console and watcher work in Phase 2.
- **L7** — 115 of 326 catch sites swallow silently. Not a blanket rewrite; the
  ones on user-initiated actions get surfacing.

## Testing

- **Phase 0** is itself the test infrastructure. No phase may be called done
  until the Windows job is green.
- **Windows correctness** is tested by platform-parameterised unit tests that
  run on every host — path normalisation fed Windows-shaped inputs, URI
  construction asserted identical between Monaco and LSP, argv parsing fed a
  drive-lettered `--goto` string.
- **The invoke guard** is a build-time check, not a test, and runs in CI.
- **Protocol changes** (3C) get round-trip tests on the C# serializer and a
  frontend test that an old-shaped payload with no `script` keys degrades to the
  outdated-package path instead of rendering empty rows.
- **Plan anchoring** (3D) gets tests for the case that matters: a note survives a
  full document rewrite that moves its text, and becomes unanchored rather than
  lost when its text is deleted.
- `bun run verify` remains the local gate, unchanged, including
  `verify:intellisense`.

## Non-goals

- No reorganisation of `App.css`, `workspace.ts` (1,626 lines), or `git.rs`
  (4,561 lines). Real problems, wrong project — splitting them here would bury
  every change in this design inside an unreviewable diff.
- No migration of all 118 commands to typed wrappers; the static guard delivers
  the same guarantee for a fraction of the work.
- No Pause during plan execution.
- No new themes, no theme editor.
- No AI capability work. This design deliberately stops at making the IDE worth
  using before the AI is considered.

## Risks

- **The Windows CI job may fail broadly on first run.** The Rust suite has never
  been compiled for MSVC in test configuration. This is a discovery, not a
  regression, and Phase 0 is scoped to absorb it.
- **`terminal.rs` on Windows is unwritten, not broken.** ConPTY behaves
  differently enough from a Unix PTY around resize and close that the fix may
  need more than swapping in `take_writer()`, and it cannot be exercised
  interactively — only through CI and user reports.
- **The offline scene parser is a second implementation** of hierarchy
  extraction, and can drift from the C# serializer. Both must produce the same
  `SceneHierarchy` shape, enforced by a shared fixture tested on both sides.
- **Coach marks can become nagging.** Hard cap of one visible at a time, once
  ever, with a global off switch.
- **47 distinct defects is what eight domains found, not what exists.** Each
  finder was capped at eight findings and the medium and low tiers were sampled
  rather than exhausted, so Phase 4's list will grow as work proceeds.

## Plans

Each phase gets its own implementation plan. Phase 0 and Phase 1 plan together,
since Phase 0 has no independent user-visible value and Phase 1 is what it
exists to verify.
