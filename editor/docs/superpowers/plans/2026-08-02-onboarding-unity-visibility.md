# Onboarding & Unity-Integration Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Arcane explain its own Unity integration in context, so a developer who opens a subfolder of a Unity project is told why Unity features are off and can fix it in one click.

**Architecture:** `detect_unity_project` (Rust) gains a bounded upward walk that reports the nearest enclosing Unity root. The frontend renders a dismissible banner offering to reopen at that root, stops hiding the bridge-status cluster when the Unity version is unreadable, and replaces the near-empty "no file open" screen with a signpost whose shortcuts are read from the command registry.

**Tech Stack:** Rust (Tauri v2, serde), React 19 + TypeScript, Zustand, `bun:test` (pure-logic tests only — this repo has no DOM testing library).

**Spec:** `editor/docs/superpowers/specs/2026-08-02-onboarding-unity-visibility-design.md`

## Global Constraints

- All commands run from `editor/` unless stated otherwise. Rust commands run from `editor/src-tauri/`.
- Verification gates, all must stay green: `npx tsc --noEmit`, `bun run check:modules`, `bun test src`, and `cargo test --lib`.
- **Deep modules rule** (`editor/CLAUDE.md`): a feature may only be imported through its `index.ts` barrel. `bun run check:modules` enforces this.
- Any path crossing Rust → frontend goes through `path_util::to_ui_path`. Never emit `entry.path().to_string_lossy()` directly to the frontend.
- Frontend tests are pure-logic (`bun:test`). Components stay thin; every decision lives in a tested pure function.
- Settings keys must be added to **both** `SettingsSchema` (`src/types/index.ts`) and `DEFAULT_SETTINGS` (`src/stores/settings.ts`). The loader drops unknown keys (`if (key in DEFAULT_SETTINGS)`), so a key in only one place is silently discarded on reload.
- `cargo test --lib` occasionally fails on `auth_loopback::tests::stop_before_any_callback_closes_the_listener` — a known pre-existing ephemeral-port race, unrelated to this work. Re-run to confirm before investigating.

---

### Task 1: Upward Unity detection (Rust)

**Files:**
- Modify: `editor/src-tauri/src/unity.rs:11-16` (struct), `:115-135` (detect), `:55-77` (nested path normalization)
- Test: `editor/src-tauri/src/unity.rs` (existing `mod tests`, ~line 810)

**Interfaces:**
- Consumes: `path_util::to_ui_path` (already exists on this branch).
- Produces: `UnityProjectInfo.ancestor_project_path: Option<String>` — serialized to JSON as `ancestor_project_path`. Task 2 consumes it.

- [ ] **Step 1: Write the failing tests**

Add to `mod tests` in `unity.rs`, after `root_not_unity_child_is`. These reuse the existing `make_temp_dir` / `make_unity_project` helpers already in that module.

```rust
    // ─── ancestor detection ────────────────────────────────────────────────────

    #[test]
    fn subfolder_reports_enclosing_project_as_ancestor() {
        let dir = make_temp_dir("_ancestor_sub");
        make_unity_project(&dir, "2021.3.45f2");
        let scripts = dir.join("Assets").join("Scripts");
        fs::create_dir_all(&scripts).unwrap();

        let result = detect_unity_project(scripts.to_string_lossy().to_string()).unwrap();
        assert!(!result.is_unity, "a Scripts folder is not itself a Unity root");
        assert_eq!(
            result.ancestor_project_path,
            Some(crate::path_util::to_ui_path(&dir)),
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn deeply_nested_subfolder_still_finds_the_project() {
        let dir = make_temp_dir("_ancestor_deep");
        make_unity_project(&dir, "2021.3.45f2");
        let deep = dir.join("Assets").join("A").join("B").join("C");
        fs::create_dir_all(&deep).unwrap();

        let result = detect_unity_project(deep.to_string_lossy().to_string()).unwrap();
        assert_eq!(
            result.ancestor_project_path,
            Some(crate::path_util::to_ui_path(&dir)),
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unity_root_itself_reports_no_ancestor() {
        let dir = make_temp_dir("_ancestor_root");
        make_unity_project(&dir, "2022.3.10f1");

        let result = detect_unity_project(dir.to_string_lossy().to_string()).unwrap();
        assert!(result.is_unity);
        assert!(
            result.ancestor_project_path.is_none(),
            "a Unity root needs no ancestor",
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn plain_directory_reports_no_ancestor() {
        let dir = make_temp_dir("_ancestor_none");
        let plain = dir.join("just").join("files");
        fs::create_dir_all(&plain).unwrap();

        let result = detect_unity_project(plain.to_string_lossy().to_string()).unwrap();
        assert!(!result.is_unity);
        assert!(result.ancestor_project_path.is_none());
        assert!(result.nested_project_path.is_none());

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn ancestor_search_stops_at_the_depth_cap() {
        let dir = make_temp_dir("_ancestor_capped");
        make_unity_project(&dir, "2021.3.45f2");

        // MAX_ANCESTOR_DEPTH is 12, and the walk starts at the parent, so a
        // project 13 levels up must NOT be found.
        let mut deep = dir.clone();
        for i in 0..13 {
            deep = deep.join(format!("l{i}"));
        }
        fs::create_dir_all(&deep).unwrap();

        let result = detect_unity_project(deep.to_string_lossy().to_string()).unwrap();
        assert!(
            result.ancestor_project_path.is_none(),
            "walk must stop at the cap rather than climbing to the filesystem root",
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn nearest_ancestor_wins_when_projects_are_stacked() {
        let outer = make_temp_dir("_ancestor_stacked");
        make_unity_project(&outer, "2021.3.45f2");
        let inner = outer.join("Assets").join("Inner");
        make_unity_project(&inner, "2022.3.10f1");
        let leaf = inner.join("Assets").join("Scripts");
        fs::create_dir_all(&leaf).unwrap();

        let result = detect_unity_project(leaf.to_string_lossy().to_string()).unwrap();
        assert_eq!(
            result.ancestor_project_path,
            Some(crate::path_util::to_ui_path(&inner)),
            "the closer project root must win",
        );

        fs::remove_dir_all(&outer).ok();
    }
```

