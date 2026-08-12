# Zed-Style Project Search — Design

**Date:** 2026-08-12
**Status:** Approved for planning

## Problem

Content search results render as a tree of truncated single lines in a ~280px
sidebar. A result cannot be judged without opening the file, so every candidate
costs a round trip. There is no replace anywhere in the product — not in the UI,
not in the backend. There is no search history, no way to seed a query from the
selection, no keyboard navigation of results, and only one search can exist at a
time.

The Rust backend is not the problem. It already uses ripgrep's own libraries
(`grep-searcher`, `grep-regex`) over a parallel `ignore` walk, streams batched
results, and cancels per window. It is missing exactly two capabilities:
context lines and replace.

## Approach

Adopt Zed's model. Project search results are not a sidebar list; they are a
**tab in the editor pane** holding a multibuffer — one excerpt per match with
surrounding context, real syntax highlighting, real line numbers, and
(ultimately) editable in place. The sidebar list survives in the role Zed gives
it: a compact outline of matches, bidirectionally synced with the tab.

Three facts verified against the codebase make this buildable rather than
aspirational:

- `diff://` and `auth://` already exist as virtual tab schemes, so `search://`
  follows an established path.
- Monaco 0.55.1 ships `setHiddenAreas` at runtime (present in
  `codeEditorWidget.js`, absent from the public typings). A real file model can
  therefore display only its excerpt ranges, which makes an edit to a result a
  genuine edit to the real model — existing dirty-state and save plumbing
  applies unchanged.
- `monaco.editor.colorize()` produces syntax-highlighted excerpt HTML with no
  editor instance, cheap enough to virtualize hundreds of results.

### Rejected alternatives

**Upgrade the sidebar in place** (context lines on expand, replace, history,
keyboard nav). Far smaller, but the narrow column is the actual constraint and
this does not remove it; it lands at "VS Code with extras".

**Editable multibuffer from day one.** Same destination with no read-only
intermediate. Rejected because nothing ships until model lifecycle, memory caps
and multi-file save all land together, and because `setHiddenAreas` is untyped
internal API with no fallback if it misbehaves.

## Architecture

### Tab identity

Results live at `search://<n>`. The virtual-scheme predicate is currently
open-coded in four places — `workspace.ts:477` (LSP resync), `:1256`
(reopen-closed-tab), `:1348` (reload-from-disk), and `utils/persistence.ts` —
each spelling out `startsWith('diff://') || startsWith('auth://')`. Adding a
third scheme to four copies of one predicate is how a case gets missed, so an
`isVirtualPath()` helper is extracted into `utils/` and all four sites route
through it before anything else is built.

### Module layout

All within the existing `features/search` deep module; public API remains
`index.ts`.

```
features/search/
  components/
    SearchOutlinePanel.tsx   sidebar: compact synced match list
    SearchResultsTab.tsx     the search:// tab — query bar + excerpt list
    SearchQueryBar.tsx       query/replace inputs, toggles, filters, counter
    ExcerptList.tsx          virtualized file blocks
    FileExcerptBlock.tsx     one file: sticky header + its excerpts
  services/
    search-model.ts          existing stream reducers — unchanged
    excerpt-model.ts    NEW  matches + context -> excerpt ranges (pure)
    replace-model.ts    NEW  $1 capture expansion, exclusion sets (pure)
    highlight.ts        NEW  monaco.editor.colorize + cache
    hydration.ts        NEW  (phase 3) model acquisition + setHiddenAreas
```

Components stay thin; all decision logic lives in the pure services, which is
what the repo's bun-only test setup can actually test (there is no RTL in this
project and none is being added).

### Store shape

`stores/search.ts` moves from one global search to
`sessions: Record<string, SearchSession>` keyed by tab id, plus
`activeSessionId` for the outline to follow. Each session owns its query,
options, results, stream state, expanded-excerpt set, replace-exclusion set and
`activeExcerptId`.

This is forced by the decision that the tab owns the query bar — two search
tabs cannot share one `query` field. It also removes the `searchGeneration`
module-global, since generation becomes per-session state.

### Data flow

1. `mod+shift+f` creates a session and a `search://<n>` tab, seeds the query
   from the editor selection, and focuses the input.
2. The debounced query calls `start_content_search` with `contextLines`.
3. Batches stream in, each match carrying its before/after context lines.
4. `excerpt-model` folds a file's matches into excerpt ranges, **merging
   overlapping context windows** so two matches four lines apart render as one
   continuous excerpt rather than two boxes repeating the same code. This is
   what makes the output read like a file instead of a list.
