import { create } from 'zustand';
import type { DiagnosticItem, DiagnosticSource } from '../types';

export type SidebarView = 'explorer' | 'source-control' | 'search' | 'scene-context' | 'hierarchy' | 'test' | 'debug';
/** Per-file view mode for Unity YAML assets: structured tree vs raw Monaco. */
export type AssetViewerMode = 'structured' | 'raw-view' | 'raw-edit';
/** Per-tab view mode for a Unity-asset git diff tab: semantic tree vs raw Monaco text diff. */
export type DiffViewMode = 'semantic' | 'text';

/** How the Source Control panel groups changed files: flat list, or by folder. */
export type ScmViewMode = 'list' | 'tree';
export type RightSidebarView = 'ai-panel' | 'unity-inspector';
export type BottomPanelTab = 'terminal' | 'problems' | 'output' | 'unity-console';
export type LspStatus = 'idle' | 'starting' | 'indexing' | 'ready' | 'error';

// DiagnosticSource is defined in ../types and re-exported here for consumers
// that import it from this module.
export type { DiagnosticSource };

interface EditorCursorInfo {
  line: number;
  column: number;
}

/** uri → source → items */
export type DiagnosticsMap = Map<string, Map<string, DiagnosticItem[]>>;

/**
 * Flatten all sources for one URI, applying dedup rule:
 * if a `unity-compiler` item and an `lsp` item exist for the same file + same
 * start line, drop the `unity-compiler` one (the LSP version is richer).
 */
export function getFlatDiagnosticsForUri(
  diagnostics: DiagnosticsMap,
  uri: string,
): DiagnosticItem[] {
  const sourceMap = diagnostics.get(uri);
  if (!sourceMap) return [];

  const lspItems = sourceMap.get('lsp') ?? [];
  const lspLines = new Set(lspItems.map((d) => d.line));

  const result: DiagnosticItem[] = [];
  for (const [source, items] of sourceMap) {
    for (const item of items) {
      if (source === 'unity-compiler' && lspLines.has(item.line)) continue;
      result.push(item);
    }
  }
  return result;
}

/**
 * Flatten diagnostics across all URIs in the store, applying the same dedup
 * rule per file.
 */