Also update the existing `root_not_unity_child_is` assertion, since Step 3 normalizes `nested_project_path`:

```rust
        assert_eq!(nested, crate::path_util::to_ui_path(&child));
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd editor/src-tauri && cargo test --lib unity::tests`
Expected: FAIL — compile error, `no field 'ancestor_project_path' on type 'UnityProjectInfo'`.

- [ ] **Step 3: Implement**

In `unity.rs`, add the field to the struct (around line 11):

```rust
#[derive(Debug, Serialize)]
pub struct UnityProjectInfo {
    pub is_unity: bool,
    pub unity_version: Option<String>,
    pub nested_project_path: Option<String>,
    /// Nearest ancestor directory that is a Unity project root, when the
    /// opened folder sits *inside* a Unity project (e.g. `Assets/Scripts`).
    /// `None` when the opened folder is itself a Unity root.
    pub ancestor_project_path: Option<String>,
}
```

Add the walk next to `find_nested_unity_project` (after it ends, around line 105):

```rust
/// Cap on how far up the tree to look for an enclosing Unity project. A real
/// project sits 1–3 levels above a script folder; the cap keeps a pathological
/// path from turning project-open into a long syscall loop.
const MAX_ANCESTOR_DEPTH: usize = 12;

/// Nearest ancestor of `dir` that is a Unity project root.
///
/// Excludes `dir` itself — `detect_unity_project` checks that separately and
/// returns early, so this is only ever called for a non-root folder.
fn find_ancestor_unity_project(dir: &Path) -> Option<String> {
    dir.ancestors()
        .skip(1)
        .take(MAX_ANCESTOR_DEPTH)
        .find(|candidate| is_unity_root(candidate))
        .map(crate::path_util::to_ui_path)
}
```

Replace the body of `detect_unity_project` (lines 115–135):

```rust
pub fn detect_unity_project(workspace_path: String) -> Result<UnityProjectInfo, String> {
    let root = Path::new(&workspace_path);

    if is_unity_root(root) {
        let unity_version = read_unity_version(&root.join("ProjectSettings"));
        return Ok(UnityProjectInfo {
            is_unity: true,
            unity_version,
            nested_project_path: None,
            ancestor_project_path: None,
        });
    }

    // Root is not Unity — look both directions. Downward finds a project the
    // user opened the parent of; upward finds one they opened a subfolder of.
    let nested = find_nested_unity_project(root);
    let ancestor = find_ancestor_unity_project(root);

    Ok(UnityProjectInfo {
        is_unity: false,
        unity_version: None,
        nested_project_path: nested,
        ancestor_project_path: ancestor,
    })
}
```

Normalize the two `find_nested_unity_project` return sites so both banner paths render identically on Windows. Line ~77 and the depth-2 return near line ~100 currently read `return Some(dir.to_string_lossy().to_string());` — change **both** to:

```rust
            return Some(crate::path_util::to_ui_path(dir));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd editor/src-tauri && cargo test --lib unity::tests`
Expected: PASS, including the five new tests.

Then the full suite: `cargo test --lib`
Expected: PASS (see Global Constraints on the known `auth_loopback` flake).

- [ ] **Step 5: Commit**

```bash
git add editor/src-tauri/src/unity.rs
git commit -m "feat(unity): detect an enclosing Unity project from a subfolder

detect_unity_project only looked at the opened folder and below, so
opening Assets/Scripts left is_unity false and silently disabled every
Unity surface. Adds a bounded upward walk plus path normalization for
nested_project_path so both directions render the same on Windows."
```

---

### Task 2: Banner decision logic + store and settings wiring

**Files:**
- Create: `editor/src/features/project/services/root-banner.ts`
- Create: `editor/src/features/project/services/root-banner.test.ts`
- Modify: `editor/src/stores/project-context.ts:9-13` (type), `:40-46` (state iface), `:57-63` (initial), `:76-84` (applyDetection), `:142-150` (reset)
- Modify: `editor/src/types/index.ts:133+` (SettingsSchema), `editor/src/stores/settings.ts:5+` (DEFAULT_SETTINGS)

**Interfaces:**
- Consumes: `UnityProjectInfo.ancestor_project_path` from Task 1.
- Produces:
  - `type RootBanner = { kind: 'inside' | 'contains'; projectPath: string; projectName: string }`
  - `function rootBannerFor(input: RootBannerInput): RootBanner | null`
  - `interface RootBannerInput { isUnityProject: boolean; ancestorProjectPath: string | null; nestedProjectPath: string | null; workspacePath: string | null; dismissedPaths: string[] }`
  - Store field `ancestorProjectPath: string | null` on `useProjectContextStore`.
  - Settings key `'project.rootBanner.dismissed': string[]`.

