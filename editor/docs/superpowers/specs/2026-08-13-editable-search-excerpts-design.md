# Editable Search Excerpts (Phase 3) — Design

**Date:** 2026-08-13
**Status:** Approved for planning
**Builds on:** `docs/superpowers/specs/2026-08-12-zed-style-project-search-design.md` (Phases 0–1, merged)

## Problem

Phase 1 shipped the reading experience: search results render as syntax-highlighted
excerpts with context in a `search://` tab. They are still HTML — you cannot edit
them, which is the half of Zed's multibuffer that makes it more than a rich results
list. Three smaller defects surfaced alongside:

1. Each excerpt carries a full-width ⌃ button above it and a ⌄ button below it. Zed
   has nothing like this; expansion belongs on the divider between excerpts.
2. Opening a result at a chosen position (mod+click / Enter) was designed but never
   built.
3. Search returns every file type. In a Unity project the results are dominated by
   `.meta` sidecars and YAML assets, which a programmer is rarely searching for.

## Decision 1: editing routes through `openFiles`

Every piece of correctness around editing in this app is keyed to the `openFiles`
array, not to Monaco models:

- `updateFileContent(path, content)` (`workspace.ts:1336`) marks the file dirty AND
  syncs the change to the language server.
- `saveFile(path)` (`:1351`) writes `file.content` from the store.
- `applySaveResult` cleans the dirty flag only if the buffer still matches what was
  written, so the file watcher cannot reload over keystrokes typed mid-write.

Zed can mark a file dirty with no tab because it has a unified buffer store. This
app does not. Reimplementing that layer for search would duplicate the most
correctness-sensitive code in the editor.

**Therefore: typing in an excerpt opens that file as a background tab, on first edit
only.** Hydrating a block or scrolling past it opens nothing. The first keystroke
adds the file to `openFiles` without activating it, and from that moment every
existing behaviour applies unchanged — dirty indicator, `mod+s`, close guard, LSP
sync, watcher protection.

This differs from Zed, which shows no tab. Accepted: the tab is also honest feedback
that a file was modified, and gives the user a place to review, undo and save.

## Decision 2: model ownership must be explicit

`disposeModelForPath` (`features/editor/services/model-disposal.ts`) documents a live
hazard: a Monaco model that outlives its tab is an orphan, and a later project-wide
LSP rename or quick-fix can find it via `findModelForUri`, apply an edit, see no open
tab, and **write the entire orphan buffer to disk** — reverting the file to a version
the user discarded and overwriting anything Unity or git wrote meanwhile.

A search tab that creates models for files with no tab creates exactly such orphans.
Ownership is therefore stated explicitly:

| Situation | Owner | Disposal |
|---|---|---|
| File already open in a tab | The tab | Existing `disposeModelForPath` on close. Search reuses the model and never disposes it. |
| Hydrated by search, never edited | Search | Disposed on LRU eviction, on a new search, and when the search tab closes. |
| Hydrated by search, then edited | The tab opened on first edit | Ownership transfers at that moment; search stops tracking it. |

A search-owned model is only ever disposable because it has no unsaved changes by
definition — the first edit transfers ownership before any change exists.

Models are acquired by `fileUri(path)` (`features/lsp`), never a hand-built
`file://` string: on Windows the latter parses the drive letter as the URI authority,
so the model URI would not match what the language server was told at `didOpen`.

## Rendering: hydrate the visible, render the rest

Each file block has two representations at **identical height**:

- **Cold** — today's HTML render (`colorize`d context lines, `<mark>` on matches).
- **Hot** — a real Monaco editor bound to the file's model, with `setHiddenAreas`
  hiding every range outside the excerpts.

Blocks in or near the viewport are hot; the rest are cold. Height parity is
mandatory (`visibleLineCount × lineHeight + header`) — if the two disagree,
hydration jumps the scroll position out from under the reader. Hot blocks are
LRU-capped at 8.

`setHiddenAreas` is untyped internal Monaco API. It goes behind a single adapter
with a runtime capability probe; if it is ever absent, blocks stay cold and every
other feature still works. The failure is degraded, not broken.

**Out of scope, as in Phase 1:** cross-file multi-cursor. Each block is its own
editor with its own cursors.

## Expansion moves to the divider

The always-visible ⌃/⌄ bars are removed. Expansion is:

- `shift+enter` on the focused excerpt (unchanged).
- A hover-revealed control on the divider between excerpts, gutter-aligned.

A block's first excerpt has no divider above it and its last none below, so those two
edges reveal their control on hover of the excerpt's own top and bottom edge rather
than on a divider. Expanding at a file boundary clamps silently, as it does today.

`session.expanded` remains the single source of truth for both representations, so a
block expanded while cold keeps that expansion when it hydrates and vice versa. Only
the mechanism differs: a hot block widens its visible ranges via the `setHiddenAreas`
adapter, while a cold block continues to splice lines through `applyExpansion`.

