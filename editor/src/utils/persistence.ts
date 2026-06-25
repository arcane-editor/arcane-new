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
  openFilePaths: Array<{ path: string; name: string }>;
  activeFilePath: string | null;
  layoutSizes?: LayoutSizes;
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
  openFilePaths: Array<{ path: string; name: string }>;
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