export function getFlatAllDiagnostics(diagnostics: DiagnosticsMap): DiagnosticItem[] {
  const all: DiagnosticItem[] = [];
  for (const uri of diagnostics.keys()) {
    all.push(...getFlatDiagnosticsForUri(diagnostics, uri));
  }
  return all.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

// Counts are recomputed across all files on every publish (O(total items)) — fine at IDE scale; revisit only if per-file publishes become hot.
/** Recompute error/warning counts from the full nested map (after dedup). */
function recomputeCounts(diagnostics: DiagnosticsMap): { errors: number; warnings: number } {
  const flat = getFlatAllDiagnostics(diagnostics);
  let errors = 0;
  let warnings = 0;
  for (const d of flat) {
    if (d.severity === 'error') errors++;
    else if (d.severity === 'warning') warnings++;
  }
  return { errors, warnings };
}

interface UiState {
  activeSidebarView: SidebarView;
  setActiveSidebarView: (view: SidebarView) => void;
  sidebarVisible: boolean;
  toggleSidebar: () => void;
  setSidebarVisible: (visible: boolean) => void;

  rightSidebarVisible: boolean;
  activeRightSidebarView: RightSidebarView;
  toggleRightSidebar: () => void;
  setRightSidebarVisible: (visible: boolean) => void;
  setActiveRightSidebarView: (view: RightSidebarView) => void;

  aiPanelMaximized: boolean;
  toggleAiPanelMaximized: () => void;
  setAiPanelMaximized: (v: boolean) => void;

  graphifyIntroOpen: boolean;
  setGraphifyIntroOpen: (open: boolean) => void;

  dotnetMissingModalOpen: boolean;
  setDotnetMissingModalOpen: (open: boolean) => void;

  cursorPosition: EditorCursorInfo | null;
  setCursorPosition: (pos: EditorCursorInfo | null) => void;

  diagnosticCounts: { errors: number; warnings: number };

  lspStatus: LspStatus;
  setLspStatus: (status: LspStatus) => void;
  lspProgress: string | null;
  setLspProgress: (msg: string | null) => void;

  bottomPanelVisible: boolean;
  activeBottomTab: BottomPanelTab;
  toggleBottomPanel: () => void;
  setBottomPanelVisible: (visible: boolean) => void;
  setActiveBottomTab: (tab: BottomPanelTab) => void;

  bottomPanelMaximized: boolean;
  toggleBottomPanelMaximized: () => void;
  setBottomPanelMaximized: (v: boolean) => void;

  settingsOpen: boolean;
  /** Nav section shown by the settings modal; survives close/reopen. */
  settingsSection: string;
  /** Opens the modal, optionally jumping straight to a section. */
  openSettings: (section?: string) => void;
  closeSettings: () => void;
  toggleSettings: () => void;
  setSettingsSection: (section: string) => void;

  /** path → Unity-asset view mode override (absent ⇒ settings default). */
  assetViewerMode: Record<string, AssetViewerMode>;
  setAssetViewerMode: (path: string, mode: AssetViewerMode) => void;

  /**
   * diff-tab path → semantic/text view mode override (absent ⇒ 'semantic'
   * when the tab is a semantic candidate, else 'text'). Also flipped to
   * 'text' automatically when `SceneDiffViewer` fails to render a diff.
   */
  diffViewMode: Record<string, DiffViewMode>;
  setDiffViewMode: (path: string, mode: DiffViewMode) => void;

  /**
   * Source Control file grouping. `'list'` (flat) is the default, matching
   * VS Code's `scm.defaultViewMode`. Lives here rather than in component state
   * so toggling survives the panel unmounting when the sidebar switches views.
   */
  scmViewMode: ScmViewMode;
  setScmViewMode: (mode: ScmViewMode) => void;

  /** uri → source → items */
  diagnostics: DiagnosticsMap;
  /**
   * Publish diagnostics for a specific source.
   * Passing an empty `items` array clears that source for the URI; if all
   * sources for a URI become empty the inner map is removed.
   */
  setFileDiagnostics: (fileUri: string, source: DiagnosticSource, items: DiagnosticItem[]) => void;
  /** Remove all sources for a URI. */
  clearFileDiagnostics: (fileUri: string) => void;
  /** All diagnostics across all URIs and sources, deduped and sorted. */
  getAllDiagnostics: () => DiagnosticItem[];
  /** Flattened diagnostics for a single URI, deduped. */
  getDiagnosticsForUri: (uri: string) => DiagnosticItem[];
}

export const useUiStore = create<UiState>((set, get) => ({
  activeSidebarView: 'explorer',
  setActiveSidebarView: (view) => set({ activeSidebarView: view }),
  sidebarVisible: true,
  toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
  setSidebarVisible: (visible) => set({ sidebarVisible: visible }),

  rightSidebarVisible: false,
  activeRightSidebarView: 'ai-panel',
  toggleRightSidebar: () => set((s) => ({ rightSidebarVisible: !s.rightSidebarVisible })),
  setRightSidebarVisible: (visible) => set({ rightSidebarVisible: visible }),
  setActiveRightSidebarView: (view) => set({ activeRightSidebarView: view }),

  aiPanelMaximized: false,
  toggleAiPanelMaximized: () =>
    set((s) => {
      const next = !s.aiPanelMaximized;
      // Maximizing implicitly opens the panel + switches to AI view, so the
      // shortcut works even when the sidebar is closed or showing another view.
      if (next) {
        return {
          aiPanelMaximized: true,
          rightSidebarVisible: true,
          activeRightSidebarView: 'ai-panel',
        };
      }
      return { aiPanelMaximized: false };
    }),
  setAiPanelMaximized: (v) => set({ aiPanelMaximized: v }),

  graphifyIntroOpen: false,
  setGraphifyIntroOpen: (open) => set({ graphifyIntroOpen: open }),

  dotnetMissingModalOpen: false,
  setDotnetMissingModalOpen: (open) => set({ dotnetMissingModalOpen: open }),

  cursorPosition: null,
  setCursorPosition: (pos) => set({ cursorPosition: pos }),

  diagnosticCounts: { errors: 0, warnings: 0 },

  lspStatus: 'idle',
  setLspStatus: (status) => set({ lspStatus: status }),
  lspProgress: null,
  setLspProgress: (msg) => set({ lspProgress: msg }),

  bottomPanelVisible: false,
  // 'unity-console' is not a valid tab in non-Unity workspaces, so
  // BottomPanel's fallback-to-first-tab logic resolves it to 'terminal'
  // there — while Unity projects (which do have a 'unity-console' tab) keep
  // landing on Unity Console by default, same as before the Terminal tab
  // became available alongside it there.
  activeBottomTab: 'unity-console',
  toggleBottomPanel: () =>
    set((s) => {
      const next = !s.bottomPanelVisible;
      // Hiding the panel always drops maximize state too, so a later reopen
      // (mod+j, the close ✕, or the maximize toggle itself) starts at normal
      // height rather than resuming full-screen.
      return next ? { bottomPanelVisible: true } : { bottomPanelVisible: false, bottomPanelMaximized: false };
    }),
  setBottomPanelVisible: (visible) =>
    set(visible ? { bottomPanelVisible: true } : { bottomPanelVisible: false, bottomPanelMaximized: false }),
  setActiveBottomTab: (tab) => set({ activeBottomTab: tab, bottomPanelVisible: true }),

  bottomPanelMaximized: false,
  toggleBottomPanelMaximized: () =>
    set((s) => {
      const next = !s.bottomPanelMaximized;
      // Maximizing implicitly opens the panel (mirrors toggleAiPanelMaximized's
      // show-on-enter behavior), so the shortcut works even if the bottom
      // panel is currently hidden.
      if (next) {
        return { bottomPanelMaximized: true, bottomPanelVisible: true };
      }
      return { bottomPanelMaximized: false };
    }),
  setBottomPanelMaximized: (v) => set({ bottomPanelMaximized: v }),

  settingsOpen: false,
  // Seeded with the first category so a fresh install lands on real content
  // rather than an empty pane. The modal re-validates this against the live
  // category list, so a value persisted by an older version can't blank it.
  settingsSection: 'Editor',
  openSettings: (section) =>
    set((s) => ({
      settingsOpen: true,
      settingsSection: section ?? s.settingsSection,
    })),
  closeSettings: () => set({ settingsOpen: false }),
  toggleSettings: () => set((s) => ({ settingsOpen: !s.settingsOpen })),
  setSettingsSection: (section) => set({ settingsSection: section }),

  assetViewerMode: {},
  setAssetViewerMode: (path, mode) =>
    set((s) => ({ assetViewerMode: { ...s.assetViewerMode, [path]: mode } })),

  diffViewMode: {},
  setDiffViewMode: (path, mode) =>
    set((s) => ({ diffViewMode: { ...s.diffViewMode, [path]: mode } })),

  scmViewMode: 'list',
  setScmViewMode: (mode) => set({ scmViewMode: mode }),

  diagnostics: new Map(),
  setFileDiagnostics: (fileUri, source, items) => {
    set((state) => {
      const next: DiagnosticsMap = new Map(state.diagnostics);
      const sourceMap = new Map(next.get(fileUri) ?? []);
      if (items.length === 0) {
        sourceMap.delete(source);
      } else {
        sourceMap.set(source, items);
      }
      if (sourceMap.size === 0) {
        next.delete(fileUri);
      } else {
        next.set(fileUri, sourceMap);
      }
      return { diagnostics: next, diagnosticCounts: recomputeCounts(next) };
    });
  },
  clearFileDiagnostics: (fileUri) => {
    set((state) => {
      const next: DiagnosticsMap = new Map(state.diagnostics);
      next.delete(fileUri);
      return { diagnostics: next, diagnosticCounts: recomputeCounts(next) };
    });
  },
  getAllDiagnostics: () => getFlatAllDiagnostics(get().diagnostics),
  getDiagnosticsForUri: (uri) => getFlatDiagnosticsForUri(get().diagnostics, uri),
}));