## Save-all

`mod+s` keeps its current meaning everywhere else in the app: save the active file.
Its behaviour changes **only while a results tab is the active tab**, where there is
no single "active file" to save — there it writes every file modified from that
results tab.

Since first-edit already put those files in `openFiles`, this is a loop over the
dirty ones through the existing `saveFile`, not a new write path. A file that was
already dirty for unrelated reasons before the search tab touched it is NOT swept in:
the results tab tracks the set of paths it actually edited, and saves only those.

The results tab shows a count of modified files so the state is never invisible.

## Opening a result at a position

With hot blocks, clicking already places a caret in the excerpt, so opening the real
file is a deliberate action, matching Zed's `editor::OpenExcerpts`:

- **mod+click** on a result, or **Enter** on the focused excerpt, opens the file at
  the caret's line and column.
- Column is `lineStart + offset + 1` — the excerpt's window origin plus the offset
  within the rendered text — so a preview-trimmed long line still lands correctly.
- On a cold block there is no caret; the click point maps to a text offset via
  `caretRangeFromPoint` (WebKit, which Tauri uses on macOS) with
  `caretPositionFromPoint` as the standards fallback, summing the text lengths of
  preceding nodes. If both are unavailable the fallback is the match start, never a
  failure.

Plain single click keeps selecting the excerpt and syncing the outline.

## Unity noise filtering

Search currently sends `fileExtensions: null`, deliberately: an earlier
`isUnity ? ['cs'] : null` made shaders, `.asmdef`, `.uxml` and YAML assets
unsearchable, and because the backend **ANDs** `fileExtensions` with the include
glob, no include pattern could widen it back.

The filter is therefore a **blocklist appended to `excludePatterns`**, which the
backend already treats as "exclude if any match" and which composes with whatever
the user types. `fileExtensions` stays `null`.

Applied only when the project is Unity. The list is small, because the search root
for a Unity project is already `assetsRootPath` — `Library/`, `Temp/`, `obj/`,
`.csproj` and `.sln` sit outside it and were never searched:

- `**/*.meta`
- `.unity`, `.prefab`, `.asset`, `.mat`, `.anim`, `.controller`,
  `.overrideController`, `.playable`, `.mixer`, `.preset`, `.terrainlayer`,
  `.spriteatlas`, `.guiskin`, `.fontsettings`, `.physicMaterial`,
  `.physicsMaterial2D`

Everything else stays searchable — `.cs`, `.shader`, `.hlsl`, `.cginc`, `.compute`,
`.asmdef`, `.asmref`, `.uxml`, `.uss`, `.json`, `.inputactions`, `.md`, and any type
not on the list. That is the blocklist's advantage over the allowlist that regressed
before.

A toggle beside the ignored-files control turns it off (off = code only, on =
scenes, prefabs and `.meta` included). It is a per-tab session option and feeds
`searchSignature`, so flipping it re-runs the search.

The list itself is a pure `unityNoiseExcludes()` in the search feature, unit-tested.

## Risks

| Risk | Mitigation |
|---|---|
| Orphan model written to disk by a later LSP rename | Explicit ownership table above; search-owned models disposed on eviction, new search, and tab close |
| `setHiddenAreas` missing or changed | Single adapter with runtime probe; cold fallback |
| Hydration jumps the scroll | Height parity asserted between cold and hot renders |
| 400-file result set holds 400 models | LRU cap of 8 hot blocks; cold blocks hold no model |
| Editing a file that is also open in a tab | Same model is reused, so both views stay in sync by construction |

## Suggested build order

Editable excerpts is the large item; the other three are independent of it and of
each other. Ordering them ahead means the results tab improves before the risky work
lands, and none of them churn the files hydration will rewrite:

1. Unity noise filtering + its toggle (touches the store and query bar only).
2. Expansion affordance moved to the divider (removes code hydration would replace).
3. Open-at-position on cold blocks (mod+click / Enter, caret mapping).
4. Hydration: the `setHiddenAreas` adapter, ownership, LRU, height parity.
5. First-edit-opens-a-tab, save-all, and the modified-files count.

Steps 4 and 5 are where the risk is, and each earlier step is independently
shippable and verifiable.

## Verification

Pure services carry the logic and the tests: `unityNoiseExcludes`, the caret-offset
summation, the LRU policy, and the cold/hot height calculation. Store-level
behaviour — first-edit opening a background tab, ownership transfer, save-all —
belongs in the isolated `.exec.ts` harness that runs the real store in its own
process via `bun run test:isolated`.

Rust is unchanged by this phase.

`bun run verify` gates every step. A `SKIPPED` from `verify:intellisense` is
reported as a skip, never a pass.

Manual verification is performed by the project owner, not by implementing agents.
