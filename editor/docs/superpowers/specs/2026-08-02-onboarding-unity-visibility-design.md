# Onboarding & Unity-Integration Visibility

**Date:** 2026-08-02

## Context

A Unity developer tested Arcane against a real project and reported (see `ArcaneIDE Feedback.pdf`, items 3 and 4):

> "I successfully imported the Unity package into my project, but initially I couldn't identify any Unity-specific functionality. At first, the IDE simply displayed my project folders and scripts, so it wasn't immediately obvious whether the Unity extension was working correctly or whether I had missed an additional setup step."

They also had to be told that `Ctrl+J` reveals the terminal.

### Root cause

This is not primarily a documentation gap. The tester opened
`D:\Unity\UnityProject\Private Investigator\Assets\Scripts` — a **subfolder** of
the Unity project, not its root.

`detect_unity_project` (`src-tauri/src/unity.rs`) answers only two questions:

1. Is the opened folder itself a Unity root? (`is_unity_root`)
2. Does it *contain* a Unity project below it? (`find_nested_unity_project`)

It never walks **upward**. So `is_unity` was `false`, and because essentially
every Unity surface is gated on `isUnityProject`, all of them silently switched
off:

- `ActivityBar` omits its Unity Hierarchy / Unity Tests / Run-and-Debug icons
- `StatusBar`'s bridge-status cluster is gated on `isUnityProject && unityVersion`
- Unity console, play controls, inspector, and the bridge itself stay dormant

The user saw a generic text editor and had no way to find out why. They likely
landed in that subfolder *because* opening the real project root failed with
`os error 123` — the Windows verbatim-path bug fixed separately on this branch.

### Secondary findings

`nestedProjectPath` is computed in Rust, threaded through
`stores/project-context.ts`, and **rendered nowhere**. A comment in
`stores/workspace.ts` refers to "the nested-project prompt" as an existing
caller; no such prompt exists. Case 2 above is therefore already detected and
already silently discarded.

`BridgeInstallBanner` — the surface that tells a user to install the Unity
bridge — is rendered only inside `UnityConsolePanel`. That panel is itself
Unity-gated, so the instructions for connecting Unity are reachable only once
Unity is already detected. Section 3 mitigates this by making the StatusBar
cluster show `not-installed` instead of hiding; fully relocating the banner is
out of scope here.

## Approach

Make the IDE explain itself in context, rather than adding a first-run tour.
A modal tour is dismissed once and forgotten, and would not have helped here:
the tester's problem was a real misconfiguration the product knew about and
declined to mention.

Explicitly out of scope: no modal tour, no first-run checklist, no new sidebar
view (the ActivityBar already grows the Unity icons once `isUnity` is true), no
telemetry.

---

## 1. Upward Unity detection (Rust)

### Current state

```rust
pub fn detect_unity_project(workspace_path: String) -> Result<UnityProjectInfo, String> {
    if is_unity_root(root) { /* is_unity: true */ }
    let nested = find_nested_unity_project(root);   // downward only
    Ok(UnityProjectInfo { is_unity: false, unity_version: None, nested_project_path: nested })
}
```

### Design

Add a third outcome: the nearest **ancestor** that satisfies the existing
`is_unity_root`.

- New field `ancestor_project_path: Option<String>` on `UnityProjectInfo`.
- Walk `root.ancestors()`, skipping `root` itself, returning the first hit.
- Bounded: stop at the filesystem root, and cap the walk at 12 levels so a
  pathological path can't turn project-open into a long syscall loop.
- Only computed when `is_unity` is false — a Unity root needs no ancestor.
- Returned through `path_util::to_ui_path`, like every other path crossing the
  boundary.

`is_unity` semantics are **unchanged**, so every existing gate keeps working and
this stays purely additive.

### Tests (`src-tauri`, `tempfile`, matching existing Unity tests)

| Case | Expectation |
|---|---|
| Opened folder is a Unity root | `is_unity: true`, `ancestor_project_path: None` |
| `<root>/Assets/Scripts` | `is_unity: false`, ancestor = `<root>` |
| Deeply nested (`Assets/A/B/C`) | ancestor = `<root>` |
| Plain directory, no Unity anywhere | both `None` |
| Nearest ancestor wins when two are stacked | closer root returned |
| Depth cap exceeded | `None`, no hang |

---

## 2. Project-rooting banner

### Design

One component, `features/project/components/ProjectRootBanner.tsx`, mounted in
`App.tsx` inside `.editor-section`, directly above `<TabBar />` (so it sits
above the editor regardless of which file or panel is active, and is not
swallowed by the `settingsOpen` / `auth://` branches below it). It covers both
directions, so the dead `nestedProjectPath` field becomes live rather than
gaining a second mechanism:

| Condition | Message |
|---|---|
| `ancestorProjectPath` set | "*Scripts* is inside the Unity project *Private Investigator*. Unity features (console, play controls, bridge) need the project root." |
| `nestedProjectPath` set | "This folder contains the Unity project *Private Investigator*. Open it directly for Unity features." |

