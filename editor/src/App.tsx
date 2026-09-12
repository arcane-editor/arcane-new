import { SaveConflictBanner } from './components/SaveConflictBanner';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Allotment, LayoutPriority, type AllotmentHandle } from 'allotment';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import 'allotment/dist/style.css';
import {
  ActivityBar,
  BottomPanel,
  EDITOR_PANE_INDEX,
  KeyboardShortcutManager,
  MIN_EDITOR_WIDTH,
  RightActivityBar,
  RightSidebarPanel,
  ShortcutsHelpModal,
  SidebarPanel,
  StatusBar,
  TabBar,
  TitleBar,
  flushLayoutPersisters,
  initialPaneSizes,
  layoutPersister,
  verticalPersister,
  widthsForRestore,
  CoachMarks,
  applyWebviewZoom,
  clampZoomLevel,
  nextZoomLevel,
} from './features/app-shell';
import { EditorPanel, Breadcrumbs, EditorErrorBoundary } from './features/editor';
import {
  WelcomeScreen,
  ProjectRootBanner,
  openWelcomeWindow,
  openFolderInNewWindow,
  setProjectWindowTitle,
  initialBootSurface,
  consumePendingOpenForWorkspace,
} from './features/project';
import { startUpdateNotices } from './features/updates';
import {
  isAiComposerFocused,
  cycleEffort,
  restoreLatestSessionForWorkspace,
  resetAgentService,
  disposeExternalBackends,
} from './features/ai-panel';
import TooltipHost from './components/TooltipHost';
import {
  focusTerminalById,
  handleTerminalDrop,
  highlightTerminalDropTarget,
  clearTerminalDropTarget,
} from './features/terminal';
import { useAiStore } from './stores/ai';
import { useCheckpointsStore } from './stores/checkpoints';
import { useEditReviewStore } from './stores/edit-review';
import { GraphifyIntroModal, computeBuildOpts, startGraphifyAutoRebuild } from './features/graphify';
import { initAsmdefFeature } from './features/asmdef';
import { initUnityPackagesFeature } from './features/unity-packages';
import { classifyFile, DotnetMissingModal, FilePriority, NewScriptModal } from './features/csharp';
import { useGraphifyStore } from './stores/graphify';
import { ThemePicker, applyTheme } from './features/theme';
import { NotificationContainer } from './features/notifications';
import { SettingsModal, ACCOUNT_SECTION } from './features/settings';
import { PaletteModal } from './features/command-palette';
import { BranchPicker, runGitignoreDoctor } from './features/git';
import { UnityAssetPickerModal, type UnityPickerMode } from './features/unity-quick-open';
import {
  setPendingReveal,
  resolveExplorerDrop,
  highlightExplorerDropTarget,
  clearExplorerDropTarget,
} from './features/explorer';
import {
  clearAiPanelDropTarget,
  highlightAiPanelDropTarget,
  isDropOnAiPanel,
} from './features/ai-panel';
import {
  DESIGN_STAGE_PATHS,
  clearDesignDockDropTarget,
  highlightDesignDockDropTarget,
  isDropOnDesignDock,
} from './features/design-chat';
import { useUnitySceneStore } from './stores/unity-scene';
import { useRegisterCommands } from './hooks/useRegisterCommands';
import { useAutoSave } from './hooks/useAutoSave';
import { useCloseGuard } from './hooks/useCloseGuard';
import { notify, useNotificationsStore } from './stores/notifications';
import { runWorkspaceDiagnostics, resetWorkspaceDiagnostics } from './features/lsp';
import { checkReleaseChannel } from './config/api';
import { useCommandsStore } from './stores/commands';
import { listenScoped } from './utils/tauri-listener';
import { useWorkspaceStore } from './stores/workspace';
import { useSearchStore } from './stores/search';
import { useUiStore } from './stores/ui';
import { useTerminalStore } from './stores/terminal';
import { useGitStore } from './stores/git';
import { useThemeStore } from './stores/theme';
import { useSettingsStore } from './stores/settings';
import { useProjectContextStore } from './stores/project-context';
import { initUnityIndexListeners } from './stores/unity-index';
import { initTestRunner, useTestStore } from './features/unity-test-runner';
import { initUnityTelemetry } from './features/unity-telemetry';
import { useUnityStore } from './stores/unity';
import { useDebugStore } from './stores/debug';
import { useAuthStore } from './stores/auth';
import { useServerConfigStore, allowedEfforts } from './stores/server-config';
import { initConnectivityListeners } from './stores/connectivity';
import { useSceneUsageStore } from './features/unity-context';
import {
  loadState,
  saveState,
  loadLayoutSizes,
  planFileRestore,
  resolveActiveFilePath,
  shouldPersistTab,
} from './utils/persistence';
import { useRecentsStore } from './stores/recents';
import { confirmCloseDirty } from './utils/dirty-guard';
import { showSourceControl } from './utils/source-control-visibility';
import { safeUnlisten } from './utils/tauri-listener';
import { getMonacoInstance } from './utils/monaco-instance';
import {
  installJumpHistory,
  navigateBack,
  navigateForward,
  canNavigateBack,
  canNavigateForward,
} from './utils/jump-history';
import { findUsagesAtCursor, canFindUsages } from './features/references';
import type { Command } from './types';

/**
 * True only while a Monaco text editor actually holds the caret.
 *
 * `commandBeatsShell` (app-shell/skip-shell.ts) lets any chord that is not a
 * bare Ctrl+letter fire on Windows/Linux even with the terminal focused, so a
 * command whose chord is plain text elsewhere — `alt+enter` — needs this guard
 * rather than the usual `!!activeFilePath`.
 */
function isTextEditorFocused(): boolean {
  const monaco = getMonacoInstance();
  return (monaco?.editor.getEditors() ?? []).some((e) => e.hasTextFocus());
}

/**
 * True while a Search tab is the active editor tab.
 *
 * The three find toggles are bare `alt+<letter>` chords, and
 * KeyboardShortcutManager runs with enableOnFormTags/enableOnContentEditable,
 * so without a gate they would fire — and preventDefault — inside every text
 * field in the app. Asking the search store instead would not work: its
 * default session always exists (search.ts seeds one), so it can never
 * answer "no". The `search://` scheme is how `search.openTab` identifies
 * its own tab, so it is the honest signal here too.
 */
function searchTabIsActive(): boolean {
  return !!useWorkspaceStore.getState().activeFilePath?.startsWith('search://');
}

/** The editor selection, when the seed setting allows it. Returns '' when
 *  there is nothing to seed with, so callers can treat it as falsy. */
function selectionSeedQuery(): string {
  const mode = useSettingsStore.getState().settings['search.seedQueryFromCursor'];
  if (mode === 'never') return '';

  // There is no "active editor" accessor in this codebase; Monaco's own
  // registry is the source of truth. Prefer the focused editor, falling back
  // to the only one open.
  const monaco = getMonacoInstance();
  const editors = monaco?.editor.getEditors() ?? [];
  const editor = editors.find((e) => e.hasTextFocus()) ?? editors[0];
  const selection = editor?.getSelection();
  const model = editor?.getModel();
  if (!editor || !selection || !model) return '';

  if (selection.isEmpty()) {
    if (mode !== 'always') return '';
    const position = editor.getPosition();
    if (!position) return '';
    return model.getWordAtPosition(position)?.word ?? '';
  }
  // A multi-line selection is a range to search within, not a query — Zed
  // treats it that way too. Seeding with it would produce a query that
  // matches nothing.
  if (selection.startLineNumber !== selection.endLineNumber) return '';
  return model.getValueInRange(selection);
}

/**
 * Apply a window zoom level and remember it.
 *
 * Persisting and applying together, rather than applying and letting a
 * subscriber persist, keeps the two from drifting: the setting is the record
 * of what the webview was last told, so the restore on next launch cannot
 * disagree with what the user sees now. That only holds if both are handed the
 * *same* number, hence clamping here rather than relying on `applyWebviewZoom`
 * to clamp on its way to the webview and storing the raw value beside it.
 */
function setZoomLevel(level: number): void {
  const settings = useSettingsStore.getState();
  const next = clampZoomLevel(level);
  // `setSetting` writes the whole settings file, and zoom is the one chord a
  // user holds down — at a bound every repeat would otherwise re-persist a
  // value that did not change, once per key repeat.
  if (settings.getSetting('window.zoomLevel') === next) return;
  settings.setSetting('window.zoomLevel', next);
  void applyWebviewZoom(next);
}

/** Step the current zoom level by `delta`, saturating at the bounds. */
function stepZoom(delta: number): void {
  const current = useSettingsStore.getState().getSetting('window.zoomLevel');
  setZoomLevel(nextZoomLevel(current, delta));
}

/**
 * Advance the AI mode Ask → Agent → Plan → Ask, and make sure the panel is
 * showing so the change is visible.
 *
 * Shared by `ai.cycleMode` and the Cmd+M route below, so the two cannot
 * disagree about the order or about the mid-run guard — cycling under a
 * running agent would swap the toolset out from under it, which is why
 * `ModeSelector` disables itself then too.
 */
function cycleAiMode(): void {
  const ai = useAiStore.getState();
  if (ai.isAgentRunning) return;
  // Mode belongs to the UnityIDE loop. Under an external agent the pill it
  // cycles isn't even rendered (AgentConfigBar takes that slot), so firing
  // would silently change a hidden value that nothing reads.
  if (ai.selectedAgent !== 'hosted') return;
  // Design is deliberately absent: it is entered from the design dock on a
  // .uxml, never cycled into from a keyboard chord with no document in sight.
  // Cycling out of it is allowed, and lands on Ask.
  const order: Array<'ask' | 'agent' | 'plan'> = ['ask', 'agent', 'plan'];
  const at = order.indexOf(ai.mode as 'ask' | 'agent' | 'plan');
  ai.setMode(order[(at + 1) % order.length]);
  useUiStore.getState().setActiveRightSidebarView('ai-panel');
  useUiStore.getState().setRightSidebarVisible(true);
}

/**
 * Cycle reasoning effort one level, wrapping at the top.
 *
 * Goes through the SAME allow-list the pill uses (`allowedEfforts`), so the
 * chord can never land on a tier the plan cannot request even though the pill
 * is not what fired it — cycling into a locked level would send the next turn
 * straight into a 403. No-op mid-run, like the pill.
 */
function cycleEffortCommand(): void {
  const ai = useAiStore.getState();
  if (ai.isAgentRunning) return;
  // Same reason as `cycleAiMode`: effort is a UnityIDE request parameter, and
  // an external agent exposes its own via session config options instead.
  if (ai.selectedAgent !== 'hosted') return;
  const config = useServerConfigStore.getState().config;
  const plan = useAuthStore.getState().plan;
  ai.setEffort(cycleEffort(ai.effort, allowedEfforts(config, plan)));
}

