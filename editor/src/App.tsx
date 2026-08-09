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
  SidebarPanel,
  StatusBar,
  TabBar,
  TitleBar,
  flushLayoutPersisters,
  initialPaneSizes,
  layoutPersister,
  verticalPersister,
  widthsForRestore,
} from './features/app-shell';
import { EditorPanel, Breadcrumbs, EditorErrorBoundary } from './features/editor';
import {
  WelcomeScreen,
  ProjectRootBanner,
  openWelcomeWindow,
  openFolderInNewWindow,
  setProjectWindowTitle,
  initialBootSurface,
  consumePendingGotoForWorkspace,
} from './features/project';
import { AiChatPanel, MaximizedAiOverlay, restoreLatestSessionForWorkspace } from './features/ai-panel';
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
import { useUnitySceneStore } from './stores/unity-scene';
import { useRegisterCommands } from './hooks/useRegisterCommands';
import { useAutoSave } from './hooks/useAutoSave';
import { useCloseGuard } from './hooks/useCloseGuard';
import { notify, useNotificationsStore } from './stores/notifications';
import { checkReleaseChannel } from './config/api';
import { useCommandsStore } from './stores/commands';
import { listenScoped } from './utils/tauri-listener';
import { useWorkspaceStore } from './stores/workspace';
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
import { safeUnlisten } from './utils/tauri-listener';
import type { Command } from './types';

function App() {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const activeFilePath = useWorkspaceStore((s) => s.activeFilePath);
  const sidebarVisible = useUiStore((s) => s.sidebarVisible);
  const rightSidebarVisible = useUiStore((s) => s.rightSidebarVisible);
  const bottomPanelVisible = useUiStore((s) => s.bottomPanelVisible);
  const aiPanelMaximized = useUiStore((s) => s.aiPanelMaximized);
  const graphifyIntroOpen = useUiStore((s) => s.graphifyIntroOpen);
  const setGraphifyIntroOpen = useUiStore((s) => s.setGraphifyIntroOpen);
  const dotnetMissingModalOpen = useUiStore((s) => s.dotnetMissingModalOpen);
  const setDotnetMissingModalOpen = useUiStore((s) => s.setDotnetMissingModalOpen);
  const restoredRef = useRef(false);
  const [showThemePicker, setShowThemePicker] = useState(false);
  const [paletteMode, setPaletteMode] = useState<'commands' | 'files' | null>(null);
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

    useSettingsStore.getState().loadSettings();
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
        // Unity's `--goto` lands last, so it wins over the restored active
        // tab: the user double-clicked a specific script and that is what
        // they are waiting to see. The claim is conditional on the Rust side,
        // so a target belonging to another project stays pending for the
        // window that owns it.
        await consumePendingGotoForWorkspace(workspacePath);
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
  // under the production identifier write dev-API tokens into ~/.arcane, which
  // the real app then presents to the production API.
  useEffect(() => {
    void checkReleaseChannel(invoke).then((problem) => {
      if (!problem) return;
      useNotificationsStore
        .getState()
        .addNotification({ type: 'error', message: problem, persistent: true });
    });
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
  // stores the --goto and emits this. Every project window tries to claim it;
  // the Rust side only hands it to the one whose workspace matches, so exactly
  // one window opens the file and the rest are no-ops.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const fn = await listenScoped('arcane-goto-pending', () => {
        void consumePendingGotoForWorkspace(useWorkspaceStore.getState().workspacePath);
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
          return;
        }
        if (event.payload.type === 'leave') {
          clearTerminalDropTarget();
          clearExplorerDropTarget();
          return;
        }

        const paths = event.payload.paths;
        clearExplorerDropTarget();
        if (await handleTerminalDrop(event.payload.position, paths)) return;

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
      handler: () => {
        const ui = useUiStore.getState();
        const wasVisible = ui.bottomPanelVisible;
        ui.toggleBottomPanel();
        if (!wasVisible) {
          const termStore = useTerminalStore.getState();
          const wp = useWorkspaceStore.getState().workspacePath;
          if (termStore.terminals.length === 0 && wp) {
            termStore.createTerminal(wp);
          }
        }
      },
    },
    {
      id: 'terminal.new',
      label: 'New Terminal',
      category: 'Terminal',
      keybinding: 'mod+shift+`',
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
      },
      when: () => !!useWorkspaceStore.getState().workspacePath,
    },
    {
      id: 'file.save',
      label: 'Save File',
      category: 'File',
      keybinding: 'mod+s',
      handler: () => {
        const { activeFilePath, saveFile } = useWorkspaceStore.getState();
        if (activeFilePath) saveFile(activeFilePath);
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
      keybinding: 'mod+,',
      handler: () => {
        useUiStore.getState().toggleSettings();
      },
    },
    {
      id: 'palette.commands',
      label: 'Command Palette',
      category: 'View',
      keybinding: 'mod+shift+p',
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
      id: 'search.focus',
      label: 'Search',
      category: 'View',
      keybinding: 'mod+shift+f',
      handler: () => {
        useUiStore.getState().setActiveSidebarView('search');
        useUiStore.getState().setSidebarVisible(true);
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
      id: 'view.aiPanel',
      label: 'AI Assistant',
      category: 'View',
      keybinding: 'mod+shift+a',
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
      id: 'ai.toggleInlineSuggestions',
      label: 'Toggle AI Inline Suggestions',
      category: 'AI',
      keybinding: 'mod+alt+i',
      handler: () => {
        const s = useSettingsStore.getState();
        s.setSetting('ai.inlineSuggestions.enabled', !s.settings['ai.inlineSuggestions.enabled']);
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
      keybinding: 'mod+alt+right',
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
      keybinding: 'mod+alt+left',
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
      id: 'view.revealInExplorer',
      label: 'Reveal Active File in Explorer',
      category: 'View',
      keybinding: 'mod+shift+r',
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
    // Unity commands
    {
      id: 'unity.play',
      label: 'Play',
      category: 'Unity',
      keybinding: 'ctrl+shift+F5',
      handler: () => useUnityStore.getState().sendPlay(),
      when: () => useProjectContextStore.getState().isUnityProject,
    },
    {
      id: 'unity.pause',
      label: 'Pause',
      category: 'Unity',
      keybinding: 'ctrl+shift+F6',
      handler: () => useUnityStore.getState().sendPause(),
      when: () => useProjectContextStore.getState().isUnityProject,
    },
    {
      id: 'unity.stop',
      label: 'Stop',
      category: 'Unity',
      keybinding: 'ctrl+shift+F10',
      handler: () => useUnityStore.getState().sendStop(),
      when: () => useProjectContextStore.getState().isUnityProject,
    },
    {
      id: 'unity.step',
      label: 'Step',
      category: 'Unity',
      keybinding: 'ctrl+shift+F11',
      handler: () => useUnityStore.getState().sendStep(),
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
      handler: () => useUnityStore.getState().clearLogs(),
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
                            {activeFilePath ? <EditorPanel /> : <WelcomeScreen hasWorkspace />}
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
                  visible={rightSidebarVisible}
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
      {aiPanelMaximized && (
        <MaximizedAiOverlay>
          <AiChatPanel />
        </MaximizedAiOverlay>
      )}
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
      {dotnetMissingModalOpen && (
        <DotnetMissingModal onClose={() => setDotnetMissingModalOpen(false)} />
      )}
    </div>
  );
}

export default App;
