import { Store } from '@tauri-apps/plugin-store';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { normalizeLegacyPath } from './legacy-path';
import { hashLabel } from './window-label';

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

export interface WindowState {
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

/**
 * Upgrade one persisted tab entry's Windows paths (see `normalizeLegacyPath`).
 * Tolerates the pre-`PersistedOpenFile` shape, where an entry was a bare path
 * string — `planFileRestore` still accepts those.
 *
 * `name` is only recomputed when it had degenerated into the full path, which
 * is what the old `/`-splitting basename produced for a `\\?\D:\...` entry.
 * Leaving it otherwise preserves purpose-built labels (e.g. diff tabs).
 */
function migrateOpenFile(entry: PersistedOpenFile | string): PersistedOpenFile | string {
  if (typeof entry === 'string') return normalizeLegacyPath(entry);
  const path = normalizeLegacyPath(entry.path);
  const diff = entry.diff
    ? { ...entry.diff, filePath: normalizeLegacyPath(entry.diff.filePath) }
    : entry.diff;
  if (path === entry.path && diff === entry.diff) return entry;
  return {
    ...entry,
    path,
    name: entry.name === entry.path ? basename(path) : entry.name,
    ...(diff ? { diff } : {}),
  };
}

/**
 * Upgrade a persisted recents array: Windows paths from pre-`path_util` builds
 * (verbatim `\\?\...`) are normalized, then entries that collapse onto the same
 * project are dropped — otherwise the legacy spelling lingers in the list
 * beside the normalized one, since dedup is an exact string match. `name` is
 * recomputed for rewritten entries because basename() splits on '/', so a
 * `\\?\D:\...` entry had degenerated into its own full path.
 *
 * Shared by `hydratePersistence` and `refreshRecentsCache`: the latter re-reads
 * the same store key, so skipping the migration there would resurrect legacy
 * entries that the next `addRecentProject` would then persist for good.
 */
export function migrateRecents(arr: RecentProject[]): RecentProject[] {
  const out: RecentProject[] = [];
  const seenPaths = new Set<string>();
  for (const r of arr) {
    const path = normalizeLegacyPath(r.path);
    if (seenPaths.has(path)) continue;
    seenPaths.add(path);
    out.push(path === r.path ? r : { ...r, path, name: basename(path) });
  }
  return out;
}

function replaceCachedRecents(arr: RecentProject[]): void {
  const migrated = migrateRecents(arr);
  cachedRecents.length = 0;
  for (const r of migrated) cachedRecents.push(r);
}

/**
 * Upgrade one persisted window entry, returning both the migrated state and
 * the label it should now be stored under.
 *
 * A project window's label is `hashLabel(canonicalPath)`, so normalizing the
 * workspace path changes the KEY, not just the value: a Windows entry written
 * as `\\?\D:\Unity\Proj` hashes differently from `D:/Unity/Proj`, and
 * `loadState()` — which looks up the *current* window's label — would find
 * nothing and silently drop every open tab, the active file and the persisted
 * pane widths. Re-keying here is what makes the value migration below
 * reachable at all.
 *
 * Only re-keys when the existing label is demonstrably the hash of the old
 * path: fixed labels (`main`, `welcome`) and any hand-made label keep theirs,
 * since their state is not addressed by project path.
 */
export function migrateWindowEntry(
  label: string,
  state: WindowState,
): { label: string; state: WindowState } {
  const original = state.workspacePath;
  const workspacePath = normalizeLegacyPath(original);
  const migrated: WindowState = {
    ...state,
    workspacePath,
    // Cast: the declared element type is `PersistedOpenFile`, but data
    // written by old builds can still hold bare path strings — which
    // `planFileRestore` accepts. `migrateOpenFile` preserves whichever
    // shape it was given.
    openFilePaths: (state.openFilePaths?.map(migrateOpenFile) ??
      state.openFilePaths) as PersistedOpenFile[],
    activeFilePath: normalizeLegacyPath(state.activeFilePath),
  };

  const rekey =
    !!original &&
    !!workspacePath &&
    workspacePath !== original &&
    label === hashLabel(original);

  return { label: rekey ? hashLabel(workspacePath) : label, state: migrated };
}

export async function hydratePersistence(): Promise<void> {
  if (hydrated) return;
  if (hydratePromise) return hydratePromise;
  hydratePromise = (async () => {
    try {
      const recents = await getRecents();
      replaceCachedRecents((await recents.get<RecentProject[]>('projects')) ?? []);
    } catch { /* ignore */ }

    try {
      const windowsStoreInst = await getWindows();
      const entries = (await windowsStoreInst.entries<WindowState>()) ?? [];
      const rekeyed: Array<{ from: string; to: string }> = [];
      for (const [label, state] of entries) {
        const next = migrateWindowEntry(label, state);
        if (next.label !== label) {
          rekeyed.push({ from: label, to: next.label });
          // An entry already sitting on the new label was written by a
          // post-normalization run of the same project — newer than this
          // legacy one, so it wins and the legacy entry is only deleted.
          if (cachedWindows[next.label]) continue;
        }
        cachedWindows[next.label] = next.state;
      }
      // Persist the re-key so the next launch has nothing to migrate (and the
      // orphaned legacy keys don't accumulate in windows.json).
      for (const { from, to } of rekeyed) {
        await windowsStoreInst.set(to, cachedWindows[to]);
        await windowsStoreInst.delete(from);
      }
      if (rekeyed.length > 0) await windowsStoreInst.save();
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

/**
 * Returns the underlying write's promise, unlike `saveState`'s
 * fire-and-forget `void writeWindowState(...)`, so `layout-persist.ts`'s
 * `flush()` can be awaited by close-time callers (`flushLayoutPersisters`)
 * and actually wait for the store write rather than just firing it.
 */
export function saveLayoutSizes(sizes: LayoutSizes): Promise<void> {
  const label = currentLabel();
  const existing = cachedWindows[label] ?? { workspacePath: null, openFilePaths: [], activeFilePath: null };
  const merged: LayoutSizes = { ...existing.layoutSizes, ...sizes };
  const next: WindowState = { ...existing, layoutSizes: merged };
  cachedWindows[label] = next;
  return writeWindowState(label, next);
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

/**
 * Re-reads the `projects` key from the shared `recents.json` store and
 * refreshes `cachedRecents` in place. Unlike `loadRecentProjectsFull` (which
 * only serves the in-memory cache populated at `hydratePersistence` time),
 * this hits the tauri-plugin-store resource directly — that resource is
 * shared app-wide across windows, so a recent-project write from another
 * window (e.g. opening a project from the welcome/manager window while this
 * window is also open) is visible here without a reload. Used by the
 * welcome window's focus-refresh so its recents list doesn't go stale while
 * it stays open alongside project windows.
 *
 * Runs the same `migrateRecents` upgrade as `hydratePersistence`: this reads
 * the raw store key, so without it a focus-refresh would put legacy `\\?\D:\…`
 * entries back beside their normalized duplicates — and the next
 * `addRecentProject` would write that un-migrated array back to disk.
 */
export async function refreshRecentsCache(): Promise<RecentProject[]> {
  try {
    const recents = await getRecents();
    replaceCachedRecents((await recents.get<RecentProject[]>('projects')) ?? []);
  } catch { /* ignore */ }
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
  return (
    !path.startsWith('auth://') &&
    !path.startsWith('diff://commit/') &&
    // Search tabs hold a live query and streamed results, neither of which
    // survives a restart in any useful form.
    !path.startsWith('search://')
  );
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