5. `ExcerptList` renders visible blocks; `SearchOutlinePanel` renders the same
   session compactly.

### Risk isolation

`setHiddenAreas` gets exactly one wrapper (`hydration.ts`) with a runtime
capability probe. If it is missing or misbehaves after a Monaco bump, blocks
stay in read-only render and every other feature still works. The failure mode
is degraded, not broken.

### Accepted constraints

- **No cross-file multi-cursor.** Zed's `cmd-d` spanning excerpts from
  different files is out of scope; each file block is its own Monaco instance
  with its own cursors.
- **Hydrated blocks are LRU-capped** (~8) so a 400-file result set never holds
  400 models in memory. Models backing an open tab are never disposed by the
  cap.
- **Height parity is mandatory.** The read-only render and the hydrated editor
  for the same block must compute identical heights
  (`visibleLineCount × lineHeight + header`), or hydration jumps the scroll
  position out from under the reader.
- **Results are a snapshot.** Files changing on disk while results are
  displayed do not re-run the search or invalidate excerpts; the replace
  staleness guard is what prevents a stale snapshot from causing a bad write.
  Live-updating results is explicitly out of scope.

## Interaction

### Query bar

Lives in the tab. Query and replace inputs, `Aa` / `ab|` / `.*` toggles, a
filter row (include/exclude globs, brace expansion), an **include-ignored**
toggle, and a live match counter that ticks up while results stream.

- **History** — `up`/`down` in the query input cycles the last 50 queries for
  that session.
- **Seed from selection** — opening search with a selection seeds the query;
  `mod+e` re-seeds from the current selection without leaving the tab.
  Setting: `search.seedQueryFromCursor: 'selection' | 'always' | 'never'`,
  default `'selection'`.
- **Smartcase** — a lowercase query searches case-insensitively; a query
  containing an uppercase letter goes case-sensitive automatically. Setting:
  `search.useSmartcase`, default on. The explicit `Aa` toggle overrides it.

`include-ignored` matters beyond parity: gitignored files are currently
unsearchable with no override at all.

### Excerpts

A file block is a sticky header (icon, file name, dimmed relative path, match
count) followed by that file's merged excerpt ranges.

- `shift+enter`, or the ⌃/⌄ gutter affordances, expands context a few lines at
  a time.
- `alt+enter` opens the real file at that exact position.
- `mod+alt+enter` opens it in a split.
- Clicking the file header collapses/expands the block.
- Context defaults to 2 lines each side, via `search.contextLines`.

Expansion needs no new backend command: the session reads the file once via the
existing `read_file` and caches it — the same content hydration later wants.

### Outline sync

Clicking a sidebar row scrolls the tab to that excerpt and flashes it. Moving
the cursor between excerpts in the tab highlights the corresponding sidebar
row. A single `activeExcerptId` on the session drives both directions.