function App() {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const activeFilePath = useWorkspaceStore((s) => s.activeFilePath);
  const sidebarVisible = useUiStore((s) => s.sidebarVisible);
  const rightSidebarVisible = useUiStore((s) => s.rightSidebarVisible);
  const bottomPanelVisible = useUiStore((s) => s.bottomPanelVisible);
  const aiPanelMaximized = useUiStore((s) => s.aiPanelMaximized);
  const graphifyIntroOpen = useUiStore((s) => s.graphifyIntroOpen);
  const setGraphifyIntroOpen = useUiStore((s) => s.setGraphifyIntroOpen);
  const dotnetMissingModal = useUiStore((s) => s.dotnetMissingModal);
  const setDotnetMissingModal = useUiStore((s) => s.setDotnetMissingModal);
  const restoredRef = useRef(false);
  const [showThemePicker, setShowThemePicker] = useState(false);
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false);
  const [paletteMode, setPaletteMode] = useState<'commands' | 'files' | 'symbols' | 'recent' | null>(null);
  const [branchPickerMode, setBranchPickerMode] = useState<'switch' | 'create' | null>(null);
  const [unityPicker, setUnityPicker] = useState<UnityPickerMode | null>(null);
  const [newScriptDir, setNewScriptDir] = useState<string | null>(null);
  const persistedLayout = useMemo(() => loadLayoutSizes(), []);
  // Suppresses the "no folder open" WelcomeScreen for the gap between first
  // paint and the mount-effect restore below settling. Without it, every
  // window opened with `?path=` flashes "Open a folder to get started"
  // before the project renders — see `boot-gate` for the full rationale.
  // `loadState()` is safe to read during render: main.tsx awaits
  // `hydratePersistence()` before mounting App, so this initializer and the
  // effect below observe the same persisted state.
  const [bootSurface, setBootSurface] = useState(() =>
    initialBootSurface(new URLSearchParams(location.search).get('path'), loadState()?.workspacePath),
  );
  // Name of the project being restored, for the boot shell's delayed label.
  // Paths reach the frontend `/`-separated (src-tauri/src/path_util.rs), so
  // this basename is correct on Windows too.
  const bootProjectName = useMemo(() => {
    const path = new URLSearchParams(location.search).get('path') ?? loadState()?.workspacePath;
    return path ? (path.split('/').filter(Boolean).pop() ?? null) : null;
  }, []);
  // Initial horizontal split: each side pane defaults to 30% of the window on
  // first open (editor takes the rest); persisted drags win. Arithmetic lives
  // in layout-sizes.ts so it can be unit-tested — see that module for why the
  // implausible-value cap is 80% rather than the 45% that used to discard a
  // deliberately wide sidebar on every launch.
  const initialLayout = useMemo(() => {
    const w = typeof window !== 'undefined' ? window.innerWidth : 1280;
    return initialPaneSizes(persistedLayout, w);
  }, [persistedLayout]);

  const allotmentRef = useRef<AllotmentHandle>(null);

  // Live pane sizes, as last reported by Allotment. Kept in a ref rather than
  // state so a drag doesn't re-render the whole shell on every frame.
  const currentSizesRef = useRef<number[]>(initialLayout.sizes);

  // Width each side pane had the last time it was *visible*.
  const liveWidthsRef = useRef({
    sidebar: initialLayout.left,
    rightPanel: initialLayout.right,
  });

  // Width to reopen each side pane at, snapshotted when it was last hidden.
  //
  // Separate from liveWidthsRef on purpose: on a show, Allotment's onChange
  // fires before this component's layout effect, so a single ref would already
  // have been overwritten with whatever width the pane came back at — which is
  // the value we are trying to correct.
  const restoreWidthsRef = useRef({
    sidebar: initialLayout.left,
    rightPanel: initialLayout.right,
  });

  const prevShownRef = useRef({ sidebar: sidebarVisible, rightPanel: rightSidebarVisible });

  // layoutPersister/verticalPersister are module-level singletons (see
  // layout-persist.ts), not per-render values — <App/> is never unmounted
  // while its window is open, so a useEffect cleanup here would never run at
  // quit. They're flushed from useCloseGuard's onCloseRequested and the
  // beforeunload handler below instead.

  // Reads visibility from the store rather than a closure. Allotment rebinds
  // `onDidChange` in a passive effect, which always runs after this commit's
  // layout effects — so a layout-effect-timed visibility flip fires whichever
  // callback was bound *before* this render, no matter how that callback's
  // own dependency array is written. getState() is the only visibility read
  // that is guaranteed current at that moment.
  const onLayoutChange = useCallback((sizes: number[]) => {
    currentSizesRef.current = sizes;
    const ui = useUiStore.getState();

    // Record each side's width only while it is actually shown (>0), so a
    // hidden pane keeps its last width instead of recording 0.
    const next: { sidebar?: number; rightPanel?: number } = {};
    if (ui.sidebarVisible && sizes[0] > 0) {
      liveWidthsRef.current.sidebar = sizes[0];
      next.sidebar = sizes[0];
    }
    const last = sizes[sizes.length - 1];
    if (ui.rightSidebarVisible && sizes.length >= 3 && last > 0) {
      liveWidthsRef.current.rightPanel = last;
      next.rightPanel = last;
    }
    if (next.sidebar !== undefined || next.rightPanel !== undefined) {
      layoutPersister.persist(next);
    }
  }, []);

  const onVerticalLayoutChange = useCallback(
    (sizes: number[]) => verticalPersister.persist(sizes),
    [],
  );

  // Reopen a side pane at the width it was dragged to.
  //
  // Allotment caches a hidden pane's size and is supposed to restore it, but
  // the width does not reliably come back. Rather than depend on that implicit
  // cache, drive the restore explicitly. useLayoutEffect, not useEffect: React
  // runs child layout effects first, so Allotment has already made the pane
  // visible by now, and committing the correct width here means no frame ever
  // paints at the wrong one.
  useLayoutEffect(() => {
    const prev = prevShownRef.current;
    prevShownRef.current = { sidebar: sidebarVisible, rightPanel: rightSidebarVisible };

    // Going hidden: snapshot the width to come back at. liveWidthsRef is still
    // the pre-hide width — the onChange that just fired reported 0 for this
    // pane and its `>0` guard refused to record it.
    if (prev.sidebar && !sidebarVisible) {
      restoreWidthsRef.current.sidebar = liveWidthsRef.current.sidebar;
    }
    if (prev.rightPanel && !rightSidebarVisible) {
      restoreWidthsRef.current.rightPanel = liveWidthsRef.current.rightPanel;
    }

    const handle = allotmentRef.current;
    if (!handle) return;

    // Two independent blocks, not if/else if — mirrors the two separate `if`s
    // above so a same-commit double show (both panes hidden -> visible at
    // once) restores both instead of silently dropping the second. Each call
    // reads currentSizesRef.current fresh rather than a hoisted local:
    // handle.resize() re-enters onLayoutChange synchronously, which updates
    // currentSizesRef.current before the next widthsForRestore call below
    // runs. Reading a value captured earlier would compute the second
    // correction against the pre-first-resize sizes and clobber it.
    if (!prev.sidebar && sidebarVisible) {
      handle.resize(
        widthsForRestore(
          currentSizesRef.current,
          0,
          restoreWidthsRef.current.sidebar,
          EDITOR_PANE_INDEX,
          MIN_EDITOR_WIDTH,
        ),
      );
    }
    if (!prev.rightPanel && rightSidebarVisible) {
      handle.resize(
        widthsForRestore(
          currentSizesRef.current,
          currentSizesRef.current.length - 1,
          restoreWidthsRef.current.rightPanel,
          EDITOR_PANE_INDEX,
          MIN_EDITOR_WIDTH,
        ),
      );
    }
  }, [sidebarVisible, rightSidebarVisible]);

  // Sticky toast when the Rust watcher stages an update. Scheduling lives in
  // Rust (one process); this is only the surface.
  useEffect(() => {
    // Returns an unlisten fn; the promise resolves after mount, so cleanup
    // has to chain rather than return it directly.
    const pending = startUpdateNotices();
    return () => {
      void pending.then((un) => un());
    };
  }, []);

  // Restore persisted state on mount
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;

    // Reap any PTYs left running by this window's
    // previous incarnation. TerminalState lives in the Rust process and is
    // keyed by window label, so a webview reload (Cmd+R) — which resets the
    // frontend terminal store but doesn't touch the backend — would
    // otherwise orphan every shell from before the reload. Must run before
    // anything below can create a terminal for the new incarnation
    // (workspacePath is still null at this point, so nothing has yet); a
    // no-op on first launch since there's no prior slot for this label.
    void invoke('terminal_reset_window');
    // Same reasoning for external agents: an ACP subprocess is keyed by window
    // label in the Rust process, so a webview reload leaves the previous
    // incarnation's agent running with nobody listening to its stdout.
    void invoke('acp_reset_window');

    // Zoom is applied only once settings are on disk-read, not from the
    // default: the webview starts at 1.0, so restoring a persisted level is
    // the only thing that makes a zoomed window come back zoomed.
    void useSettingsStore
      .getState()
      .loadSettings()
      .then(() => {
        void applyWebviewZoom(useSettingsStore.getState().getSetting('window.zoomLevel'));
      });
    useAuthStore.getState().loadFromDisk();
    // If the OS launched this window with an auth deep link, finish that
    // sign-in (or re-initiate when there's nothing to match it). Runs after
    // loadFromDisk so an already-valid session is in place first — a signed-in
    // user who clicks an old callback link just no-ops.
    void useAuthStore.getState().resumeColdStartLogin();
    void useRecentsStore.getState().reload();
    // Watch agent activity → auto-rebuild the codebase graph after turns that
    // mutated files. Only fires when a graph already exists.
    startGraphifyAutoRebuild();
    // Asmdef awareness (owning-assembly status item + missing-reference quick
    // fix). Internally inert for non-Unity projects; self-gates on isUnityProject.
    initAsmdefFeature();
    // Unity Packages/manifest.json intelligence (completion/hover/version hints)
    // + PackageCache read-only banner. Self-gates on isUnityProject + setting.
    initUnityPackagesFeature();
    // Unity GUID / reverse-reference index listeners (build progress +
    // incremental delta on file changes). The build itself is kicked off from
    // project-context.applyDetection when a Unity project opens. Listeners are
    // idempotent and inert for non-Unity projects.
    initUnityIndexListeners();
    // Unity Test Runner: wire the live `unity-test-event` stream into the test
    // store. Idempotent; inert until events arrive.
    initTestRunner();
    // Unity play-mode telemetry stream (opt-in display; F-4.5).
    initUnityTelemetry();

    const params = new URLSearchParams(location.search);
    const urlPath = params.get('path');
    const persisted = loadState();
    const workspacePath = urlPath ?? persisted?.workspacePath ?? null;

    if (workspacePath) {
      const store = useWorkspaceStore.getState();
      store.setWorkspace(workspacePath).then(async () => {
        if (urlPath || workspacePath === persisted?.workspacePath) {
          // Seed the MRU BEFORE the tabs reopen. `setWorkspace` clears it, and
          // reopening tabs below re-visits each one — without the seed the
          // list would come back as tab order, which is what it is not.
          if (persisted?.recentFiles?.length) {
            useWorkspaceStore.setState({ recentFiles: persisted.recentFiles });
          }
          const restoredPaths: string[] = [];
          for (const file of persisted?.openFilePaths ?? []) {
            try {
              const plan = planFileRestore(file);
              // Diff tabs refetch their content from git, so restoring them
              // is never stale even across reloads; falls back to a plain
              // file open for old-shape entries with no `diff` field, and
              // tolerates missing/malformed git state the same way a
              // deleted file is tolerated below.
              if (plan.kind === 'diff') {
                await store.openDiffTab(plan.filePath, plan.name, plan.staged);
              } else {
                await store.openFile(plan.path, plan.name);
              }
              // Read back the path actually assigned to the new tab (rather
              // than re-deriving diff:// formatting here) so this stays in
              // sync with openDiffTab/openFile's own path shape.
              const current = useWorkspaceStore.getState().activeFilePath;
              if (current) restoredPaths.push(current);
            } catch {
              // File may have been deleted, or git state unavailable — skip
            }
          }
          // Only honor the persisted active path if that tab actually
          // restored; otherwise fall back to the last tab that did (or leave
          // activeFilePath alone if nothing restored) so a stale active
          // pointer never leaves the editor showing a blank WelcomeScreen.
          const activeToSet = resolveActiveFilePath(persisted?.activeFilePath, restoredPaths);
          if (activeToSet) {
            store.setActiveFile(activeToSet);
          }
        }
        // Announce which project this window owns, so the single-instance
        // handler can route a later launch straight here and raise THIS
        // window instead of putting the welcome panel in front of it. After
        // setWorkspace, never before: a window that is still booting cannot
        // serve a request, and registering early would route one to a window
        // that then fails to open the project.
        try {
          await invoke('register_window_workspace', { workspacePath });
        } catch {
          // Only costs us the direct route; the welcome window still relays.
        }
        // Unity's request lands last, so it wins over the restored active tab:
        // the user double-clicked a specific script and that is what they are
        // waiting to see. The claim is conditional on the Rust side, so a
        // request belonging to another project stays pending for the window
        // that owns it.
        await consumePendingOpenForWorkspace(workspacePath);
      }).catch((err) => {
        // setWorkspace's own catch already surfaces a user-facing toast
        // (path + "moved or deleted" hint) before rethrowing — this handler
        // only needs to keep the rejection from becoming unhandled.
        console.error('[App] Failed to restore workspace:', err);
      }).finally(() => {
        // Drop the boot gate either way: on success `workspacePath` is set
        // and the project renders, on failure the user needs the
        // WelcomeScreen (with its Open Folder button) rather than a shell
        // that never resolves.
        setBootSurface('welcome');
      });
    } else {
      setBootSurface('welcome');
    }
  }, []);

  // Connectivity signal for inline suggestions (and future offline gating):
  // window online/offline events + a 30s navigator.onLine re-sync.
  useEffect(() => initConnectivityListeners(), []);

  // Set window title from workspace path
  useEffect(() => {
    setProjectWindowTitle(workspacePath ?? null);
  }, [workspacePath]);

  // Refuse to run silently with mismatched halves of "dev-ness": dev endpoints
  // under the production identifier write dev-API tokens into ~/.unityide, which
  // the real app then presents to the production API.
  useEffect(() => {
    void checkReleaseChannel(invoke).then((problem) => {
      if (!problem) return;
      useNotificationsStore
        .getState()
        .addNotification({ type: 'error', message: problem, persistent: true });
    });
  }, []);

  // Jump history: hook `setPendingNavigation` so every cross-file jump records
  // where it came from. Idempotent — it installs a single module-level listener.
  useEffect(() => {
    installJumpHistory();
  }, []);

  // Auto-save hook
  useAutoSave();

  // Unsaved-changes prompt on window close
  useCloseGuard();

  // Restore the latest chat session for the active workspace, and re-restore on
  // workspace switch. Driven from App level (not the toggle-able AI panel) so
  // opening/closing the right sidebar never re-triggers a restore.
  useEffect(() => {
    let prevPath = useWorkspaceStore.getState().workspacePath;
    if (prevPath) void restoreLatestSessionForWorkspace(prevPath);

    const unsub = useWorkspaceStore.subscribe((state) => {
      const next = state.workspacePath;
      if (next === prevPath) return;
      prevPath = next;
      // Kill the OLD workspace's agent first: a still-running turn kept
      // writing the old project's files while its events streamed into the
      // new project's blank transcript (dispose aborts the loop and
      // unsubscribes its store feed). resetConversation alone never touches
      // the agent — it even sets isAgentRunning:false while one still runs.
      resetAgentService();
      // External agents get the same treatment, and need it more: an ACP
      // session's cwd is fixed when the session is created and cannot be
      // moved, so a surviving subprocess would answer the new project's
      // prompts with the old project's files.
      void disposeExternalBackends();
      // Drop the previous workspace's transcript, then load the new one's.
      useAiStore.getState().resetConversation();
      if (next) void restoreLatestSessionForWorkspace(next);
    });
    return unsub;
  }, []);

  // Best-effort flush of the chat session (and its checkpoints/edit-reviews),
  // and any pending layout-size write, on reload/navigation (can't await).
  useEffect(() => {
    const onBeforeUnload = () => {
      void useAiStore.getState().flushSessionNow();
      void useCheckpointsStore.getState().flushCheckpointsNow();
      void useEditReviewStore.getState().flushNow();
      void flushLayoutPersisters();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  // Native menu (macOS): bridge menu-action events to the command registry
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const fn = await listenScoped<string>('menu-action', (event) => {
        useCommandsStore.getState().executeCommand(event.payload);
      });
      if (cancelled) safeUnlisten(fn);
      else unlisten = fn;
    })();
    return () => {
      cancelled = true;
      safeUnlisten(unlisten);
    };
  }, []);

  // Unity re-launching an already-running app: the single-instance handler
  // stores the request and emits this. It targets this window directly when the
  // registry knows we own the project, and goes to every window otherwise; the
  // Rust side only hands the request to the one whose workspace matches, so
  // exactly one window acts on it and the rest are no-ops.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const fn = await listenScoped('unityide-open-pending', () => {
        void consumePendingOpenForWorkspace(useWorkspaceStore.getState().workspacePath);
      });
      if (cancelled) safeUnlisten(fn);
      else unlisten = fn;
    })();
    return () => {
      cancelled = true;
      safeUnlisten(unlisten);
    };
  }, []);

  // Cross-window auth sync (spec C3): any window that completes a login or
  // logout emits 'auth-changed'; every window — emitter included, harmlessly —
  // re-reads token state from disk. Closes the pre-existing "window B stale
  // after login in window A" gap. listenScoped: receives global emit() plus
  // emit_to(ownLabel) only (no cross-window crosstalk).
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const fn = await listenScoped('auth-changed', () => {
        void useAuthStore.getState().loadFromDisk();
      });
      if (cancelled) safeUnlisten(fn);
      else unlisten = fn;
    })();
    return () => {
      cancelled = true;
      safeUnlisten(unlisten);
    };
  }, []);

  // LSP error: brief, language-agnostic toast. The status-bar "LSP: Error"
  // badge is the persistent indicator; this toast just surfaces the action
  // once and fades. After dismissal, restart is reachable via the palette
  // ("Restart Language Server").
  useEffect(() => {
    const unsub = useUiStore.subscribe((state, prev) => {
      if (state.lspStatus === 'error' && prev.lspStatus !== 'error') {
        useNotificationsStore.getState().addNotification({
          type: 'warning',
          message: 'Language server unavailable — see status bar for details.',
          actions: [
            {
              label: 'Restart',
              run: () => {
                useWorkspaceStore.getState().restartLsp();
              },
            },
          ],
        });
      }
    });
    return unsub;
  }, []);

  // Refresh git status on window focus
  useEffect(() => {
    function handleFocus() {
      const wp = useWorkspaceStore.getState().workspacePath;
      if (wp) {
        useGitStore.getState().refreshStatus(wp);
      }
    }
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, []);

  // Files dragged in from the OS file manager: dropped on a terminal they get
  // typed in as a path (VS Code's behaviour, and the only way to hand an image
  // to a TUI), anywhere else they open as editor tabs.
  //
  // This handler must hit-test by hand. Tauri intercepts OS file drops at the
  // native layer (`dragDropEnabled` defaults to true), so HTML5 dragover/drop
  // never fire in the webview and no element can own its own drop zone — this
  // one window-level handler is the only place a drop is observable, and it
  // gets a bare coordinate rather than a target.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const win = getCurrentWindow();
      const fn = await win.onDragDropEvent(async (event) => {
        if (event.payload.type === 'enter' || event.payload.type === 'over') {
          highlightTerminalDropTarget(event.payload.position);
          highlightExplorerDropTarget(event.payload.position);
          highlightAiPanelDropTarget(event.payload.position);
          highlightDesignDockDropTarget(event.payload.position);
          return;
        }
        if (event.payload.type === 'leave') {
          clearTerminalDropTarget();
          clearExplorerDropTarget();
          clearAiPanelDropTarget();
          clearDesignDockDropTarget();
          return;
        }

        const paths = event.payload.paths;
        clearExplorerDropTarget();
        clearAiPanelDropTarget();
        clearDesignDockDropTarget();
        if (await handleTerminalDrop(event.payload.position, paths)) return;

        // Dropped on the AI panel: stage as chat context rather than opening
        // editor tabs. Checked ahead of the explorer and of the open-as-tab
        // fallback at the bottom, because the panel is the most specific target
        // under the cursor — that fallback is what every OS drop did until now,
        // and it is why dragging a file from Finder onto the chat opened it in
        // the editor instead of attaching it.
        // Checked BEFORE the AI panel: the design dock floats over the canvas,
        // so it is the more specific target wherever both could match, and a
        // reference image dropped on the dock is meant for the screen you are
        // looking at rather than for whatever thread the panel is showing.
        if (isDropOnDesignDock(event.payload.position)) {
          window.dispatchEvent(new CustomEvent(DESIGN_STAGE_PATHS, { detail: { paths } }));
          return;
        }

        if (isDropOnAiPanel(event.payload.position)) {
          window.dispatchEvent(new CustomEvent('ai-stage-paths', { detail: { paths } }));
          return;
        }

        // Dropped on the file tree: copy into the folder under the cursor.
        // The explorer owns the rest (the Unity .meta question, the copy
        // itself), so this only resolves the target and hands off — same
        // reason the reveal flow goes through an event.
        {
          const ws0 = useWorkspaceStore.getState();
          const treeRoot = ws0.assetsRootPath ?? ws0.workspacePath;
          if (treeRoot) {
            const req = resolveExplorerDrop(event.payload.position, paths, treeRoot);
            if (req) {
              window.dispatchEvent(new CustomEvent('explorer-drop', { detail: req }));
              return;
            }
          }
        }

        const ws = useWorkspaceStore.getState();
        for (const path of paths) {
          const name = path.split('/').pop() ?? path;
          try {
            await ws.openFile(path, name);
          } catch {
            // Likely a directory or unreadable file — skip silently.
          }
        }
      });
      if (cancelled) safeUnlisten(fn);
      else unlisten = fn;
    })();
    return () => {
      cancelled = true;
      clearTerminalDropTarget();
      safeUnlisten(unlisten);
    };
  }, []);

  // Apply initial theme (full application including Monaco/terminal)
  useEffect(() => {
    const theme = useThemeStore.getState().getActiveTheme();
    applyTheme(theme);
  }, []);

  // Persist state on changes (debounced)
  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const unsub = useWorkspaceStore.subscribe((state) => {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => {
        saveState({
          workspacePath: state.workspacePath,
          // Staged/unstaged diff:// tabs are persisted too (content is
          // refetched from git on restore, so it's never stale) — auth://
          // tabs and diff://commit/... tabs are excluded (see
          // `shouldPersistTab`: commit-diff tabs have no restore shape and
          // must never round-trip through PersistedOpenFile.diff).
          openFilePaths: state.openFiles
            .filter((f) => shouldPersistTab(f.path))
            .map((f) => ({
              path: f.path,
              name: f.name,
              ...(f.diff ? { diff: { filePath: f.diff.filePath, staged: f.diff.staged } } : {}),
            })),
          activeFilePath: state.activeFilePath?.startsWith('auth://') ? null : state.activeFilePath,
          // Recent Files is worth nothing if it empties on restart, so it
          // rides along with the tab list rather than being session-only.
          recentFiles: state.recentFiles,
        });
      }, 1000);
    });
    return () => {
      unsub();
      if (timeout) clearTimeout(timeout);
    };
  }, []);

  // Register core commands
  const commands = useMemo<Command[]>(() => [
    {
      id: 'terminal.toggle',
      label: 'Toggle Terminal',
      category: 'Terminal',
      // mod+j, not mod+`: this is the command that also spawns the first
      // terminal, and mod+j is the chord users reach for (signpost.ts:14
      // documents the reverse confusion this replaces). On Linux/Windows,
      // Ctrl+J is xterm's default encoding for LF — TerminalInstance's
      // attachCustomKeyEventHandler is what actually stops that, by telling
      // xterm to swallow the keystroke while a terminal has focus, so only
      // this command sees it. COMMANDS_TO_SKIP_SHELL (skip-shell.ts) is a
      // separate, narrower thing: it only decides whether this command's
      // handler fires while a terminal has focus, not whether xterm hands
      // the shell a byte first.
      keybinding: 'mod+j',
      // mod+` is what every other editor uses for this and what our own
      // published docs have always claimed, so it answers here too. Not a
      // legacy alias — it was never bound before — and only `keybinding` is
      // advertised or mirrored into menu.rs.
      extraKeybindings: ['mod+backquote'],
      handler: () => {
        const ui = useUiStore.getState();
        const wasVisible = ui.bottomPanelVisible;
        ui.toggleBottomPanel();
        // Deliberately does NOT spawn. RichTerminalPanel auto-spawns on reveal
        // and is the single owner of that; both doing it meant one keypress
        // produced two shells, because terminal_spawn is async and each saw an
        // empty list. Revealing the panel is enough.
        if (!wasVisible) ui.setActiveBottomTab('terminal');
      },
    },
    {
      id: 'terminal.new',
      label: 'New Terminal',
      category: 'Terminal',
      // Named physical-key token, not the literal character, for the same
      // reason terminal.split spells its chord `backslash` below:
      // react-hotkeys-hook v5 matches on `event.code`, and 'Backquote'
      // normalizes to "backquote" — a literal ` can never equal it, so this
      // chord never fired at all until it was spelled this way.
      keybinding: 'mod+shift+backquote',
      handler: () => {
        const wp = useWorkspaceStore.getState().workspacePath;
        if (wp) {
          useTerminalStore.getState().createTerminal(wp);
          useUiStore.getState().setBottomPanelVisible(true);
        }
      },
    },
    {
      id: 'terminal.split',
      label: 'Split Terminal',
      category: 'Terminal',
      // VS Code parity; verified free (grep across App.tsx keybindings).
      // NOTE: named physical-key token, not the literal character —
      // react-hotkeys-hook v5 matches on `event.code` ("Backslash"
      // normalizes to "backslash"; a literal `\` token can never match it),
      // and parseHotkeyToMonaco's NAMED_KEYS maps the same word for the
      // Monaco bridge. Same for the two bracket bindings below.
      keybinding: 'mod+backslash',
      handler: () => {
        const ui = useUiStore.getState();
        ui.setBottomPanelVisible(true);
        ui.setActiveBottomTab('terminal');

        const termStore = useTerminalStore.getState();
        const activeId = termStore.activeTerminalId;
        if (activeId === null) {
          // Nothing to split from yet — fall back to a plain new terminal,
          // same as the "New Terminal" command.
          const wp = useWorkspaceStore.getState().workspacePath;
          if (wp) termStore.createTerminal(wp);
          return;
        }
        termStore.splitTerminal(activeId).then((newId) => {
          // A same-group split doesn't change `activeGroupId`, so
          // RichTerminalPanel's tab-switch focus effect won't fire for it —
          // move real keyboard focus into the new pane directly here.
          if (newId !== null) focusTerminalById(newId);
        });
      },
    },
    {
      id: 'terminal.focusNextPane',
      label: 'Focus Next Terminal Pane',
      category: 'Terminal',
      keybinding: 'mod+shift+bracketright',
      // Not bridged into Monaco: on non-mac, mod+shift+[ / ] are Monaco's
      // own fold/unfold defaults, and an editor.addCommand keybinding
      // consumes the keystroke even when our `when()` returns false — the
      // guard only skips the handler, it can't give the key back to Monaco.
      // These commands are terminal-focused-only anyway; the document-level
      // hotkey (KeyboardShortcutManager) covers that fully.
      skipMonacoBridge: true,
      handler: () => {
        useTerminalStore.getState().focusSiblingPane(1);
        const id = useTerminalStore.getState().activeTerminalId;
        if (id !== null) focusTerminalById(id);
      },
      // Inert unless the bottom panel is visible on the Terminal tab AND the
      // active group actually has more than one pane to cycle between —
      // otherwise (e.g. Unity Console active) this would silently mutate
      // hidden pane focus.
      when: () => {
        const ui = useUiStore.getState();
        if (!ui.bottomPanelVisible || ui.activeBottomTab !== 'terminal') return false;
        const termStore = useTerminalStore.getState();
        const group = termStore.groups.find((g) => g.id === termStore.activeGroupId);
        return !!group && group.terminalIds.length > 1;
      },
    },
    {
      id: 'terminal.focusPreviousPane',
      label: 'Focus Previous Terminal Pane',
      category: 'Terminal',
      keybinding: 'mod+shift+bracketleft',
      // See focusNextPane: keeps Monaco's non-mac fold default reachable.
      skipMonacoBridge: true,
      handler: () => {
        useTerminalStore.getState().focusSiblingPane(-1);
        const id = useTerminalStore.getState().activeTerminalId;
        if (id !== null) focusTerminalById(id);
      },
      when: () => {
        const ui = useUiStore.getState();
        if (!ui.bottomPanelVisible || ui.activeBottomTab !== 'terminal') return false;
        const termStore = useTerminalStore.getState();
        const group = termStore.groups.find((g) => g.id === termStore.activeGroupId);
        return !!group && group.terminalIds.length > 1;
      },
    },
    {
      id: 'theme.openPicker',
      label: 'Color Theme',
      category: 'Preferences',
      // Note: Cmd+Shift+T is the standard reopen-closed-tab shortcut, so the
      // theme picker is palette-only. Open via Cmd+Shift+P → "Color Theme".
      handler: () => setShowThemePicker((prev) => !prev),
    },
    {
      id: 'file.openFolder',
      label: 'Open Folder',
      category: 'File',
      keybinding: 'mod+o',
      handler: () => {
        // The dir_exists throw fires before any new window exists, so this
        // window's toast is the only user-visible feedback on failure.
        openFolderInNewWindow().catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          notify.error(`Couldn't open folder — it may have been moved or deleted. (${msg})`);
        });
      },
    },
    {
      id: 'file.newWindow',
      label: 'New Window',
      category: 'File',
      keybinding: 'mod+shift+n',
      handler: () => { openWelcomeWindow(); },
    },
    {
      id: 'file.openRecent',
      label: 'Open Recent…',
      category: 'File',
      handler: () => { openWelcomeWindow(); },
    },
    {
      id: 'lsp.restart',
      label: 'Restart Language Server',
      category: 'View',
      handler: () => {
        useWorkspaceStore.getState().restartLsp();
        // Result ids belong to the process that issued them; a restarted
        // server would answer 'unchanged' for files it has never analysed.
        resetWorkspaceDiagnostics();
      },
      when: () => !!useWorkspaceStore.getState().workspacePath,
    },
    {
      id: 'lsp.analyzeSolution',
      label: 'Analyze Whole Solution',
      category: 'View',
      handler: async () => {
        const res = await runWorkspaceDiagnostics().catch((err) => {
          notify.error(`Solution analysis failed: ${String(err)}`);
          return null;
        });
        if (!res) return;
        if (!res.ran) {
          notify.warning(`Solution analysis did not run — ${res.reason}`);
          return;
        }
        const problems = res.errors + res.warnings;
        notify.info(
          problems === 0
            ? `No problems found across ${res.filesReported} files.`
            : `${res.errors} error(s), ${res.warnings} warning(s) in ${res.filesReported} files` +
              (res.truncated ? ' (list truncated)' : ''),
        );
      },
      when: () => !!useWorkspaceStore.getState().workspacePath,
    },
    {
      id: 'file.save',
      label: 'Save File',
      category: 'File',
      keybinding: 'mod+s',
      handler: () => {
        const activePath = useWorkspaceStore.getState().activeFilePath;
        if (activePath?.startsWith('search://')) {
          // A results tab has no single active file. Save exactly the files it
          // edited — a file left dirty for unrelated reasons is not swept in.
          window.dispatchEvent(
            new CustomEvent('search-save-all', { detail: { sessionId: activePath } }),
          );
          return;
        }
        if (activePath) void useWorkspaceStore.getState().saveFile(activePath);
      },
      when: () => !!useWorkspaceStore.getState().activeFilePath,
    },
    {
      id: 'file.closeTab',
      label: 'Close Tab',
      category: 'File',
      keybinding: 'mod+w',
      handler: async () => {
        const { activeFilePath, closeFile } = useWorkspaceStore.getState();
        if (!activeFilePath) return;
        const proceed = await confirmCloseDirty([activeFilePath]);
        if (proceed) closeFile(activeFilePath);
      },
    },
    {
      id: 'settings.open',
      label: 'Open Settings',
      category: 'Preferences',
      // `comma`, not ',' — see terminal.new: the registry is matched
      // against `event.code`, which reports 'Comma'.
      keybinding: 'mod+comma',
      handler: () => {
        useUiStore.getState().toggleSettings();
      },
    },
    {
      id: 'palette.commands',
      label: 'Command Palette',
      category: 'View',
      keybinding: 'mod+shift+p',
      // F1 is the palette everywhere; a single key is the cheapest possible
      // chord and nothing else claims it.
      extraKeybindings: ['f1'],
      handler: () => setPaletteMode('commands'),
    },
    {
      id: 'palette.quickOpen',
      label: 'Quick Open',
      category: 'View',
      keybinding: 'mod+p',
      handler: () => setPaletteMode('files'),
    },
    {
      id: 'help.keyboardShortcuts',
      label: 'Keyboard Shortcuts',
      category: 'Help',
      // mod+shift+/ is Ctrl+? — what almost everything uses for "show me the
      // shortcuts". Three keys, which the rest of this keymap avoids, but a
      // two-key slot is worth more to an action you run daily than to the one
      // you run when you have forgotten the others.
      keybinding: 'mod+shift+slash',
      handler: () => setShowShortcutsHelp((prev) => !prev),
    },
    {
      // `mod+t` matches Rider's and VS Code's Go-to-Symbol-in-project. Verified
      // free in both the command registry and src-tauri/src/menu.rs, which owns
      // CmdOrCtrl+Shift+T but not CmdOrCtrl+T.
      id: 'palette.gotoSymbolInProject',
      label: 'Go to Symbol in Project...',
      category: 'View',
      keybinding: 'mod+t',
      handler: () => setPaletteMode('symbols'),
      when: () => !!useWorkspaceStore.getState().workspacePath,
    },
    {
      // JetBrains' Switcher chord on both platforms, and VS Code's
      // recent-editor chord — one binding covers both muscle memories.
      //
      // NOT Cmd+E, which Rider also uses for this: on macOS that is Monaco's
      // own `actions.findWithSelection`, and `search.useSelection` below
      // already carries `skipMonacoBridge` to keep it reachable. Taking it
      // here would put two handlers on one keystroke. Ctrl+Tab has no Monaco
      // default at all, so it bridges normally.
      id: 'palette.recent',
      label: 'Recent Files',
      category: 'View',
      keybinding: 'ctrl+tab',
      handler: () => setPaletteMode('recent'),
      when: () => !!useWorkspaceStore.getState().workspacePath,
    },
    {
      id: 'search.openTab',
      label: 'Search in Files',
      category: 'Search',
      keybinding: 'mod+shift+f',
      handler: () => {
        const workspace = useWorkspaceStore.getState();
        const existing = workspace.openFiles.find((f) => f.path.startsWith('search://'));
        const seededQuery = selectionSeedQuery();
        if (existing) {
          workspace.setActiveFile(existing.path);
          useSearchStore.getState().setActiveSession(existing.path);
          if (seededQuery) useSearchStore.getState().update(existing.path, { query: seededQuery });
          window.dispatchEvent(new CustomEvent('search-focus-query'));
          return;
        }
        workspace.openSearchTab(seededQuery ? { query: seededQuery } : undefined);
      },
    },
    {
      id: 'search.newTab',
      label: 'New Search',
      category: 'Search',
      handler: () => {
        const seededQuery = selectionSeedQuery();
        useWorkspaceStore.getState().openSearchTab(seededQuery ? { query: seededQuery } : undefined);
      },
    },
    {
      id: 'search.useSelection',
      label: 'Use Selection for Find',
      category: 'Search',
      keybinding: 'mod+e',
      // On mac, Cmd+E is Monaco's own `actions.findWithSelection` default
      // (monaco-editor/esm/.../findController.js). Bridging this into Monaco
      // via addCommand would consume the key unconditionally (bind-shortcuts.ts's
      // `when()` guard only skips OUR handler, it can't hand the key back to
      // Monaco's own binding), silently replacing Find-with-Selection with a
      // no-op whenever no search tab is open (`update` on a missing session is
      // a no-op — see patchSession). The document-level hotkey
      // (KeyboardShortcutManager, enableOnFormTags/enableOnContentEditable) is
      // enough to reach this from inside the editor.
      skipMonacoBridge: true,
      handler: () => {
        const query = selectionSeedQuery();
        if (!query) return;
        const { activeSessionId, update } = useSearchStore.getState();
        update(activeSessionId, { query });
      },
    },
    {
      id: 'search.toggleCase',
      label: 'Toggle Match Case',
      category: 'Search',
      // Alt+C, not mod+alt+C. On Windows `mod` is Ctrl, and Ctrl+Alt IS
      // AltGr on every non-US layout — so the old chord fired (and
      // preventDefault'd) whenever someone typed @ \ { } ~ |, swallowing the
      // character. Alt+C is what VS Code binds on every platform.
      keybinding: 'alt+c',
      // Monaco's own `toggleFindCaseSensitive` is bound to Cmd+Alt+C on mac
      // with `precondition: undefined` — active whenever the editor has
      // focus, not just while the find widget is open. Same shadowing risk
      // as search.useSelection above: skip the Monaco bridge.
      skipMonacoBridge: true,
      // A bare alt+<letter> with no gate would fire — and preventDefault — in
      // every text field in the app, since KeyboardShortcutManager sets
      // enableOnFormTags/enableOnContentEditable. These three toggles only
      // mean anything with a search session open, so that is when they exist.
      when: searchTabIsActive,
      handler: () => {
        const { activeSessionId, sessions, update } = useSearchStore.getState();
        update(activeSessionId, { caseSensitive: !sessions[activeSessionId]?.caseSensitive });
      },
    },
    {
      id: 'search.toggleWholeWord',
      label: 'Toggle Match Whole Word',
      category: 'Search',
      // See search.toggleCase for why this is not mod+alt+W.
      keybinding: 'alt+w',
      // Same as search.toggleCase: Monaco's `toggleFindWholeWord` owns
      // Cmd+Alt+W on mac whenever the editor has focus.
      skipMonacoBridge: true,
      when: searchTabIsActive,
      handler: () => {
        const { activeSessionId, sessions, update } = useSearchStore.getState();
        update(activeSessionId, { wholeWord: !sessions[activeSessionId]?.wholeWord });
      },
    },
    {
      id: 'search.toggleRegex',
      label: 'Toggle Regular Expression',
      category: 'Search',
      // alt+R is VS Code's regex toggle on every platform, and mod+alt+X was
      // an AltGr collision like its two siblings. `skipMonacoBridge` matches
      // them too — Monaco's own toggleFindRegex would otherwise be shadowed.
      keybinding: 'alt+r',
      skipMonacoBridge: true,
      when: searchTabIsActive,
      handler: () => {
        const { activeSessionId, sessions, update } = useSearchStore.getState();
        update(activeSessionId, { isRegex: !sessions[activeSessionId]?.isRegex });
      },
    },
    {
      id: 'view.toggleSidebar',
      label: 'Toggle Sidebar',
      category: 'View',
      keybinding: 'mod+b',
      handler: () => {
        useUiStore.getState().toggleSidebar();
      },
    },
    {
      id: 'view.toggleBottomPanel',
      label: 'Toggle Bottom Panel',
      category: 'View',
      // Deliberately unbound. `terminal.toggle` owns mod+j because it also
      // spawns the first terminal; this plain visibility flip stays reachable
      // from the command palette so two commands never share one chord.
      handler: () => {
        useUiStore.getState().toggleBottomPanel();
      },
    },
    {
      id: 'view.toggleMaximizedPanel',
      label: 'Toggle Maximized Panel',
      category: 'View',
      keybinding: 'mod+shift+j',
      handler: () => {
        useUiStore.getState().toggleBottomPanelMaximized();
      },
    },
    {
      id: 'view.restoreMaximizedPanel',
      label: 'Restore Maximized Panel',
      category: 'View',
      handler: () => {
        useUiStore.getState().setBottomPanelMaximized(false);
      },
    },
    {
      id: 'view.toggleRightSidebar',
      label: 'Toggle Right Sidebar',
      category: 'View',
      keybinding: 'mod+k',
      handler: () => {
        useUiStore.getState().toggleRightSidebar();
      },
    },
    {
      id: 'view.zoomIn',
      label: 'Zoom In',
      category: 'View',
      keybinding: 'mod+equal',
      // Both chords, because "Cmd +" is physically Cmd+Shift+= on a US layout
      // while the unshifted key reports the same `code` ('Equal'), and
      // react-hotkeys-hook matches shift exactly. VS Code binds both too.
      extraKeybindings: ['mod+shift+equal'],
      handler: () => stepZoom(1),
    },
    {
      id: 'view.zoomOut',
      label: 'Zoom Out',
      category: 'View',
      keybinding: 'mod+minus',
      extraKeybindings: ['mod+shift+minus'],
      handler: () => stepZoom(-1),
    },
    {
      /*
       * No keybinding: Cmd+M belongs to `ai.cycleMode` now. macOS's Minimize
       * key equivalent would otherwise win the chord outright — the native
       * menu beats the webview — so menu.rs deliberately builds this item
       * WITHOUT an accelerator, which is what lets mod+m reach the frontend at
       * all. Minimizing stays available from Window ▸ Minimize, the command
       * palette, and the window's own yellow control.
       */
      id: 'window.minimize',
      label: 'Minimize Window',
      category: 'View',
      handler: () => {
        void getCurrentWindow().minimize();
      },
    },
    {
      id: 'view.zoomReset',
      label: 'Reset Zoom',
      category: 'View',
      // mod+0 is free here — tab switching only claims mod+1..mod+9 — and it
      // is the chord every browser and editor uses for this.
      keybinding: 'mod+0',
      handler: () => setZoomLevel(0),
    },
    {
      id: 'view.aiPanel',
      label: 'AI Assistant',
      category: 'View',
      // Two keys, because this is the single most-used action in the app.
      // mod+L is what every AI editor binds it to. A bare Ctrl+<letter> also
      // means skip-shell.ts hands it back to the shell while a terminal has
      // focus, which is right: Ctrl+L must stay clear-screen there.
      //
      // Inside the editor this takes a Monaco default: 'expandLineSelection'
      // (Ctrl+I in monaco-editor, which VS Code remaps to Ctrl+L). Deliberate
      // — the bridge in bind-shortcuts.ts wins there, and the same trade is
      // what every AI editor makes for this chord.
      keybinding: 'mod+l',
      handler: () => {
        useUiStore.getState().setActiveRightSidebarView('ai-panel');
        useUiStore.getState().setRightSidebarVisible(true);
      },
    },
    {
      id: 'ai.toggleMaximized',
      label: 'Toggle AI Maximized',
      category: 'AI',
      keybinding: 'mod+shift+enter',
      handler: () => {
        useUiStore.getState().toggleAiPanelMaximized();
      },
    },
    {
      id: 'ai.collapseMaximized',
      label: 'Collapse AI Maximized',
      category: 'AI',
      handler: () => {
        useUiStore.getState().setAiPanelMaximized(false);
      },
    },
    {
      id: 'view.explorer',
      label: 'Explorer',
      category: 'View',
      keybinding: 'mod+shift+e',
      handler: () => {
        useUiStore.getState().setActiveSidebarView('explorer');
        useUiStore.getState().setSidebarVisible(true);
      },
    },
    {
      id: 'view.sourceControl',
      label: 'Source Control',
      category: 'View',
      keybinding: 'mod+shift+g',
      handler: () => {
        useUiStore.getState().setActiveSidebarView('source-control');
        useUiStore.getState().setSidebarVisible(true);
      },
      // Same gate as the activity-bar icon: a workspace with no repository has
      // no Source Control surface, so the chord and the palette entry go with
      // the icon rather than opening a panel with nothing in it.
      when: () => showSourceControl(useGitStore.getState()),
    },
    // The Unity views had no commands at all, so they were mouse-only and
    // their activity-bar tooltips had no chord to show. mod+shift+d matches
    // VS Code's Run and Debug; the other two take free letters near their
    // names (h is Chat History, so Hierarchy takes y).
    {
      id: 'view.hierarchy',
      label: 'Unity Hierarchy',
      category: 'View',
      keybinding: 'mod+shift+y',
      handler: () => {
        useUiStore.getState().setActiveSidebarView('hierarchy');
        useUiStore.getState().setSidebarVisible(true);
      },
    },
    {
      // No keybinding on purpose: a chord here would also have to be mirrored
      // in src-tauri/src/menu.rs, whose accelerators win on macOS, and
      // keybinding-parity.test.ts enforces that. The command is still
      // reachable from the command palette and supplies the tooltip.
      id: 'view.scriptableObjects',
      label: 'Scriptable Objects',
      category: 'View',
      handler: () => {
        useUiStore.getState().setActiveSidebarView('scriptable-objects');
        useUiStore.getState().setSidebarVisible(true);
      },
    },
    {
      id: 'view.testRunner',
      label: 'Unity Tests',
      category: 'View',
      keybinding: 'mod+shift+u',
      handler: () => {
        useUiStore.getState().setActiveSidebarView('test');
        useUiStore.getState().setSidebarVisible(true);
      },
    },
    {
      id: 'view.toggleAssetSource',
      label: 'Toggle Source / Preview',
      category: 'View',
      handler: () => {
        const path = useWorkspaceStore.getState().activeFilePath;
        if (!path) return;
        const ui = useUiStore.getState();
        const mode = ui.assetViewerMode[path];
        ui.setAssetViewerMode(path, mode === 'structured' || mode === undefined ? 'raw-edit' : 'structured');
      },
    },
    {
      id: 'view.unityUi',
      label: 'Unity UI',
      category: 'View',
      handler: () => {
        useUiStore.getState().setActiveSidebarView('unity-ui');
        useUiStore.getState().setSidebarVisible(true);
      },
    },
    {
      id: 'view.inputHub',
      label: 'Input Actions',
      category: 'View',
      handler: () => {
        useUiStore.getState().setActiveSidebarView('input');
        useUiStore.getState().setSidebarVisible(true);
      },
    },
    {
      id: 'view.debug',
      label: 'Run and Debug',
      category: 'View',
      keybinding: 'mod+shift+d',
      handler: () => {
        useUiStore.getState().setActiveSidebarView('debug');
        useUiStore.getState().setSidebarVisible(true);
      },
    },
    // AI mode / session shortcuts. Cycling is a no-op mid-run, matching
    // ModeSelector's own `disabled` — switching mode under a running agent
    // would change the toolset out from under it.
    {
      id: 'ai.cycleMode',
      label: 'Cycle AI Mode (Ask / Agent / Plan)',
      category: 'AI',
      // This command must be the one holding mod+m, not just the one that
      // happens to run on it. `ModeSelector`'s Tooltip renders whatever chord
      // the registry has under `ai.cycleMode` — so parking the real chord on a
      // different command left the pill advertising the old mod+. while mod+m
      // was what actually worked. tooltip-chord.ts warns about exactly this.
      keybinding: 'mod+m',
      when: () => isAiComposerFocused(),
      skipMonacoBridge: true,
      handler: cycleAiMode,
    },
    // Effort, from the composer only. mod+left/right is line-start/line-end in
    // every other text surface in the app, so both the `when` gate and
    // `skipMonacoBridge` are load-bearing: the gate stops
    // KeyboardShortcutManager consuming the keystroke anywhere else, and
    // skipping the Monaco bridge stops `editor.addCommand` swallowing it in
    // the code editor — addCommand fires on the chord regardless of `when`,
    // which is exactly what that flag exists for.
    {
      id: 'ai.effortCycle',
      label: 'Cycle Reasoning Effort',
      category: 'AI',
      // Effort is a MODE, not a stepped scale, so it gets one cycling chord
      // the way `ai.cycleMode` does — not a pair of arrows. Arrows were the
      // problem: scoped to the composer, `mod+left/right` fired only inside a
      // text box, and that IS the caret binding there (line start/end on
      // macOS, word jump on Windows).
      //
      // `mod+d` is free in the registry and in the native menu, and unlike
      // mod+b/i/u it is not a rich-text formatting chord in the Lexical
      // composer, nor Ctrl+Y's redo on Windows. `skipMonacoBridge` keeps
      // Monaco's own Ctrl+D (add selection to next match) intact.
      keybinding: 'mod+d',
      when: () => isAiComposerFocused(),
      skipMonacoBridge: true,
      handler: () => cycleEffortCommand(),
    },
    {
      id: 'ai.newChat',
      label: 'New Chat',
      category: 'AI',
      // Two keys; the second most-used AI action. Like mod+l it yields to
      // the shell in a terminal, where Ctrl+I is Tab, and like it takes
      // Monaco's 'expandLineSelection' inside the editor.
      keybinding: 'mod+i',
      handler: () => {
        useUiStore.getState().setActiveRightSidebarView('ai-panel');
        useUiStore.getState().setRightSidebarVisible(true);
        window.dispatchEvent(new CustomEvent('ai-new-chat'));
      },
    },
    {
      id: 'ai.history',
      label: 'Chat History',
      category: 'AI',
      keybinding: 'mod+shift+h',
      handler: () => {
        useUiStore.getState().setActiveRightSidebarView('ai-panel');
        useUiStore.getState().setRightSidebarVisible(true);
        window.dispatchEvent(new CustomEvent('ai-toggle-history'));
      },
    },
    // Copy / Ask AI for the two error surfaces. No chords, deliberately: every
    // free two-key combination is spoken for, a new one has to be mirrored into
    // `src-tauri/src/menu.rs`, and `mod+shift+c` — the obvious pick — already
    // belongs to the terminal's copy-selection. These are pointer-initiated
    // actions with visible buttons; the palette is the right keyboard path.
    //
    // Each hops through a window event because the panels own the filter state
    // that decides WHAT is on screen, and a command cannot reach it. The
    // handlers on the other side are the same ones the toolbar buttons call.
    {
      id: 'problems.copyAll',
      label: 'Copy Problems',
      category: 'View',
      handler: () => {
        useUiStore.getState().setBottomPanelVisible(true);
        useUiStore.getState().setActiveBottomTab('problems');
        // Next frame: with the bottom panel closed, the listening panel has
        // not mounted yet, so a synchronous dispatch reaches nothing.
        requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('problems-copy-all')));
      },
    },
    {
      id: 'problems.askAi',
      label: 'Ask AI About Problems',
      category: 'AI',
      handler: () => {
        useUiStore.getState().setBottomPanelVisible(true);
        useUiStore.getState().setActiveBottomTab('problems');
        // Next frame: with the bottom panel closed, the listening panel has
        // not mounted yet, so a synchronous dispatch reaches nothing.
        requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('problems-ask-ai')));
      },
    },
    {
      id: 'unityConsole.copyAll',
      label: 'Copy Unity Console',
      category: 'Unity',
      handler: () => {
        useUiStore.getState().setBottomPanelVisible(true);
        useUiStore.getState().setActiveBottomTab('unity-console');
        // Next frame: with the bottom panel closed, the listening panel has
        // not mounted yet, so a synchronous dispatch reaches nothing.
        requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('unity-console-copy-all')));
      },
      when: () => useProjectContextStore.getState().isUnityProject,
    },
    {
      id: 'unityConsole.askAi',
      label: 'Ask AI About Console Errors',
      category: 'AI',
      handler: () => {
        useUiStore.getState().setBottomPanelVisible(true);
        useUiStore.getState().setActiveBottomTab('unity-console');
        // Next frame: with the bottom panel closed, the listening panel has
        // not mounted yet, so a synchronous dispatch reaches nothing.
        requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('unity-console-ask-ai')));
      },
      when: () => useProjectContextStore.getState().isUnityProject,
    },
    {
      id: 'file.new',
      label: 'New File',
      category: 'File',
      keybinding: 'mod+n',
      handler: () => {
        window.dispatchEvent(new CustomEvent('request-new-file'));
      },
      when: () => !!useWorkspaceStore.getState().workspacePath,
    },
    {
      id: 'tab.next',
      label: 'Next Tab',
      category: 'View',
      // mod+alt+arrows were the worst of the AltGr chords: on top of eating
      // typed characters, Ctrl+Alt+Arrow rotates the screen under Intel's
      // display driver. mod+PgDn/PgUp is what VS Code uses and is two keys.
      keybinding: 'mod+pagedown',
      handler: () => {
        const ws = useWorkspaceStore.getState();
        const files = ws.openFiles;
        if (files.length === 0) return;
        const i = files.findIndex((f) => f.path === ws.activeFilePath);
        const next = files[(Math.max(0, i) + 1) % files.length];
        ws.setActiveFile(next.path);
      },
    },
    {
      id: 'tab.prev',
      label: 'Previous Tab',
      category: 'View',
      // See tab.next.
      keybinding: 'mod+pageup',
      handler: () => {
        const ws = useWorkspaceStore.getState();
        const files = ws.openFiles;
        if (files.length === 0) return;
        const i = files.findIndex((f) => f.path === ws.activeFilePath);
        const prev = files[(Math.max(0, i) - 1 + files.length) % files.length];
        ws.setActiveFile(prev.path);
      },
    },
    {
      id: 'tab.closeAll',
      label: 'Close All Tabs',
      category: 'View',
      keybinding: 'mod+shift+w',
      handler: async () => {
        const ws = useWorkspaceStore.getState();
        const paths = ws.openFiles.map((f) => f.path);
        if (paths.length === 0) return;
        const proceed = await confirmCloseDirty(paths);
        if (!proceed) return;
        for (const p of paths) ws.closeFile(p);
      },
    },
    {
      id: 'tab.closeOthers',
      label: 'Close Other Tabs',
      category: 'View',
      handler: async () => {
        const ws = useWorkspaceStore.getState();
        if (!ws.activeFilePath) return;
        const paths = ws.openFiles
          .map((f) => f.path)
          .filter((p) => p !== ws.activeFilePath);
        if (paths.length === 0) return;
        const proceed = await confirmCloseDirty(paths);
        if (!proceed) return;
        for (const p of paths) ws.closeFile(p);
      },
    },
    {
      id: 'tab.closeToRight',
      label: 'Close Tabs to the Right',
      category: 'View',
      handler: async () => {
        const ws = useWorkspaceStore.getState();
        const idx = ws.openFiles.findIndex((f) => f.path === ws.activeFilePath);
        if (idx < 0) return;
        const paths = ws.openFiles.slice(idx + 1).map((f) => f.path);
        if (paths.length === 0) return;
        const proceed = await confirmCloseDirty(paths);
        if (!proceed) return;
        for (const p of paths) ws.closeFile(p);
      },
    },
    {
      id: 'tab.reopenClosed',
      label: 'Reopen Closed Tab',
      category: 'View',
      keybinding: 'mod+shift+t',
      handler: async () => {
        const ws = useWorkspaceStore.getState();
        const path = ws.popRecentlyClosed();
        if (!path) return;
        const name = path.split('/').pop() ?? path;
        try {
          await ws.openFile(path, name);
        } catch {
          // File may have been deleted — silently no-op
        }
      },
    },
    ...Array.from({ length: 9 }, (_, k) => ({
      id: `tab.switch.${k + 1}`,
      label: `Go to Tab ${k + 1}`,
      category: 'View',
      keybinding: `mod+${k + 1}`,
      handler: () => {
        const ws = useWorkspaceStore.getState();
        const file = ws.openFiles[k];
        if (file) ws.setActiveFile(file.path);
      },
    } satisfies Command)),
    {
      id: 'editor.formatDocument',
      label: 'Format Document',
      category: 'Editor',
      keybinding: 'shift+alt+f',
      handler: () => window.dispatchEvent(new CustomEvent('format-document')),
      when: () => !!useWorkspaceStore.getState().activeFilePath,
    },
    {
      id: 'editor.gotoLine',
      label: 'Go to Line...',
      category: 'Editor',
      keybinding: 'mod+g',
      handler: () => window.dispatchEvent(new CustomEvent('goto-line')),
      when: () => !!useWorkspaceStore.getState().activeFilePath,
    },
    {
      // Monaco's own alt+enter bindings (SelectAllMatches, ReplaceAll) are
      // gated on CONTEXT_FIND_WIDGET_VISIBLE, so the bridge's standard
      // `!findWidgetVisible` precondition already keeps them reachable — this
      // one bridges normally, no `skipMonacoBridge` needed. Cmd+. still works;
      // this is an alias, not a move.
      // Rider's Find Usages chord, free in both registries. Monaco's own
      // Shift+F12 peek keeps working — this is the walkable list, not a
      // replacement for the inline glance.
      id: 'editor.findUsages',
      label: 'Find Usages',
      category: 'Editor',
      keybinding: 'alt+f7',
      handler: () => void findUsagesAtCursor(),
      when: () => canFindUsages(),
    },
    {
      id: 'editor.quickFix',
      label: 'Quick Fix / Show Intentions',
      category: 'Editor',
      keybinding: 'alt+enter',
      handler: () => window.dispatchEvent(new CustomEvent('quick-fix')),
      when: () => isTextEditorFocused(),
    },
    {
      // Rider's own Back/Forward chords, and free in both the command registry
      // and menu.rs.
      //
      // They ARE Monaco's `editor.action.outdentLines` / `indentLines`, which
      // are gated on plain editor focus rather than the find widget — so the
      // usual `!findWidgetVisible` precondition in bind-shortcuts.ts does not
      // protect them and the bridge shadows both. That is deliberate here:
      // indent/outdent stays fully reachable on Tab / Shift+Tab, which is how
      // it is actually used, and navigation has to be live INSIDE the editor.
      //
      // `skipMonacoBridge` would be the wrong tool. It works for the terminal
      // pane commands (App.tsx above) only because their `when()` is false
      // wherever Monaco's default should win; there is no such guard for a
      // command whose whole job is to fire while you are editing.
      id: 'nav.back',
      label: 'Back',
      category: 'Go',
      keybinding: 'mod+bracketleft',
      handler: () => void navigateBack(),
      when: () => canNavigateBack(),
    },
    {
      id: 'nav.forward',
      label: 'Forward',
      category: 'Go',
      keybinding: 'mod+bracketright',
      handler: () => void navigateForward(),
      when: () => canNavigateForward(),
    },
    {
      id: 'editor.gotoSymbol',
      label: 'Go to Symbol in File...',
      category: 'Editor',
      keybinding: 'mod+shift+o',
      handler: () => window.dispatchEvent(new CustomEvent('goto-symbol')),
      when: () => !!useWorkspaceStore.getState().activeFilePath,
    },
    {
      // mod+shift+r, which is what Monaco itself uses for this action. It
      // used to belong to `view.revealInExplorer`, whose Monaco bridge
      // shadowed the built-in whenever the editor had focus; that command has
      // moved to shift+alt+r (VS Code's actual Reveal chord) so this one can
      // sit where the editor already expects it. The old mod+alt+R was an
      // AltGr collision — see search.toggleCase.
      id: 'editor.refactor',
      label: 'Refactor This...',
      category: 'Editor',
      keybinding: 'mod+shift+r',
      handler: () => window.dispatchEvent(new CustomEvent('refactor-this')),
      when: () => !!useWorkspaceStore.getState().activeFilePath,
    },
    {
      id: 'view.revealInExplorer',
      label: 'Reveal Active File in Explorer',
      category: 'View',
      // shift+alt+r is VS Code's own Reveal chord, and vacating mod+shift+r
      // hands that one back to editor.refactor / Monaco.
      keybinding: 'shift+alt+r',
      handler: () => {
        const path = useWorkspaceStore.getState().activeFilePath;
        if (!path) return;
        // Stash the target before flipping the sidebar view: if the explorer
        // wasn't already mounted, React hasn't attached its `reveal-in-tree`
        // listener yet by the time we dispatch below — the pending slot lets
        // ExplorerPanel pick this up on mount instead of losing the request.
        setPendingReveal(path);
        useUiStore.getState().setActiveSidebarView('explorer');
        useUiStore.getState().setSidebarVisible(true);
        window.dispatchEvent(new CustomEvent('reveal-in-tree', { detail: { path } }));
      },
      when: () => !!useWorkspaceStore.getState().activeFilePath,
    },
    {
      id: 'git.switchBranch',
      label: 'Switch Branch',
      category: 'Git',
      keybinding: 'mod+shift+b',
      handler: () => setBranchPickerMode('switch'),
      when: () => useGitStore.getState().isGitRepo,
    },
    {
      id: 'git.createBranch',
      label: 'Create Branch',
      category: 'Git',
      handler: () => setBranchPickerMode('create'),
      when: () => useGitStore.getState().isGitRepo,
    },
    // Debug commands.
    //
    // Chord choice is constrained by what already works here. F5/Shift+F5/F7
    // belong to Unity's play family, and this app has already established that
    // two chords are unusable on Windows: Shift+F10 is the context-menu key and
    // F11 is the webview's fullscreen key. That rules out VS Code's F11 /
    // Shift+F11 for step in/out, so those take Rider's F8 / Shift+F8 shape
    // while the two most-used actions keep the F9 / F10 everyone knows.
    //
    // Stepping is gated on a live session rather than merely on a Unity
    // project, so these keys fall through to the editor and shell when there is
    // nothing to step.
    {
      id: 'debug.toggleBreakpoint',
      label: 'Toggle Breakpoint',
      category: 'Debug',
      keybinding: 'f9',
      handler: () => {
        const file = useWorkspaceStore.getState().activeFilePath;
        const line = useUiStore.getState().cursorPosition?.line;
        if (file && line) useDebugStore.getState().toggleBreakpoint(file, line);
      },
      when: () => useProjectContextStore.getState().isUnityProject,
    },
    {
      id: 'debug.continue',
      label: 'Continue',
      category: 'Debug',
      keybinding: 'mod+f5',
      handler: () => {
        const debug = useDebugStore.getState();
        // One key for "get going": attach when idle, resume when paused.
        if (debug.status === 'inactive' || debug.status === 'terminated') void debug.attach(false);
        else void debug.resume();
      },
      when: () => useProjectContextStore.getState().isUnityProject,
    },
    {
      id: 'debug.stepOver',
      label: 'Step Over',
      category: 'Debug',
      keybinding: 'f10',
      handler: () => void useDebugStore.getState().stepOver(),
      when: () => useDebugStore.getState().status === 'paused',
    },
    {
      id: 'debug.stepInto',
      label: 'Step Into',
      category: 'Debug',
      keybinding: 'f8',
      handler: () => void useDebugStore.getState().stepIn(),
      when: () => useDebugStore.getState().status === 'paused',
    },
    {
      id: 'debug.stepOut',
      label: 'Step Out',
      category: 'Debug',
      keybinding: 'shift+f8',
      handler: () => void useDebugStore.getState().stepOut(),
      when: () => useDebugStore.getState().status === 'paused',
    },
    {
      id: 'debug.runToCursor',
      label: 'Run to Cursor',
      category: 'Debug',
      keybinding: 'mod+f10',
      handler: () => {
        const file = useWorkspaceStore.getState().activeFilePath;
        const line = useUiStore.getState().cursorPosition?.line;
        if (file && line) void useDebugStore.getState().runToCursor(file, line);
      },
      when: () => useDebugStore.getState().status === 'paused',
    },
    {
      id: 'debug.setNextStatement',
      label: 'Set Next Statement',
      category: 'Debug',
      // No chord: it is a deliberate, occasional action, and every obvious
      // combination here is already spoken for.
      handler: () => {
        const file = useWorkspaceStore.getState().activeFilePath;
        const line = useUiStore.getState().cursorPosition?.line;
        if (file && line) void useDebugStore.getState().setNextStatement(file, line);
      },
      when: () => useDebugStore.getState().status === 'paused',
    },
    {
      id: 'debug.pause',
      label: 'Pause',
      category: 'Debug',
      handler: () => void useDebugStore.getState().pause(),
      when: () => useDebugStore.getState().status === 'running',
    },
    {
      id: 'debug.stop',
      label: 'Stop Debugging',
      category: 'Debug',
      keybinding: 'mod+shift+f5',
      handler: () => void useDebugStore.getState().stop(),
      when: () => useDebugStore.getState().status !== 'inactive',
    },
    // Unity commands
    {
      id: 'unity.play',
      label: 'Play',
      category: 'Unity',
      // The play family is bare F-keys: one keystroke for the action a Unity
      // developer runs more than any other, and it clears the two chords that
      // did not work on Windows at all (Shift+F10 is the context-menu key,
      // F11 is the webview's fullscreen key). KeyboardShortcutManager swallows
      // F5 unconditionally so this staying `when`-gated cannot leave a bare
      // F5 falling through to the webview and reloading the app.
      keybinding: 'f5',
      handler: () => useUnityStore.getState().sendPlay(),
      when: () => useProjectContextStore.getState().isUnityProject,
    },
    {
      id: 'unity.pause',
      label: 'Pause',
      category: 'Unity',
      keybinding: 'f6',
      handler: () => useUnityStore.getState().sendPause(),
      when: () => useProjectContextStore.getState().isUnityProject,
    },
    {
      id: 'unity.stop',
      label: 'Stop',
      category: 'Unity',
      keybinding: 'shift+f5',
      handler: () => useUnityStore.getState().sendStop(),
      when: () => useProjectContextStore.getState().isUnityProject,
    },
    {
      id: 'unity.step',
      label: 'Step',
      category: 'Unity',
      keybinding: 'f7',
      handler: () => useUnityStore.getState().sendStep(),
      when: () => useProjectContextStore.getState().isUnityProject,
    },
    {
      id: 'unity.showProfiler',
      label: 'Show Unity Profiler',
      category: 'Unity',
      handler: () => { useUiStore.getState().setActiveBottomTab('unity-profiler'); useUiStore.getState().setBottomPanelVisible(true); },
      when: () => useProjectContextStore.getState().isUnityProject,
    },
    {
      id: 'unity.attachDebugger',
      label: 'Attach Debugger',
      category: 'Unity',
      handler: () => {
        useUiStore.getState().setActiveSidebarView('debug');
        useUiStore.getState().setSidebarVisible(true);
        void useDebugStore.getState().attach(false);
      },
      when: () => useProjectContextStore.getState().isUnityProject,
    },
    {
      id: 'unity.attachDebuggerAndPlay',
      label: 'Attach Debugger and Play',
      category: 'Unity',
      handler: () => {
        useUiStore.getState().setActiveSidebarView('debug');
        useUiStore.getState().setSidebarVisible(true);
        void useDebugStore.getState().attach(true);
      },
      when: () => useProjectContextStore.getState().isUnityProject,
    },
    {
      id: 'unity.clearConsole',
      label: 'Clear Unity Console',
      category: 'Unity',
      handler: () => void useUnityStore.getState().clearLogs(),
      when: () => useProjectContextStore.getState().isUnityProject,
    },
    {
      id: 'unity.reconnectBridge',
      label: 'Reconnect Unity Bridge',
      category: 'Unity',
      handler: () => void useUnityStore.getState().reconnect(),
      when: () => useProjectContextStore.getState().isUnityProject,
    },
    {
      id: 'unity.showHierarchy',
      label: 'Show Hierarchy',
      category: 'Unity',
      handler: () => {
        useUiStore.getState().setActiveSidebarView('hierarchy');
        useUiStore.getState().setSidebarVisible(true);
        void useUnitySceneStore.getState().refresh();
      },
      when: () => useProjectContextStore.getState().isUnityProject,
    },
    {
      id: 'unity.openScene',
      label: 'Open Scene…',
      category: 'Unity',
      handler: () => setUnityPicker('scene'),
      when: () => useProjectContextStore.getState().isUnityProject,
    },
    {
      id: 'unity.findAsset',
      label: 'Find Asset…',
      category: 'Unity',
      handler: () => setUnityPicker('asset'),
      when: () => useProjectContextStore.getState().isUnityProject,
    },
    {
      id: 'unity.newScript',
      label: 'New C# Script…',
      category: 'Unity',
      handler: () => {
        const ws = useWorkspaceStore.getState();
        const active = ws.activeFilePath;
        const dir =
          active && active.toLowerCase().endsWith('.cs')
            ? active.slice(0, active.lastIndexOf('/'))
            : ws.workspacePath
              ? `${ws.workspacePath}/Assets`
              : '';
        if (dir) window.dispatchEvent(new CustomEvent('new-csharp-script', { detail: { dir } }));
      },
      when: () =>
        useProjectContextStore.getState().isUnityProject &&
        useSettingsStore.getState().getSetting('unity.templates.enabled') !== false,
    },
    {
      id: 'unity.runAllTests',
      label: 'Run All Tests',
      category: 'Unity',
      handler: () => {
        useUiStore.getState().setActiveSidebarView('test');
        useUiStore.getState().setSidebarVisible(true);
        void useTestStore.getState().runAll('EditMode');
      },
      when: () =>
        useProjectContextStore.getState().isUnityProject &&
        useSettingsStore.getState().getSetting('unity.testRunner.enabled') !== false,
    },
    {
      id: 'unity.findAssetReferencesForCurrentFile',
      label: 'Find Asset References to Current Script',
      category: 'Unity',
      handler: () => {
        const ws = useWorkspaceStore.getState();
        const path = ws.activeFilePath;
        if (!ws.workspacePath || !path) return;
        useUiStore.getState().setActiveRightSidebarView('unity-inspector');
        useUiStore.getState().setRightSidebarVisible(true);
        useSceneUsageStore.getState().loadForScript(path, ws.workspacePath);
      },
      when: () => {
        if (!useProjectContextStore.getState().isUnityProject) return false;
        const ws = useWorkspaceStore.getState();
        const path = ws.activeFilePath;
        if (!path || !ws.workspacePath) return false;
        if (!path.toLowerCase().endsWith('.cs')) return false;
        const prefix = ws.workspacePath.endsWith('/') ? ws.workspacePath : ws.workspacePath + '/';
        if (!path.startsWith(prefix)) return false;
        return classifyFile(path.slice(prefix.length)) === FilePriority.MonoBehaviour;
      },
    },
    // Account
    {
      id: 'auth.account',
      label: 'Account / Sign In',
      category: 'Account',
      handler: () => {
        useUiStore.getState().openSettings(ACCOUNT_SECTION);
      },
    },
  ], []);

  useRegisterCommands(commands);

  // .gitignore doctor: once per workspace, when a Unity git repo is detected,
  // offer to add missing canonical Unity ignore rules. One-shot + non-nagging.
  useEffect(() => {
    function maybeDoctor() {
      const wp = useWorkspaceStore.getState().workspacePath;
      if (!wp) return;
      if (useProjectContextStore.getState().isUnityProject && useGitStore.getState().isGitRepo) {
        void runGitignoreDoctor(wp);
      }
    }
    const unsubPc = useProjectContextStore.subscribe(maybeDoctor);
    const unsubGit = useGitStore.subscribe(maybeDoctor);
    maybeDoctor();
    return () => {
      unsubPc();
      unsubGit();
    };
  }, []);

  // "New C# Script" modal host: opened from the explorer context menu + palette.
  useEffect(() => {
    function onNewScript(e: Event) {
      const dir = (e as CustomEvent<{ dir: string }>).detail?.dir;
      if (dir) setNewScriptDir(dir);
    }
    window.addEventListener('new-csharp-script', onNewScript);
    return () => window.removeEventListener('new-csharp-script', onNewScript);
  }, []);

  // Auto-start Unity IPC when project is detected
  useEffect(() => {
    const unsub = useProjectContextStore.subscribe((state, prev) => {
      if (state.isUnityProject && !prev.isUnityProject) {
        const wp = useWorkspaceStore.getState().workspacePath;
        if (wp) {
          useUnityStore.getState().startIpc(wp);
        }
      } else if (!state.isUnityProject && prev.isUnityProject) {
        useUnityStore.getState().stopIpc();
      }
    });
    return unsub;
  }, []);

  return (
    <div className="app">
      <KeyboardShortcutManager />
      <TitleBar />
      <div className="app-body">
        {workspacePath ? (
          <>
            <ActivityBar />
            <div className="main-content">
              <Allotment
                ref={allotmentRef}
                proportionalLayout={false}
                defaultSizes={initialLayout.sizes}
                onChange={onLayoutChange}
              >
                {/* All three panes are always rendered and toggled via `visible`
                    so opening the right panel never re-distributes (and snaps
                    wide) the left sidebar. The editor holds layout priority so it
                    alone absorbs show/hide/resize deltas, keeping the side panes
                    fixed at their width (25% each on first open). */}
                <Allotment.Pane
                  key="sidebar"
                  visible={sidebarVisible}
                  preferredSize={initialLayout.left}
                  minSize={150}
                >
                  <SidebarPanel />
                </Allotment.Pane>
                <Allotment.Pane key="editor" priority={LayoutPriority.High}>
                  <div className="editor-area">
                    <Allotment vertical onChange={onVerticalLayoutChange}>
                      <Allotment.Pane>
                        {/* Settings and Account are no longer rendered here.
                            Both used to displace the editor — settings by
                            replacing this whole subtree, account as an
                            `auth://` tab pretending to be a file. They are one
                            modal now (`SettingsModal`, mounted at the app
                            root), so the workspace stays put behind them. */}
                        <div className="editor-section">
                          <ProjectRootBanner />
                          <TabBar />
                          <Breadcrumbs />
                          <EditorErrorBoundary>
                            {activeFilePath ? <><SaveConflictBanner /><EditorPanel /></> : <WelcomeScreen hasWorkspace />}
                          </EditorErrorBoundary>
                        </div>
                      </Allotment.Pane>
                      {/* `visible`, never a conditional render — load-bearing.
                          Unmounting this pane disposes every xterm instance
                          under it (TerminalInstance's cleanup calls
                          term.dispose()) while the PTYs keep running, so
                          reopening would attach a blank 80x24 buffer to a live
                          shell. Re-fitting on reveal cannot rescue that: the
                          kernel only raises SIGWINCH when the winsize actually
                          changes (XNU tty.c guards TIOCSWINSZ on a bcmp; Linux
                          tty_do_resize on a memcmp), so a same-size resize is a
                          silent no-op and a full-screen TUI is never told to
                          repaint. Allotment's `visible` drives the pane's size
                          and caches the old one instead of unmounting children,
                          which keeps the terminal — and its scrollback — alive.
                          This is the same keep-alive intent BottomPanel and
                          RichTerminalPanel already document for tab switches
                          and splits. */}
                      <Allotment.Pane
                        visible={bottomPanelVisible}
                        preferredSize={250}
                        minSize={100}
                        maxSize={600}
                      >
                        <BottomPanel />
                      </Allotment.Pane>
                    </Allotment>
                  </div>
                </Allotment.Pane>
                <Allotment.Pane
                  key="right"
                  visible={rightSidebarVisible && !aiPanelMaximized}
                  preferredSize={initialLayout.right}
                  minSize={200}
                >
                  <RightSidebarPanel />
                </Allotment.Pane>
              </Allotment>
            </div>
            <RightActivityBar />
          </>
        ) : bootSurface === 'restoring' ? (
          // Quiet shell for the first-paint → restore-settled gap, so opening
          // a project reads as one continuous paint instead of
          // blank → "Open a folder" → project. The label is delayed in CSS:
          // a fast restore shows nothing at all (no new flash), while a slow
          // one — a network share, a cold disk — still explains itself
          // rather than sitting as a dead void.
          <div className="workspace-booting">
            <span className="workspace-booting-label">
              {bootProjectName ? `Opening ${bootProjectName}…` : 'Opening…'}
            </span>
          </div>
        ) : (
          <WelcomeScreen />
        )}
      </div>
      <StatusBar />
      <NotificationContainer />
      {/* Mounted at the app root, not inside the editor pane: it overlays the
          workspace instead of displacing it. Gates itself on `settingsOpen`. */}
      <SettingsModal />
      {showShortcutsHelp && (
        <ShortcutsHelpModal onClose={() => setShowShortcutsHelp(false)} />
      )}
      {showThemePicker && (
        <ThemePicker onClose={() => setShowThemePicker(false)} />
      )}
      {paletteMode && (
        <PaletteModal initialMode={paletteMode} onClose={() => setPaletteMode(null)} />
      )}
      {branchPickerMode && (
        <BranchPicker initialMode={branchPickerMode} onClose={() => setBranchPickerMode(null)} />
      )}
      {newScriptDir && (
        <NewScriptModal targetDir={newScriptDir} onClose={() => setNewScriptDir(null)} />
      )}
      {unityPicker && (
        <UnityAssetPickerModal mode={unityPicker} onClose={() => setUnityPicker(null)} />
      )}
      <TooltipHost />
      <CoachMarks />
      {graphifyIntroOpen && (
        <GraphifyIntroModal
          onClose={() => setGraphifyIntroOpen(false)}
          onGenerate={() => {
            const path = useWorkspaceStore.getState().workspacePath;
            if (path) void useGraphifyStore.getState().build(path, computeBuildOpts());
          }}
          onSuppress={() => {
            useSettingsStore
              .getState()
              .setSetting('graphify.suppressFirstOpenToast', true);
          }}
        />
      )}
      {dotnetMissingModal && (
        <DotnetMissingModal
          block={dotnetMissingModal}
          onClose={() => setDotnetMissingModal(null)}
        />
      )}
    </div>
  );
}

export default App;