- [ ] **Step 1: Write the failing test**

Create `editor/src/features/project/services/root-banner.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { rootBannerFor } from './root-banner';

const base = {
  isUnityProject: false,
  ancestorProjectPath: null,
  nestedProjectPath: null,
  workspacePath: '/ws/Assets/Scripts',
  dismissedPaths: [] as string[],
};

describe('rootBannerFor', () => {
  it('offers the enclosing project when the workspace is inside one', () => {
    expect(rootBannerFor({ ...base, ancestorProjectPath: '/ws' })).toEqual({
      kind: 'inside',
      projectPath: '/ws',
      projectName: 'ws',
    });
  });

  it('offers a contained project when the workspace holds one', () => {
    expect(
      rootBannerFor({
        ...base,
        workspacePath: '/code',
        nestedProjectPath: '/code/MyGame',
      }),
    ).toEqual({ kind: 'contains', projectPath: '/code/MyGame', projectName: 'MyGame' });
  });

  // The user is standing inside a project — the more specific situation, and
  // the one that explains why Unity features are off right now.
  it('prefers the enclosing project when both are present', () => {
    const banner = rootBannerFor({
      ...base,
      ancestorProjectPath: '/ws',
      nestedProjectPath: '/ws/Assets/Scripts/Sample',
    });
    expect(banner?.kind).toBe('inside');
    expect(banner?.projectPath).toBe('/ws');
  });

  it('shows nothing when the workspace is already a Unity root', () => {
    expect(
      rootBannerFor({ ...base, isUnityProject: true, ancestorProjectPath: '/ws' }),
    ).toBeNull();
  });

  it('shows nothing when no Unity project is nearby', () => {
    expect(rootBannerFor(base)).toBeNull();
  });

  it('stays dismissed for a folder the user already declined', () => {
    expect(
      rootBannerFor({
        ...base,
        ancestorProjectPath: '/ws',
        dismissedPaths: ['/ws/Assets/Scripts'],
      }),
    ).toBeNull();
  });

  it('dismissal is scoped to the folder, not global', () => {
    expect(
      rootBannerFor({
        ...base,
        ancestorProjectPath: '/ws',
        dismissedPaths: ['/some/other/folder'],
      }),
    ).not.toBeNull();
  });

  it('shows nothing before a workspace is open', () => {
    expect(
      rootBannerFor({ ...base, workspacePath: null, ancestorProjectPath: '/ws' }),
    ).toBeNull();
  });

  it('derives the project name from the last path segment', () => {
    const banner = rootBannerFor({
      ...base,
      ancestorProjectPath: 'D:/Unity/UnityProject/Private Investigator',
    });
    expect(banner?.projectName).toBe('Private Investigator');
  });

  it('tolerates a trailing slash on the project path', () => {
    expect(rootBannerFor({ ...base, ancestorProjectPath: '/ws/' })?.projectName).toBe('ws');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd editor && bun test ./src/features/project/services/root-banner.test.ts`
Expected: FAIL — `Cannot find module './root-banner'`.

- [ ] **Step 3: Implement**

Create `editor/src/features/project/services/root-banner.ts`:

```ts
/**
 * Decides whether to offer re-rooting the workspace at a nearby Unity project.
 *
 * Unity features are gated on `isUnityProject`, which is only true when the
 * opened folder is itself a Unity root. Opening `Assets/Scripts` therefore
 * turns every Unity surface off — the activity-bar icons, the bridge status,
 * the console — with nothing on screen explaining why. This is the decision
 * behind the banner that explains it.
 */
export interface RootBannerInput {
  isUnityProject: boolean;
  /** Nearest Unity root ABOVE the workspace (workspace is inside a project). */
  ancestorProjectPath: string | null;
  /** Nearest Unity root BELOW the workspace (workspace contains a project). */
  nestedProjectPath: string | null;
  workspacePath: string | null;
  /** Workspace paths for which the user already dismissed this banner. */
  dismissedPaths: string[];
}

export interface RootBanner {
  kind: 'inside' | 'contains';
  projectPath: string;
  projectName: string;
}

/** Last non-empty path segment. Paths are `/`-separated by the time they
 *  reach the frontend (see src-tauri/src/path_util.rs). */
function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p;
}

export function rootBannerFor(input: RootBannerInput): RootBanner | null {
  const { isUnityProject, ancestorProjectPath, nestedProjectPath, workspacePath, dismissedPaths } =
    input;

  // A Unity root already has every feature on — nothing to offer.
  if (isUnityProject) return null;
  if (!workspacePath) return null;
  if (dismissedPaths.includes(workspacePath)) return null;

  // Ancestor wins: being inside a project is the more specific situation, and
  // it is what explains why Unity features are off right now.
  const projectPath = ancestorProjectPath ?? nestedProjectPath;
  if (!projectPath) return null;

  return {
    kind: ancestorProjectPath ? 'inside' : 'contains',
    projectPath,
    projectName: basename(projectPath),
  };
}
```