The activity bar keeps its Search view; it now renders the outline for
`activeSessionId`. `mod+shift+f` opens or focuses the **tab** and does not
force the sidebar open — the outline is an aid, not the primary surface. With
no search tab open it creates one; with one already open it focuses that tab
and selects its query text so retyping replaces it (Zed's `DeploySearch`). A
separate "New Search" command always creates an additional tab, which is how
two searches coexist.

`F3` / `shift+F3` move the active excerpt to the next/previous **match** within
the focused results tab, scrolling and syncing the outline. They do not alter
Monaco's own in-file find behaviour in ordinary editor tabs.

### Search in folder

The explorer's directory context menu gains "Search in Folder", which opens a
search tab with the include-glob pre-seeded to that directory. This is the same
`DeploySearch`-with-seeded-filters path the keybinding uses, not a second
mechanism.

### Replace

1. Typing in the replace field renders an **inline preview** on each match —
   old text struck through, new text following — before anything is written.
2. Any match, or a whole file, can be **excluded** from the replacement, so
   replace-all is not all-or-nothing.
3. `$1`-style capture references work in regex mode.
4. **Files open with unsaved changes are routed through their Monaco model, not
   through disk.** Otherwise a project replace silently overwrites edits
   sitting in a dirty tab.
5. For those dirty files the recorded match offsets cannot be trusted — search
   read disk, and the model has since diverged. Replace therefore **re-locates
   each match in the model text** and verifies the text at that position is
   still the matched text; any match that fails verification is skipped and
   reported, never guessed at.
6. Every disk-routed edit carries a **staleness guard**: the backend refuses
   any file whose content hash changed since the search observed it, and
   reports it rather than writing the wrong bytes.
7. A one-shot **Undo Replace All** restores every touched file to its
   pre-replace content and stays available until the next replace runs. Closed
   files are restored by writing back the snapshot; open files are restored
   through their model, so the tab's own undo stack survives and the restore is
   itself undoable.

### Keybindings

| Chord | Action | Note |
|---|---|---|
| `mod+shift+f` | Open/focus search tab | Repurposed from "focus sidebar search" |
| `mod+shift+h` | Replace in Files | Taken from AI Chat History, which moves to `mod+alt+h` |
| `mod+e` | Use selection for find | Unclaimed |
| `alt+mod+c` / `alt+mod+w` / `alt+mod+x` | Toggle case / whole word / regex | Unclaimed; Zed-faithful |
| `shift+enter` | Expand excerpt | Within the results tab |
| `alt+enter` | Open excerpt in editor | Within the results tab |
| `mod+alt+enter` | Open excerpt in split | Within the results tab |
| `F3` / `shift+F3` | Next / previous match | Zed uses `cmd-g`; that is Go to Line here and stays |

`menu.rs` was checked and registers **no** Find or Search accelerator, so no
native menu shadows any of these. `mod+g` (Go to Line) and `mod+shift+g`
(Source Control) are deliberately left alone. When these bindings are
implemented, `menu.rs` is re-grepped for each chord and command id per the
standing rule in CLAUDE.md.

## Backend changes

**Context lines.** `search_file` already receives the whole file as
`content: &[u8]` (`search.rs:355`), so context is a slice off a line index
built from memory already in hand — no `SearcherBuilder` context configuration,
no sink rework, and a pure function that unit-tests without a filesystem.

**Per-session cancellation.** The cancellation cursor is keyed by window
label, so a search started in one tab supersedes a search still running in
another — the second tab keeps whatever partial results it had, with no error
and no indication anything was cut short. Multiple search tabs make this
reachable, so the cursor is keyed by window **and** session, and both search
commands take a `sessionId`.

**Options.** `ContentSearchOptions` gains `contextLines` and `includeIgnored`.
`includeIgnored` requires `walk_policy` to accept an options struct rather than
growing a second entry point, and the explorer and quick-open callers must come
out behaviourally identical.

**Replace.** One new command taking explicit per-file edits plus the content
hash the search observed, returning per-file `applied | stale | error` and a
pre-replace snapshot for undo. It must satisfy `check:invoke`, and it gets
raw-JSON serde tests on the Rust side — a typed test alone has previously
failed to catch invoke-payload drift in this repo.

## Phases

Each phase ships on its own and gets its own implementation plan; this spec is
not planned as a single unit.

| Phase | Scope | Delivers |
|---|---|---|
| 0 | Extract `isVirtualPath`; make the store session-keyed | Nothing visible — pure refactor, existing panel keeps working |
| 1 | Rust context lines; `search://` tab with colorized excerpts, merged ranges, expansion, streaming; sidebar becomes synced outline; include-ignored; search-in-folder from the explorer | The Zed reading experience |
| 2 | Replace: preview, per-match exclusion, dirty-buffer routing, staleness guard, undo | Project-wide replace |
| 3 | Hydration via `setHiddenAreas`; `saveAll` | Editing results in place |

## Verification

Pure services carry the logic and the tests, mirroring `search-model.test.ts`:
excerpt merging and expansion, replace capture expansion and exclusion sets,
the history ring, and outline/excerpt selection.

Rust tests cover the edges that break silently:

- a match on line 1 and a match on the final line (context clamping)
- CRLF files, and BOM preservation through replace
- long-line preview trimming interacting with context slicing
- multi-edit offset arithmetic within a single file
- the staleness guard actually refusing a changed file
- `includeIgnored` on and off over a fixture with a `.gitignore`

`bun run verify` gates every phase per CLAUDE.md. A `SKIPPED` from
`verify:intellisense` is reported as a skip, never as a pass.

**Manual pass on the real flow**, because a green suite has twice hidden a
broken user-visible path in this repo: run a real search in a real Unity
project, expand context, replace across files with one match excluded, undo it,
and confirm a dirty tab's unsaved edits survived intact.