Precedence: if both are somehow set, the **ancestor** case wins — the user is
inside a project, which is the more specific and more likely situation.

Actions: **Open project root** and **Stay here** (plus a dismiss `✕`).

**Open project root** calls `openProjectInNewWindow(path)` — the same call
`file.openFolder` already uses. This matters: the window label is hashed from
the workspace path and keys the Unity IPC socket (`unity_ipc::hash_workspace`),
so re-rooting must go through window creation rather than an in-window
`setWorkspace`.

### State

- `stores/project-context.ts` gains `ancestorProjectPath`, set from the new
  Rust field alongside the existing `nestedProjectPath`, and cleared in the
  same `reset` path.
- Dismissal persists **per folder** via the settings store, so declining once
  is permanent for that folder and the banner never nags. The key is
  `project.rootBanner.dismissed`, holding an array of dismissed workspace paths.

  This key must be added to **both** `SettingsSchema` (`src/types/index.ts`)
  and `DEFAULT_SETTINGS` (`stores/settings.ts`). The loader drops unknown keys
  (`if (key in DEFAULT_SETTINGS) merged[key] = value`), so a key registered in
  only one place would round-trip as silently discarded and the banner would
  reappear on every launch. Settings are global, not per-workspace, which is
  why the value is a list of paths rather than a boolean.

### Error handling

`openProjectInNewWindow` already throws `ProjectMissingError` when the target
is gone (its `dir_exists` guard). The banner surfaces that through the existing
`notify.error` toast and clears itself, since a stale ancestor path means the
detection is no longer true.

### Tests

Banner *selection* is a pure function — `bannerFor(state) -> {kind, path} | null`
— covering: ancestor only, nested only, both (ancestor wins), neither,
`isUnityProject` true (never shows), and dismissed-for-this-folder.

---

## 3. Legible Unity status

`StatusBar` currently gates the whole Unity cluster on:

```ts
{isUnityProject && unityVersion && ( /* bridge status */ )}
```

Drop `&& unityVersion`. A Unity project whose `ProjectSettings` version can't be
read still shows its bridge state instead of disappearing entirely; the version
label simply renders as "Unity" with no number. All four `BridgeState` values
(`not-installed`, `disconnected`, `connected`, `reloading`) and their tooltips
already exist — this only stops hiding them.

---

## 4. Signpost empty state

`WelcomeScreen`'s `hasWorkspace` branch currently renders "Select a file from
the explorer to get started" — a near-empty screen occupying prime real estate
that a new user lands on directly after opening a project.

It becomes `WorkspaceSignpost`:

```
                      Private Investigator
              ⚡ Unity 2021.3 · bridge connected

     Ctrl+P   Go to file          Ctrl+`    Terminal
     Ctrl+⇧+A Ask the AI          Ctrl+⇧+P  Commands

     Unity console, hierarchy and tests are in the
     left activity bar.
```

- The Unity line mirrors the StatusBar cluster's state, including
  "bridge not installed", and is omitted entirely for non-Unity projects.
- The activity-bar hint renders only when `isUnityProject` is true (otherwise
  those icons aren't there and the sentence would be a lie).

### Shortcut accuracy

The shortcuts are **read from the command registry**
(`useCommandsStore.getKeybindings()`) by command id, never hardcoded — so they
cannot drift from the real bindings. Ids used: `palette.quickOpen`,
`terminal.toggle`, `view.aiPanel`, `palette.commands`.

This detail is load-bearing. The tester was told "Ctrl+J opens the terminal",
but `mod+j` is `view.toggleBottomPanel` — the terminal merely lives in that
panel. The direct binding is `terminal.toggle` = ``mod+` ``, and the AI panel is
`view.aiPanel` = `mod+shift+a`, not `mod+k` (`view.toggleRightSidebar`). Even
the team was handing out the indirect route; hardcoding would have shipped that
same confusion.

### Refactor

`formatKeybinding` is currently module-private in
`features/command-palette/components/PaletteModal.tsx`. It moves to
`utils/format-keybinding.ts` and both call sites use it, so the palette and the
signpost render identical, platform-correct chords (`⌘` vs `Ctrl`). This is the
only refactor in the change.

### Tests

Shortcut resolution as a pure function: returns the formatted chord for a known
command id, and omits the row when a command has no binding (rather than
rendering an empty key). Plus the existing `formatKeybinding` behaviour, which
gains direct coverage for the first time by moving out of the component.

---

## Testing strategy

The repo has no DOM testing library (`bun test src`, pure-logic style). The
components therefore stay thin, with every decision pushed into a pure function
that is tested directly:

- `bannerFor()` — which banner, if any
- `signpostShortcuts()` — id → formatted chord, omitting unbound commands
- `formatKeybinding()` — platform-correct chord rendering
- Rust: the ancestor walk, per the table in section 1

## Verification gap

Everything here is driven by a Windows report and reasoned from a screen
recording plus the code. None of it can be exercised on macOS end-to-end. The
subfolder case in particular should be re-tested on Windows with a real Unity
project before this is called done.
