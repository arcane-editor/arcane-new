# File Drops, Material Icon Fidelity & the Settings/Account Modal

**Date:** 2026-08-08

## Context

Five requests, reported together against the running IDE:

1. Dropping a file onto the file explorer should copy it into the project.
2. Dropping a file onto the chat should attach it as context.
3. File context in the chat should be shown better, with real file icons.
4. File icons don't follow Material Icon Theme — `.service.ts` gets the plain
   TypeScript icon, where VS Code shows a distinct one.
5. Settings and Account occupy the editor surface like files do. They should be
   a Zed-style modal: one dialog, nav rail on the left, content on the right.

Items 3 and 4 are the same defect seen from two places, so the icon work lands
first and the chat chip consumes it.

### Root cause: icons (items 3, 4)

`resolveFileIcon` (`src/utils/file-icons.tsx:121`) resolves in three steps:
exact filename match, then the **last** dot-segment as the extension, then a
single hardcoded `d.ts` special case. `auth.service.ts` therefore resolves on
`ts` and renders `typescript.svg`.

Material Icon Theme matches the **longest compound suffix first**. Verified
against `material-icon-theme@5.37.0`'s generated manifest:

| suffix | icon |
| --- | --- |
| `service.ts` | `angular-service` |
| `module.ts` | `angular` |
| `guard.ts` | `angular-guard` |
| `spec.ts`, `test.ts` | `test-ts` |
| `spec.tsx`, `test.tsx` | `test-jsx` |
| `stories.tsx` | `storybook` |
| `d.ts` | `typescript-def` |

The second cause is coverage. `public/icons/files/` holds **42** icons against
Material's 1250; the hand-written maps carry 84 extensions and 33 filenames
against Material's 1378 and 2131. Even with correct resolution, most lookups
would still miss.

Separately, `AttachmentChip.tsx:42` never consults the icon system at all — it
renders a generic lucide `FileText` for every file, and shows only the
basename, so two `index.ts` attachments are indistinguishable without hovering.

### Root cause: drops (items 1, 2)

The explorer sets `disableDrag`/`disableDrop` to `true`
(`ExplorerPanel.tsx:471`), so react-arborist accepts nothing.

The deeper constraint is that **Tauri intercepts OS file drops at the native
layer** (`dragDropEnabled` defaults to true), so HTML5 `dragover`/`drop` never
fire in the webview for OS files. No element can own a drop zone. The single
window-level `onDragDropEvent` handler at `App.tsx:366` is the only place a
drop is observable, and it receives a bare window coordinate rather than a
target element. The terminal already solves this by hand-hit-testing in
`src/features/terminal/drop-target.ts`; that file is the template here.

In-webview drags are unaffected by this. `TabBar.tsx:73` already uses HTML5
DnD for tab reordering, which is the proof that explorer→chat and tab→chat
drags need none of the native machinery.

### Root cause: settings surface (item 5)

Settings is not a tab. `App.tsx:1168` branches the **entire editor area** on
`settingsOpen`, replacing `TabBar`, breadcrumbs and the editor. Account *is* a
real tab, opened as the virtual path `auth://account` and rendered by
`AuthTab`. So the two surfaces the report groups together are in fact built
two different ways, and neither is a modal.

## Approach

Four independent workstreams, ordered so the icon foundation lands before its
two consumers. Nothing here changes agent behaviour, the LSP, or Unity bridge
protocol.

Explicitly out of scope: internal explorer drag-to-move or drag-to-reorganise;
dragging out of the explorer to Finder; dropping OS files onto the chat (the
existing open-as-tab fallback keeps handling those); custom icon themes or an
icon-theme picker.

---

## 1. Material icon foundation

### Vendoring

Add `material-icon-theme@5.37.0` (MIT) as a **devDependency**, plus
`scripts/sync-material-icons.mjs`, run manually via `bun run sync:icons`:

- copies the package's 1250 SVGs into `public/icons/material/` (5.0 MB flat)
- reads `dist/material-icons.json` and emits
  `src/utils/material-icon-map.generated.ts`
- deletes the superseded `public/icons/files/` and `public/icons/folders/`

Generated output is committed, so `bun run build` and `tauri build` gain no new
dependency; the script exists to re-pull upstream releases.

The emitted module exports, all derived from the manifest:

| export | source | entries |
| --- | --- | --- |
| `FILE_NAMES` | `fileNames` | 2131 |
| `FILE_EXTENSIONS` | `fileExtensions` | 1378 |
| `FOLDER_NAMES` | `folderNames` | 4654 |
| `FOLDER_NAMES_EXPANDED` | `folderNamesExpanded` | 4654 |
| `LIGHT_FILE_NAMES` | `light.fileNames` | 179 |
| `LIGHT_FILE_EXTENSIONS` | `light.fileExtensions` | 31 |
| `LIGHT_FOLDER_NAMES` | `light.folderNames` | 25 |
| `ICON_PATHS` | `iconDefinitions` | 1250 |
| `DEFAULT_FILE`, `DEFAULT_FOLDER`, `DEFAULT_FOLDER_OPEN` | `file`, `folder`, `folderExpanded` | — |

`ICON_PATHS` maps an icon id to its bare SVG filename, because Material
indirects some ids through generated `.clone.svg` files — `angular-service`
resolves to `angular-service.clone.svg`. All 1250 definitions were verified to
resolve to files that exist in the package.

The script fails loudly if any `iconDefinitions` entry points at a missing
file, so an upstream restructure breaks the sync rather than silently shipping
broken `<img>` tags.

### Resolution

`src/utils/file-icons.tsx` is rewritten to VS Code's order.

Files, on the lowercased basename:

1. exact `FILE_NAMES` hit wins
2. otherwise split on `.` and test compound suffixes **longest first** —
   `auth.service.ts` tries `service.ts` before `ts` — first `FILE_EXTENSIONS`
   hit wins
3. otherwise `DEFAULT_FILE`

Folders, on the lowercased name: `FOLDER_NAMES` / `FOLDER_NAMES_EXPANDED` by
open state, falling back to `DEFAULT_FOLDER` / `DEFAULT_FOLDER_OPEN`.

### Light themes

The app ships `arcane-light` and `light-plus` (`ThemeDefinition.type` is
`'dark' | 'light'`), and Material ships 52 `_light` variants for icons that
disappear on light backgrounds. When the active theme is light, each lookup
step consults the `LIGHT_*` map before its base map.

That makes icon choice depend on theme state, which today's pure
`getFileIcon(name, size)` cannot read. Resolution: introduce a `FileIcon`
component that subscribes to the theme store, and keep `getFileIcon` /
`getFolderIcon` as thin wrappers returning `<FileIcon />` / `<FolderIcon />`.
The wrappers call no hooks themselves — the hook runs inside the component
during render — so **all nine existing call sites are unchanged**:

`ExplorerPanel` (2), `TabBar`, `SearchPanel`, `PaletteModal`,
`SourceControlPanel` (3), `UnityAssetPickerModal`.

### Verification

Unit tests over `resolveFileIcon` / `resolveFolderIcon` covering: the reported
`.service.ts` case; `spec.ts`/`test.tsx`/`stories.tsx`/`d.ts`; longest-suffix
precedence (a file matching both a compound and a bare extension takes the
compound); exact-filename beating extension (`tsconfig.json` is not `json`);
dotfiles (`.gitignore`); no-extension files (`Makefile`, `LICENSE`); unknown
extensions falling back to the default; folder open/closed pairs; and the
light-theme override path. Plus an assertion that every icon id the maps can
produce exists in `ICON_PATHS`.

## 2. Chat context chips

`AttachmentChip.tsx` renders `getFileIcon(basename, 14)` for the `file` and
`unity-asset` kinds, replacing the lucide `FileText` and `Box`. Non-file kinds
(`unity-doc`, `unity-context`, `unity-object`, image thumbnails) keep their
current lucide icons — there is no filesystem name to resolve.

Layout, per the approved mockup: `[icon] filename.ts  parent/dir  ×` on one
row. The filename keeps full `--text-primary` and never truncates; the parent
directory is dimmed, smaller, and truncates **from the left**, so the deepest
and most disambiguating segment survives. Left-truncation is `direction: rtl`
plus `text-align: left` with `unicode-bidi: plaintext` — without the bidi
guard, RTL context reorders the `/` separators and renders the path segments
out of order. The full workspace-relative path stays in the `title` tooltip.

The parent directory is derived from the attachment's existing `relPath`; when
a file sits at the workspace root, the dir span is omitted rather than left
blank. Chips inside a sent message keep their current no-`×` treatment.

The same icon + dimmed-dir pairing is applied to the `@`-mention result rows in
`MentionPopover.tsx`, so picking a file and seeing it staged look alike.