In `editor/src/stores/project-context.ts`, extend the Rust payload type (line ~9):

```ts
interface UnityProjectInfo {
  is_unity: boolean;
  unity_version: string | null;
  nested_project_path: string | null;
  ancestor_project_path: string | null;
}
```

Add to `ProjectContextState` (after `nestedProjectPath: string | null;`):

```ts
  ancestorProjectPath: string | null;
```

Add to the initial state (after `nestedProjectPath: null,`):

```ts
  ancestorProjectPath: null,
```

In `applyDetection`, extend the `set` call:

```ts
    set({
      isUnityProject: info.is_unity,
      unityVersion: info.unity_version,
      nestedProjectPath: info.nested_project_path,
      ancestorProjectPath: info.ancestor_project_path,
    });
```

In `reset`, add to the `set` call:

```ts
      ancestorProjectPath: null,
```

In `editor/src/types/index.ts`, add to `SettingsSchema` (after `'explorer.autoReveal': boolean;`):

```ts
  /** Workspace paths for which the "open the Unity project root" banner was
   *  dismissed. Settings are global, so this is a list rather than a flag. */
  'project.rootBanner.dismissed': string[];
```

In `editor/src/stores/settings.ts`, add the matching default to `DEFAULT_SETTINGS`:

```ts
  'project.rootBanner.dismissed': [],
```

Export from the barrel `editor/src/features/project/index.ts`:

```ts
export { rootBannerFor } from './services/root-banner';
export type { RootBanner, RootBannerInput } from './services/root-banner';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd editor && bun test ./src/features/project/services/root-banner.test.ts && npx tsc --noEmit && bun run check:modules`
Expected: 10 tests PASS, tsc clean, module boundaries OK.

- [ ] **Step 5: Commit**

```bash
git add editor/src/features/project/services/root-banner.ts \
        editor/src/features/project/services/root-banner.test.ts \
        editor/src/features/project/index.ts \
        editor/src/stores/project-context.ts \
        editor/src/stores/settings.ts \
        editor/src/types/index.ts
git commit -m "feat(project): decide when to offer re-rooting at a Unity project

Adds rootBannerFor plus the ancestorProjectPath store field and the
per-folder dismissal setting. nestedProjectPath was already computed and
rendered nowhere; this gives both directions one decision point."
```

---

### Task 3: ProjectRootBanner component

**Files:**
- Create: `editor/src/features/project/components/ProjectRootBanner.tsx`
- Modify: `editor/src/features/project/index.ts` (export)
- Modify: `editor/src/App.tsx:1146-1151` (mount above `<TabBar />`)
- Modify: `editor/src/App.css` (styles)

**Interfaces:**
- Consumes: `rootBannerFor`, `RootBanner` (Task 2); `openProjectInNewWindow` (existing, `features/project/services/multi-window`).
- Produces: `<ProjectRootBanner />`, default-exported and re-exported from the `features/project` barrel.

- [ ] **Step 1: Write the component**

Create `editor/src/features/project/components/ProjectRootBanner.tsx`:

```tsx
import { Zap, X } from 'lucide-react';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useProjectContextStore } from '../../../stores/project-context';
import { useSettingsStore } from '../../../stores/settings';
import { notify } from '../../../stores/notifications';
import { openProjectInNewWindow } from '../services/multi-window';
import { rootBannerFor } from '../services/root-banner';

/**
 * Explains why Unity features are off when the opened folder sits inside (or
 * contains) a Unity project, and offers to open the project root instead.
 *
 * Rendering is decided by `rootBannerFor` so the logic stays unit-tested —
 * this component only wires stores to it.
 */
function ProjectRootBanner() {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const isUnityProject = useProjectContextStore((s) => s.isUnityProject);
  const ancestorProjectPath = useProjectContextStore((s) => s.ancestorProjectPath);
  const nestedProjectPath = useProjectContextStore((s) => s.nestedProjectPath);
  const dismissedPaths = useSettingsStore((s) => s.settings['project.rootBanner.dismissed']);
  const setSetting = useSettingsStore((s) => s.setSetting);

  const banner = rootBannerFor({
    isUnityProject,
    ancestorProjectPath,
    nestedProjectPath,
    workspacePath,
    dismissedPaths,
  });

  if (!banner) return null;

  const folderName = workspacePath?.split('/').filter(Boolean).pop() ?? 'This folder';

  function dismiss() {
    if (!workspacePath) return;
    if (dismissedPaths.includes(workspacePath)) return;
    setSetting('project.rootBanner.dismissed', [...dismissedPaths, workspacePath]);
  }

  // `banner` is a const narrowed to non-null by the guard above, so TypeScript
  // keeps that narrowing inside this closure — no assertion needed.
  const projectPath = banner.projectPath;

  function openRoot() {
    openProjectInNewWindow(projectPath).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      notify.error(`Couldn't open ${projectPath}. (${msg})`);
      // The detection is stale if the project is gone — stop offering it.
      dismiss();
    });
  }

  return (
    <div className="project-root-banner">
      <span className="project-root-banner-icon">
        <Zap size={14} />
      </span>
      <span className="project-root-banner-text">
        {banner.kind === 'inside' ? (
          <>
            <strong>{folderName}</strong> is inside the Unity project{' '}
            <strong>{banner.projectName}</strong>. Unity features (console, play controls,
            bridge) need the project root.
          </>
        ) : (
          <>
            This folder contains the Unity project <strong>{banner.projectName}</strong>. Open
            it directly for Unity features.
          </>
        )}
      </span>
      <button className="project-root-banner-action" onClick={openRoot}>
        Open project root
      </button>
      <button className="project-root-banner-dismiss" onClick={dismiss} title="Dismiss">
        <X size={14} />
      </button>
    </div>
  );
}

