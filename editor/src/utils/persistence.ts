import { Store } from '@tauri-apps/plugin-store';
import { getCurrentWindow } from '@tauri-apps/api/window';

const RECENTS_FILE = 'recents.json';
const WINDOWS_FILE = 'windows.json';

const LEGACY_STATE_KEY = 'editor-persisted-state';
const LEGACY_LAYOUT_KEY = 'editor-layout-sizes';
const LEGACY_RECENTS_KEY = 'editor-recent-projects';

const MAX_RECENT_PROJECTS = 20;

export interface PersistedState {
  workspacePath: string | null;
  openFilePaths: PersistedOpenFile[];
  activeFilePath: string | null;
  layoutSizes?: LayoutSizes;
}

/**
 * One persisted tab entry. `diff` is present only for staged/unstaged
 * `diff://` tabs — `diff://commit/...` tabs must never be persisted via this
 * shape (see `shouldPersistTab`, applied at the write site in App.tsx). Old
 * entries written before this field existed simply omit it, so `diff` stays
 * optional for backward compatibility.
 */
export interface PersistedOpenFile {
  path: string;
  name: string;
  diff?: { filePath: string; staged: boolean };
}

export interface LayoutSizes {
  /** @deprecated superseded by per-pane `sidebar`/`rightPanel` widths. */
  main?: number[];
  vertical?: number[];
  /**
   * Persisted width of the left file-explorer sidebar (px). Stored per-pane (not
   * as a positional array) so it's stable as panes are shown/hidden — the panes
   * are always mounted and toggled via Allotment's `visible` prop.
   */
  sidebar?: number;
  /** Persisted width of the right AI panel (px). Stored per-pane (see `sidebar`). */
  rightPanel?: number;
}

export interface RecentProject {
  path: string;
  name: string;
  lastOpened: number;
}

interface WindowState {
  workspacePath: string | null;
  openFilePaths: PersistedOpenFile[];
  activeFilePath: string | null;
  layoutSizes?: LayoutSizes;
}

let recentsStore: Store | null = null;
let windowsStore: Store | null = null;
let hydrated = false;
let hydratePromise: Promise<void> | null = null;

const cachedRecents: RecentProject[] = [];
const cachedWindows: Record<string, WindowState> = {};

function currentLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return 'main';
  }
}

async function getRecents(): Promise<Store> {
  if (!recentsStore) recentsStore = await Store.load(RECENTS_FILE);
  return recentsStore;
}
async function getWindows(): Promise<Store> {
  if (!windowsStore) windowsStore = await Store.load(WINDOWS_FILE);
  return windowsStore;
}

async function migrateLegacy(): Promise<void> {
  try {
    const legacyRecents = window.localStorage.getItem(LEGACY_RECENTS_KEY);
    if (legacyRecents) {
      const arr = JSON.parse(legacyRecents);
      if (Array.isArray(arr)) {
        const now = Date.now();
        for (const path of arr) {
          if (typeof path !== 'string') continue;
          if (cachedRecents.some((r) => r.path === path)) continue;
          cachedRecents.push({ path, name: basename(path), lastOpened: now });
        }
        const recents = await getRecents();
        await recents.set('projects', cachedRecents);
        await recents.save();
      }
      window.localStorage.removeItem(LEGACY_RECENTS_KEY);
    }
  } catch { /* ignore */ }

  try {
    const legacyState = window.localStorage.getItem(LEGACY_STATE_KEY);
    const legacyLayout = window.localStorage.getItem(LEGACY_LAYOUT_KEY);
    if (legacyState || legacyLayout) {
      const label = currentLabel();
      let state: WindowState = { workspacePath: null, openFilePaths: [], activeFilePath: null };
      if (legacyState) {
        try {
          const parsed = JSON.parse(legacyState);
          state.workspacePath = parsed.workspacePath ?? null;
          state.openFilePaths = parsed.openFilePaths ?? [];
          state.activeFilePath = parsed.activeFilePath ?? null;
        } catch { /* ignore */ }
      }
      if (legacyLayout) {
        try { state.layoutSizes = JSON.parse(legacyLayout); } catch { /* ignore */ }
      }
      cachedWindows[label] = state;
      const win = await getWindows();
      await win.set(label, state);
      await win.save();
      window.localStorage.removeItem(LEGACY_STATE_KEY);
      window.localStorage.removeItem(LEGACY_LAYOUT_KEY);
    }
  } catch { /* ignore */ }
}

function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p;
}

export async function hydratePersistence(): Promise<void> {
  if (hydrated) return;
  if (hydratePromise) return hydratePromise;
  hydratePromise = (async () => {
    try {
      const recents = await getRecents();
      const arr = (await recents.get<RecentProject[]>('projects')) ?? [];
      cachedRecents.length = 0;
      for (const r of arr) cachedRecents.push(r);
    } catch { /* ignore */ }

    try {
      const windowsStoreInst = await getWindows();
      const entries = (await windowsStoreInst.entries<WindowState>()) ?? [];
      for (const [label, state] of entries) cachedWindows[label] = state;
    } catch { /* ignore */ }

    if (cachedRecents.length === 0 && Object.keys(cachedWindows).length === 0) {
      await migrateLegacy();
    }

    hydrated = true;
  })();
  return hydratePromise;
}

export function loadState(): PersistedState | null {
  const label = currentLabel();
  const s = cachedWindows[label];
  if (!s) return null;
  return {
    workspacePath: s.workspacePath,
    openFilePaths: s.openFilePaths,
    activeFilePath: s.activeFilePath,
    layoutSizes: s.layoutSizes,
  };
}