## 3. Explorer drop-to-copy

### Rust

New `copy_path(src: String, dest_dir: String) -> Result<String, String>`
command in `src-tauri/src/lib.rs`, registered in `generate_handler!`, returning
the final path written:

- files copy with `fs::copy`; directories copy recursively, reusing the
  existing `copy_dir_recursive` (`src-tauri/src/unity.rs:418`), lifted into a
  shared helper rather than duplicated
- **rejects copying a directory into itself or any descendant**, which would
  otherwise recurse until the disk fills
- **auto-renames on collision**, Finder-style: `Player.cs` → `Player 2.cs` →
  `Player 3.cs`, preserving the compound suffix so `a.service.ts` becomes
  `a.service 2.ts`, not `a 2.service.ts`. The probe loop is bounded and returns
  an error rather than looping unbounded.

### Frontend

New `src/features/explorer/services/drop-target.ts`, mirroring the terminal's
contract and exported through the explorer barrel:

- `explorerDirAtPoint(cssX, cssY)` — hit-tests `.tree-node` rows, skipping
  zero-area rows exactly as `terminalAtPoint` does. A directory row targets
  itself; a file row targets its parent directory; empty space inside the tree
  targets the tree root. Requires `data-path` and `data-is-dir` attributes on
  the row element in `NodeRenderer`.
- `highlightExplorerDropTarget(position)` / `clearExplorerDropTarget()` — adds
  a `--drop-over` class to the resolved row, or a panel-level class when the
  target is the tree root. Both convert the payload's `PhysicalPosition` to CSS
  pixels via the same `devicePixelRatio` division the terminal uses; skipping
  it misplaces every drop on a Retina display.
- `handleExplorerDrop(position, paths): Promise<boolean>` — returns `false`
  when the point is not over the explorer, so the caller falls through.

`App.tsx`'s handler becomes: terminal → explorer → open-as-tabs. Enter/over and
leave events highlight and clear both targets.

After a successful copy the target directory is reloaded via `loadChildren` and
the new entry is revealed through the existing reveal path.

### Unity `.meta` handling

A `.meta` carries a GUID unique to its origin project. Copying one in from a
*different* project duplicates that GUID, and Unity resolves the collision by
reassigning one at random — silently breaking scene and prefab references.
Copying from another checkout of the *same* project is precisely when the
`.meta` must come along, so references keep resolving. The correct answer
depends on knowledge only the user has.

So: when the project is Unity and any dropped path has a sibling `<path>.meta`
on disk (probed with the existing `path_exists` command), show **one dialog per
drop**, not per file, offering *Copy .meta files* / *Skip .meta files* with
that explanation. Skip is the default action. A dropped path that is itself a
`.meta` is copied without prompting — dragging it is explicit.

Non-Unity projects never see the dialog.

Known cost: this puts a dialog in front of a gesture meant to be instant.
Deliberately accepted for now; remembering the answer per session is a
follow-up, not part of this work.

### Verification

Rust unit tests for `copy_path`: collision auto-rename sequencing; compound-
suffix rename placement; directory-into-descendant rejection; recursive
directory copy. Frontend unit tests for the pure parts of `drop-target.ts` —
physical→CSS conversion and file-row→parent-dir resolution. Hit-testing against
live DOM and the dialog itself are manual checks.

## 4. Drag into the chat

Both sources are in-webview, so none of the native drag machinery applies.

A shared MIME, `application/x-arcane-file`, carries
`JSON.stringify({ path, isDir })`.

- **Explorer rows** get `draggable` and an `onDragStart` setting that payload.
  react-arborist's `disableDrag`/`disableDrop` stay `true`: internal
  reorganisation is out of scope, and leaving them off prevents accidental
  moves.
- **Tabs** add the same MIME *alongside* their existing reorder MIME in the
  `onDragStart` at `TabBar.tsx:73`. Reordering is untouched, and the TabBar's
  existing `dataTransfer.types.includes(DRAG_MIME)` guard already rejects
  explorer drags, so dragging a tree node over the tab strip does nothing.
- **The AI panel** gains a drop zone: `onDragOver` accepts only that MIME and
  calls `preventDefault`, showing a "Drop to add as context" overlay; `onDrop`
  parses the payload and stages the attachment.