export default ProjectRootBanner;
```

- [ ] **Step 2: Wire it in**

Add to `editor/src/features/project/index.ts`:

```ts
export { default as ProjectRootBanner } from './components/ProjectRootBanner';
```

Add to the existing `features/project` import block in `editor/src/App.tsx` (which already imports `WelcomeScreen`, `openWelcomeWindow`, `openFolderInNewWindow`, `setProjectWindowTitle`, `initialBootSurface`):

```ts
  ProjectRootBanner,
```

Mount it in `App.tsx` inside `.editor-section`, immediately above `<TabBar />` (line ~1151), so it sits above the editor regardless of which file is active and is not swallowed by the `settingsOpen` / `auth://` branches:

```tsx
                        <div className="editor-section">
                          {settingsOpen ? (
                            <SettingsPanel onClose={() => useUiStore.getState().setSettingsOpen(false)} />
                          ) : (
                            <>
                              <ProjectRootBanner />
                              <TabBar />
```

Add to `editor/src/App.css`:

```css
/* Explains why Unity features are off when the opened folder is inside (or
   contains) a Unity project. See features/project/services/root-banner.ts. */
.project-root-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  flex-shrink: 0;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  color: var(--text-primary);
}

.project-root-banner-icon {
  display: flex;
  color: var(--accent, #d7ba7d);
}

.project-root-banner-text {
  flex: 1;
  min-width: 0;
  line-height: 1.4;
}

.project-root-banner-action {
  flex-shrink: 0;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 12px;
  cursor: pointer;
}

.project-root-banner-action:hover {
  background: var(--bg-hover, var(--bg-secondary));
}

.project-root-banner-dismiss {
  flex-shrink: 0;
  display: flex;
  padding: 2px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}

.project-root-banner-dismiss:hover {
  color: var(--text-primary);
}
```

- [ ] **Step 3: Verify**

Run: `cd editor && npx tsc --noEmit && bun run check:modules && bun test src`
Expected: tsc clean, boundaries OK, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add editor/src/features/project/components/ProjectRootBanner.tsx \
        editor/src/features/project/index.ts \
        editor/src/App.tsx editor/src/App.css
git commit -m "feat(project): banner offering to open the Unity project root