export function saveState(state: PersistedState): void {
  const label = currentLabel();
  const existing = cachedWindows[label] ?? { workspacePath: null, openFilePaths: [], activeFilePath: null };
  const next: WindowState = {
    workspacePath: state.workspacePath,
    openFilePaths: state.openFilePaths,
    activeFilePath: state.activeFilePath,
    layoutSizes: state.layoutSizes ?? existing.layoutSizes,
  };
  cachedWindows[label] = next;
  void writeWindowState(label, next);
}

export function loadLayoutSizes(): LayoutSizes {
  const label = currentLabel();
  return cachedWindows[label]?.layoutSizes ?? {};
}

export function saveLayoutSizes(sizes: LayoutSizes): void {
  const label = currentLabel();
  const existing = cachedWindows[label] ?? { workspacePath: null, openFilePaths: [], activeFilePath: null };
  const merged: LayoutSizes = { ...existing.layoutSizes, ...sizes };
  const next: WindowState = { ...existing, layoutSizes: merged };
  cachedWindows[label] = next;
  void writeWindowState(label, next);
}

async function writeWindowState(label: string, state: WindowState): Promise<void> {
  try {
    const win = await getWindows();
    await win.set(label, state);
    await win.save();
  } catch { /* ignore */ }
}

export function loadRecentProjects(): string[] {
  return cachedRecents.map((r) => r.path);
}

export function loadRecentProjectsFull(): RecentProject[] {
  return cachedRecents.slice();
}

export function addRecentProject(path: string): void {
  const idx = cachedRecents.findIndex((r) => r.path === path);
  if (idx >= 0) cachedRecents.splice(idx, 1);
  cachedRecents.unshift({ path, name: basename(path), lastOpened: Date.now() });
  if (cachedRecents.length > MAX_RECENT_PROJECTS) cachedRecents.length = MAX_RECENT_PROJECTS;
  void writeRecents();
}

export function removeRecentProject(path: string): void {
  const idx = cachedRecents.findIndex((r) => r.path === path);
  if (idx < 0) return;
  cachedRecents.splice(idx, 1);
  void writeRecents();
}

async function writeRecents(): Promise<void> {
  try {
    const recents = await getRecents();
    await recents.set('projects', cachedRecents);
    await recents.save();
  } catch { /* ignore */ }
}

export function dropWindowState(label: string): void {
  if (!cachedWindows[label]) return;
  delete cachedWindows[label];
  void (async () => {
    try {
      const win = await getWindows();
      await win.delete(label);
      await win.save();
    } catch { /* ignore */ }
  })();
}

// ── Restore-tab migration ────────────────────────────────────────────────
//
// Pure mapping from a persisted tab entry to the action needed to restore
// it. Kept separate from App.tsx's restore effect so the old-shape → new-
// shape migration (entries with no `diff` field at all, from before this
// field existed) is unit-testable without a Tauri Store or the workspace
// store.

/** Matches the "(Staged)"/"(Working Tree)" suffix `openDiffTab` appends to a
 * diff tab's display name, so restoring doesn't double it up. */
const DIFF_NAME_SUFFIX = / \((Staged|Working Tree)\)$/;

export function stripDiffTabSuffix(name: string): string {
  return name.replace(DIFF_NAME_SUFFIX, '');
}

export type RestorePlan =
  | { kind: 'diff'; filePath: string; name: string; staged: boolean }
  | { kind: 'file'; path: string; name: string };

/**
 * Decides how to restore one persisted tab. Entries with a `diff` field
 * (staged/unstaged only — see `PersistedOpenFile`) are re-opened via
 * `openDiffTab`, which refetches content from git, so they're never stale.
 * Entries without it — including every entry persisted before this field
 * existed — fall back to a plain file open, unchanged from prior behavior.
 */
/**
 * Whether an open tab should ever be written to persisted window state.
 * `auth://` tabs are virtual (no restore logic exists for them) and
 * `diff://commit/<hash>/<relpath>` tabs are intentionally never persisted —
 * `PersistedOpenFile.diff` only has room for the staged/unstaged shape
 * (`{ filePath, staged }`), so persisting a commit-diff tab as-is would have
 * it restored via `openDiffTab` (staged/unstaged) on next launch instead of
 * `openCommitDiffTab` at the right revision. Simplest correct fix: never
 * write these tabs out in the first place.
 */
export function shouldPersistTab(path: string): boolean {
  return !path.startsWith('auth://') && !path.startsWith('diff://commit/');
}

export function planFileRestore(entry: PersistedOpenFile): RestorePlan {
  if (entry.diff) {
    return {
      kind: 'diff',
      filePath: entry.diff.filePath,
      name: stripDiffTabSuffix(entry.name),
      staged: entry.diff.staged,
    };
  }
  return { kind: 'file', path: entry.path, name: entry.name };
}

/**
 * Picks which tab should be active once the restore loop finishes. Restoring
 * an entry can fail mid-loop (deleted file, stale diff/git state), so the
 * persisted `activeFilePath` may not correspond to anything that actually
 * made it back into `openFiles` — setting it anyway leaves the workspace
 * store pointed at a path with no matching tab, and the editor falls back to
 * a blank WelcomeScreen even though other tabs did restore successfully.
 *
 * Prefers the persisted active path when it's among the successfully
 * restored paths; otherwise falls back to the last successfully restored
 * path (`restoredPaths` is in restore order); returns `null` when nothing
 * restored, so the caller can leave `activeFilePath` untouched.
 */
export function resolveActiveFilePath(
  persistedActive: string | null | undefined,
  restoredPaths: string[],
): string | null {
  if (persistedActive && restoredPaths.includes(persistedActive)) {
    return persistedActive;
  }
  return restoredPaths.length > 0 ? restoredPaths[restoredPaths.length - 1] : null;
}