A new `stageFileAttachment(path)` helper in the ai-panel services builds the
`kind: 'file'` attachment — resolving `relPath` against `workspacePath` and
filling `bytes` — and is shared with the existing mention path so both produce
identical attachments. Dropping a directory is refused with a visible message
rather than silently expanded or silently ignored. Dropping a file that is
already staged is a no-op rather than a duplicate chip.

### Verification

Unit tests for `stageFileAttachment`: relPath derivation, the already-staged
no-op, and directory refusal. The drag gestures themselves are manual checks.

## 5. Settings + Account modal

### Structure

`SettingsPanel.tsx` is 212 lines carrying a 50-entry definition table inline.
It splits along its existing seams:

| file | contents |
| --- | --- |
| `features/settings/data/definitions.ts` | `SETTING_DEFINITIONS` — data, not UI |
| `features/settings/components/SettingsModal.tsx` | overlay, dialog shell, nav rail, search |
| `features/settings/components/SettingsSection.tsx` | one category's rows; absorbs `SettingRow` |
| `features/settings/components/AccountSection.tsx` | account pane, wrapping today's `AuthTab` body |

Only `SettingsModal` is exported from the feature barrel.

### Behaviour

A centred dialog over a dimmed backdrop, following `PaletteModal`'s existing
conventions: Escape closes, click-outside closes, focus is trapped, and the
dialog carries `role="dialog"` with `aria-modal`.

The left rail (~220px) holds the search box, then **Account** showing the
signed-in email, a divider, then the categories derived from
`SETTING_DEFINITIONS` — Editor, Terminal, AI, Unity. The right pane scrolls
independently of the rail. Typing in search filters across every category and
switches the right pane to a flat result list; clearing it restores the
selected section.

The modal mounts at the App root, so the editor, tab bar and breadcrumbs stay
visible behind it instead of being replaced.

### Store and wiring

`stores/ui.ts` replaces the bare `settingsOpen: boolean` with `settingsOpen`
plus `settingsSection: string`, and `openSettings(section?)` / `closeSettings()`
actions. Reopening returns to the last section viewed.

| caller | before | after |
| --- | --- | --- |
| `mod+,` (`App.tsx:625`) | toggles `settingsOpen` | `openSettings()` |
| palette `auth.account` (`App.tsx:1071`) | `openFile('auth://account')` | `openSettings('account')` |
| `AiSignInGate.tsx:12` | `openFile('auth://account')` | `openSettings('account')` |

The `settingsOpen` branch at `App.tsx:1168` and the
`activeFilePath?.startsWith('auth://')` branch below it are both removed, along
with `auth://` handling in `workspace.openFile` (`stores/workspace.ts:1149`).

The defensive `auth://` string guards scattered across `persistence.ts`,
`document-sync.ts`, `model-context.ts`, `git.ts`, `dirty-guard.ts` and others
**stay**. They are cheap, and they protect sessions persisted by an earlier
version. Restoring such a session is already safe: `persistence.ts:429`
excludes `auth://` paths from restore.

`AuthTab.tsx` is deleted once `AccountSection` carries its content; the auth
services under `features/auth/services/` are untouched.

### Verification

Unit tests over the search filter and the category derivation. Modal focus
behaviour, Escape/click-outside, and each rewired entry point are manual
checks.

## Sequencing

1. **Icons** — vendor, generate, rewrite resolution. Independent.
2. **Chat chips** — depends on 1.
3. **Explorer drop-copy** — independent of 1 and 2.
4. **Chat drag-in** — independent, but shares `stageFileAttachment` with the
   mention path, so it lands after 2 to avoid touching the same files twice.
5. **Settings modal** — fully independent.

## Risks

- **Bundle size.** The icon set adds 5.0 MB to a `dist` that is already 22 MB.
  Accepted: this is a desktop app that already ships Monaco, xterm and LSP
  sidecar binaries.
- **Generated map size.** Roughly 450 KB of TypeScript parsed at startup.
  Acceptable, but if startup regresses measurably the map moves to a JSON
  import so it is `JSON.parse`d rather than evaluated.
- **Drop hit-testing is coordinate-based**, not target-based, and so is
  sensitive to layout changes and to the `devicePixelRatio` conversion. This is
  inherent to Tauri's native drop interception; the terminal has carried the
  same constraint without incident.
- **Deleting the old icon directories** breaks any path still referencing
  `/icons/files/*` or `/icons/folders/*`. All nine call sites go through
  `file-icons.tsx`, so a repo-wide grep for those prefixes gates the deletion.