Renders above the tab bar when the workspace sits inside or contains a
Unity project, naming it and switching in one click."
```

---

### Task 4: Stop hiding the Unity bridge status

**Files:**
- Modify: `editor/src/features/app-shell/components/StatusBar.tsx:110` and `:137`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new.

- [ ] **Step 1: Implement**

`StatusBar.tsx` line 110 gates the whole bridge cluster on the Unity version being readable, so a Unity project with an unparseable `ProjectSettings/ProjectVersion.txt` shows no Unity state at all. Drop the version from the gate and make the label tolerate its absence.

Change line 110 from:

```tsx
        {isUnityProject && unityVersion && (
```

to:

```tsx
        {isUnityProject && (
```

Then change the label on line ~137 from:

```tsx
            <span>Unity {unityVersion}</span>
```

to:

```tsx
            <span>{unityVersion ? `Unity ${unityVersion}` : 'Unity'}</span>
```

- [ ] **Step 2: Verify**

Run: `cd editor && npx tsc --noEmit && bun test src`
Expected: tsc clean, all tests pass.

- [ ] **Step 3: Commit**

```bash
git add editor/src/features/app-shell/components/StatusBar.tsx
git commit -m "fix(status-bar): show Unity bridge state without a version

The cluster was gated on unityVersion, so a Unity project with an
unreadable ProjectVersion.txt showed no bridge state at all — including
'not installed', the one a user most needs to see."
```

---

### Task 5: Shared keybinding formatter + signpost shortcut lookup

**Files:**
- Create: `editor/src/utils/format-keybinding.ts`
- Create: `editor/src/utils/format-keybinding.test.ts`
- Create: `editor/src/features/project/services/signpost.ts`
- Create: `editor/src/features/project/services/signpost.test.ts`
- Modify: `editor/src/features/command-palette/components/PaletteModal.tsx:34-54` (remove local copy, import shared)
- Modify: `editor/src/features/project/index.ts` (export)

**Interfaces:**
- Consumes: `useCommandsStore.getKeybindings()` → `Array<{ id: string; keybinding: string; handler: () => void }>`.
- Produces:
  - `function formatKeybinding(kb: string): string`
  - `type SignpostShortcut = { id: string; label: string; keys: string }`
  - `function signpostShortcuts(bindings: Array<{ id: string; keybinding: string }>): SignpostShortcut[]`

- [ ] **Step 1: Write the failing tests**

Create `editor/src/utils/format-keybinding.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { formatKeybinding } from './format-keybinding';

// The platform is passed explicitly rather than sniffed, so these assert both
// platforms deterministically on any host. This matters: bun defines
// `navigator`, so `isMac()` returns true under `bun test` on a macOS machine
// and false on a Windows CI box — sniffing would make the same assertions
// pass on one and fail on the other.
describe('formatKeybinding', () => {
  describe('windows / linux', () => {
    it('renders mod as Ctrl and joins with +', () => {
      expect(formatKeybinding('mod+p', false)).toBe('Ctrl+P');
    });

    it('renders multi-modifier chords', () => {
      expect(formatKeybinding('mod+shift+a', false)).toBe('Ctrl+Shift+A');
    });

    it('maps named key tokens to their symbols', () => {
      expect(formatKeybinding('mod+backquote', false)).toBe('Ctrl+`');
      expect(formatKeybinding('mod+shift+bracketright', false)).toBe('Ctrl+Shift+]');
      expect(formatKeybinding('mod+backslash', false)).toBe('Ctrl+\\');
    });

    it('passes a literal backtick through', () => {
      expect(formatKeybinding('mod+`', false)).toBe('Ctrl+`');
    });
  });

  describe('macos', () => {
    it('renders modifier symbols with no separator', () => {
      expect(formatKeybinding('mod+p', true)).toBe('⌘P');
      expect(formatKeybinding('mod+shift+a', true)).toBe('⌘⇧A');
      expect(formatKeybinding('mod+alt+right', true)).toBe('⌘⌥Right');
    });
  });
});
```

Create `editor/src/features/project/services/signpost.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { signpostShortcuts } from './signpost';

const ALL = [
  { id: 'palette.quickOpen', keybinding: 'mod+p' },
  { id: 'terminal.toggle', keybinding: 'mod+`' },
  { id: 'view.aiPanel', keybinding: 'mod+shift+a' },
  { id: 'palette.commands', keybinding: 'mod+shift+p' },
  { id: 'file.save', keybinding: 'mod+s' },
];

// Platform pinned to false (Windows/Linux chords) so assertions hold on any
// test host — see the note in format-keybinding.test.ts.
describe('signpostShortcuts', () => {
  it('returns the four signposted commands in a stable order', () => {
    expect(signpostShortcuts(ALL, false).map((s) => s.id)).toEqual([
      'palette.quickOpen',
      'terminal.toggle',
      'view.aiPanel',
      'palette.commands',
    ]);
  });

  it('labels each shortcut for a newcomer', () => {
    const byId = Object.fromEntries(signpostShortcuts(ALL, false).map((s) => [s.id, s.label]));
    expect(byId['palette.quickOpen']).toBe('Go to file');
    expect(byId['terminal.toggle']).toBe('Terminal');
    expect(byId['view.aiPanel']).toBe('Ask the AI');
    expect(byId['palette.commands']).toBe('Commands');
  });

  it('formats the keys for display', () => {
    const terminal = signpostShortcuts(ALL, false).find((s) => s.id === 'terminal.toggle');
    expect(terminal?.keys).toBe('Ctrl+`');
  });

  // Guards the reason this is registry-driven: the tester was told "Ctrl+J
  // opens the terminal", but mod+j is view.toggleBottomPanel — the terminal
  // just lives in that panel. Hardcoding would ship that same confusion.
  it('reads the real binding rather than a hardcoded one', () => {
    const rebound = signpostShortcuts(
      [
        ...ALL.filter((b) => b.id !== 'terminal.toggle'),
        { id: 'terminal.toggle', keybinding: 'mod+shift+t' },
      ],
      false,
    );
    expect(rebound.find((s) => s.id === 'terminal.toggle')?.keys).toBe('Ctrl+Shift+T');
  });

  it('omits a command that has no binding rather than showing an empty key', () => {
    const partial = signpostShortcuts(ALL.filter((b) => b.id !== 'view.aiPanel'), false);
    expect(partial.map((s) => s.id)).not.toContain('view.aiPanel');
    expect(partial).toHaveLength(3);
  });

  it('returns nothing when no commands are registered yet', () => {
    expect(signpostShortcuts([], false)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd editor && bun test ./src/utils/format-keybinding.test.ts ./src/features/project/services/signpost.test.ts`
Expected: FAIL — `Cannot find module './format-keybinding'` and `'./signpost'`.

- [ ] **Step 3: Implement**

Create `editor/src/utils/format-keybinding.ts` by moving the implementation verbatim out of `PaletteModal.tsx` (lines 34–54), so the palette and the signpost can never disagree:

```ts
import { isMac as platformIsMac } from './platform';

/** Key tokens whose display form isn't just a capitalized name. */
const NAMED_KEY_LABELS: Record<string, string> = {
  backslash: '\\',
  bracketleft: '[',
  bracketright: ']',
  backquote: '`',
};

/**
 * Render a registered keybinding (`'mod+shift+a'`) as a display chord
 * (`'⌘⇧A'` on macOS, `'Ctrl+Shift+A'` elsewhere).
 *
 * Shared so every surface that advertises a shortcut reads the same registry
 * string through the same formatter — a hardcoded chord elsewhere would drift
 * from the real binding without anything failing.
 *
 * `isMac` is a parameter defaulting to the sniffed platform so tests can pin
 * it. Sniffing alone is not testable here: bun defines `navigator`, so
 * `isMac()` is true under `bun test` on macOS and false on a Windows CI host,
 * and the same assertion would pass on one and fail on the other.
 */
export function formatKeybinding(kb: string, isMac: boolean = platformIsMac()): string {
  return kb
    .split('+')
    .map((part) => {
      const p = part.toLowerCase().trim();
      if (p === 'mod') return isMac ? '⌘' : 'Ctrl';
      if (p === 'shift') return isMac ? '⇧' : 'Shift';
      if (p === 'alt') return isMac ? '⌥' : 'Alt';
      if (p === '`') return '`';
      if (NAMED_KEY_LABELS[p]) return NAMED_KEY_LABELS[p];
      return p.charAt(0).toUpperCase() + p.slice(1);
    })
    .join(isMac ? '' : '+');
}
```

In `PaletteModal.tsx`, delete the local `NAMED_KEY_LABELS` const (lines 34–39) and the local `formatKeybinding` function (lines 41–54), and add the import alongside the existing imports:

```ts
import { formatKeybinding } from '../../../utils/format-keybinding';
```

Leave the existing call site at line ~413 (`{formatKeybinding(result.cmd.keybinding)}`) untouched. If `platformIsMac` becomes unused in `PaletteModal.tsx` after the move, remove that import too — `tsc --noEmit` will flag it.

Create `editor/src/features/project/services/signpost.ts`:

```ts
import { formatKeybinding } from '../../../utils/format-keybinding';

export interface SignpostShortcut {
  id: string;
  label: string;
  keys: string;
}

/**
 * The handful of commands a first-time user needs, with newcomer-facing
 * labels. Order is the display order.
 *
 * Keys are resolved from the live command registry rather than written here.
 * That is load-bearing: the tester who prompted this work was told "Ctrl+J
 * opens the terminal", but `mod+j` is `view.toggleBottomPanel` — the terminal
 * merely lives in that panel. The direct binding is `terminal.toggle`, and the
 * AI panel is `view.aiPanel` (not `view.toggleRightSidebar`). Hardcoding would
 * have shipped exactly that confusion.
 */
const SIGNPOSTED: Array<{ id: string; label: string }> = [
  { id: 'palette.quickOpen', label: 'Go to file' },
  { id: 'terminal.toggle', label: 'Terminal' },
  { id: 'view.aiPanel', label: 'Ask the AI' },
  { id: 'palette.commands', label: 'Commands' },
];

/**
 * Resolve the signposted commands against the registered keybindings,
 * dropping any that aren't bound so the UI never renders an empty chord.
 */
export function signpostShortcuts(
  bindings: Array<{ id: string; keybinding: string }>,
  isMac?: boolean,
): SignpostShortcut[] {
  const byId = new Map(bindings.map((b) => [b.id, b.keybinding]));
  const out: SignpostShortcut[] = [];
  for (const { id, label } of SIGNPOSTED) {
    const kb = byId.get(id);
    if (!kb) continue;
    // Undefined `isMac` falls through to formatKeybinding's own default,
    // which sniffs the platform — production callers pass nothing.
    out.push({ id, label, keys: isMac === undefined ? formatKeybinding(kb) : formatKeybinding(kb, isMac) });
  }
  return out;
}
```

Export from `editor/src/features/project/index.ts`:

```ts
export { signpostShortcuts } from './services/signpost';
export type { SignpostShortcut } from './services/signpost';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd editor && bun test ./src/utils/format-keybinding.test.ts ./src/features/project/services/signpost.test.ts && npx tsc --noEmit && bun run check:modules`
Expected: 10 tests PASS, tsc clean, boundaries OK.

- [ ] **Step 5: Commit**

```bash
git add editor/src/utils/format-keybinding.ts editor/src/utils/format-keybinding.test.ts \
        editor/src/features/project/services/signpost.ts \
        editor/src/features/project/services/signpost.test.ts \
        editor/src/features/project/index.ts \
        editor/src/features/command-palette/components/PaletteModal.tsx
git commit -m "refactor(shortcuts): share formatKeybinding, add signpost lookup

Moves the palette's private formatter to utils so any surface
advertising a shortcut renders the same chord, and resolves the
signposted commands from the live registry instead of hardcoding."
```

---

### Task 6: WorkspaceSignpost empty state

**Files:**
- Create: `editor/src/features/project/components/WorkspaceSignpost.tsx`
- Modify: `editor/src/features/project/components/WelcomeScreen.tsx:52-60` (the `hasWorkspace` branch)
- Modify: `editor/src/App.css` (styles)

**Interfaces:**
- Consumes: `signpostShortcuts` (Task 5); `useCommandsStore.getKeybindings()`; `useProjectContextStore`; `useUnityStore`; `useWorkspaceStore`.
- Produces: `<WorkspaceSignpost />`, rendered by `WelcomeScreen` when `hasWorkspace` is true.

- [ ] **Step 1: Write the component**

Create `editor/src/features/project/components/WorkspaceSignpost.tsx`:

```tsx
import { useCommandsStore } from '../../../stores/commands';
import { useProjectContextStore } from '../../../stores/project-context';
import { useUnityStore } from '../../../stores/unity';
import { useWorkspaceStore } from '../../../stores/workspace';
import { signpostShortcuts } from '../services/signpost';

/** Human-readable bridge state, mirroring the StatusBar cluster's tooltips. */
function bridgeLabel(state: string): string {
  switch (state) {
    case 'connected': return 'bridge connected';
    case 'reloading': return 'reloading…';
    case 'not-installed': return 'bridge not installed';
    default: return 'bridge disconnected';
  }
}

/**
 * Shown in place of the editor when a workspace is open but no file is —
 * the screen a user lands on right after opening a project.
 *
 * Replaces a near-empty "Select a file from the explorer to get started",
 * which spent prime real estate saying nothing. Answers the three questions
 * the Unity feedback raised: is the Unity integration working, which
 * shortcuts matter, and where the Unity features live.
 */
function WorkspaceSignpost() {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const isUnityProject = useProjectContextStore((s) => s.isUnityProject);
  const unityVersion = useProjectContextStore((s) => s.unityVersion);
  const bridgeState = useUnityStore((s) => s.bridgeState);
  // Subscribing to the map keeps this in sync as commands register at boot.
  const commands = useCommandsStore((s) => s.commands);

  const shortcuts = signpostShortcuts(
    Array.from(commands.values())
      .filter((c) => c.keybinding)
      .map((c) => ({ id: c.id, keybinding: c.keybinding! })),
  );

  const projectName = workspacePath?.split('/').filter(Boolean).pop() ?? '';

  return (
    <div className="workspace-signpost">
      {projectName && <h2 className="workspace-signpost-title">{projectName}</h2>}

      {isUnityProject && (
        <p className="workspace-signpost-unity">
          {unityVersion ? `Unity ${unityVersion}` : 'Unity'} · {bridgeLabel(bridgeState)}
        </p>
      )}

      {shortcuts.length > 0 && (
        <ul className="workspace-signpost-shortcuts">
          {shortcuts.map((s) => (
            <li key={s.id}>
              <kbd>{s.keys}</kbd>
              <span>{s.label}</span>
            </li>
          ))}
        </ul>
      )}

      {isUnityProject && (
        <p className="workspace-signpost-hint">
          Unity console, hierarchy and tests are in the left activity bar.
        </p>
      )}
    </div>
  );
}

export default WorkspaceSignpost;
```

- [ ] **Step 2: Wire it into WelcomeScreen**

In `editor/src/features/project/components/WelcomeScreen.tsx`, add the import:

```ts
import WorkspaceSignpost from './WorkspaceSignpost';
```

Replace the `hasWorkspace` branch (lines ~52–60):

```tsx
  if (hasWorkspace) {
    return (
      <div className="welcome-screen">
        <h2>Editor</h2>
        <p>Select a file from the explorer to get started</p>
        <span className="welcome-shortcut">Ctrl+O / Cmd+O to open a different folder</span>
      </div>
    );
  }
```

with:

```tsx
  if (hasWorkspace) {
    return <WorkspaceSignpost />;
  }
```

Add to `editor/src/App.css`:

```css
/* Landing screen when a project is open but no file is. See
   features/project/components/WorkspaceSignpost.tsx. */
.workspace-signpost {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 14px;
  padding: 24px;
  background: var(--bg-primary);
  color: var(--text-secondary);
  text-align: center;
}

.workspace-signpost-title {
  margin: 0;
  font-size: 20px;
  font-weight: 400;
  color: var(--text-primary);
}

.workspace-signpost-unity {
  margin: 0;
  font-size: 12px;
}

.workspace-signpost-shortcuts {
  display: grid;
  grid-template-columns: auto auto;
  gap: 8px 18px;
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
  font-size: 12px;
}

.workspace-signpost-shortcuts li {
  display: flex;
  align-items: center;
  gap: 8px;
}

.workspace-signpost-shortcuts kbd {
  min-width: 68px;
  padding: 2px 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-family: var(--font-mono, monospace);
  font-size: 11px;
}

.workspace-signpost-hint {
  margin: 4px 0 0;
  font-size: 12px;
  max-width: 42ch;
  line-height: 1.5;
}
```

- [ ] **Step 3: Verify**

Run: `cd editor && npx tsc --noEmit && bun run check:modules && bun test src && bun run build`
Expected: tsc clean, boundaries OK, all tests pass, production build succeeds.

Then the Rust suite: `cd editor/src-tauri && cargo test --lib`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add editor/src/features/project/components/WorkspaceSignpost.tsx \
        editor/src/features/project/components/WelcomeScreen.tsx \
        editor/src/App.css
git commit -m "feat(project): signpost the empty editor state

Replaces 'Select a file from the explorer to get started' with the
project name, live Unity bridge state, the four shortcuts that matter,
and a pointer to the Unity panels in the activity bar."
```

---

## Manual verification (Windows)

None of this can be exercised end-to-end on macOS. Before calling it done, on Windows with a real Unity project:

1. Open `<project>/Assets/Scripts`. Expect the banner naming the project, and Unity features off.
2. Click **Open project root**. Expect a new window on the project root, the Unity activity-bar icons present, and the StatusBar bridge dot.
3. Dismiss the banner in the subfolder, reopen that subfolder. Expect no banner.
4. Open a folder that *contains* a Unity project. Expect the "contains" wording.
5. With no file open, confirm the signpost shows real chords (`Ctrl+\`` for Terminal, `Ctrl+Shift+A` for the AI panel) — not `Ctrl+J`.
6. Open a plain non-Unity folder. Expect no banner, no Unity line, and no activity-bar hint.
