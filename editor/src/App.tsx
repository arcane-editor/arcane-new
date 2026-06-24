import { useEffect, useMemo, useRef, useState } from 'react';
import { Allotment } from 'allotment';
import { open } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import 'allotment/dist/style.css';
import {
  ActivityBar,
  BottomPanel,
  KeyboardShortcutManager,
  RightActivityBar,
  RightSidebarPanel,
  SidebarPanel,
  StatusBar,
  TabBar,
  TitleBar,
} from './features/app-shell';
import { EditorPanel, Breadcrumbs, EditorErrorBoundary } from './features/editor';
import {
  WelcomeScreen,
  openWelcomeWindow,
  openFolderInNewWindow,
  setProjectWindowTitle,
} from './features/project';
import { AiChatPanel, MaximizedAiOverlay } from './features/ai-panel';
import { GraphifyIntroModal, computeBuildOpts, startGraphifyAutoRebuild } from './features/graphify';
import { initAsmdefFeature } from './features/asmdef';
import { initUnityPackagesFeature } from './features/unity-packages';
import { classifyFile, DotnetMissingModal, FilePriority, NewScriptModal } from './features/csharp';
import { useGraphifyStore } from './stores/graphify';
import { ThemePicker, applyTheme } from './features/theme';
import { NotificationContainer } from './features/notifications';
import { SettingsPanel } from './features/settings';
import { PaletteModal } from './features/command-palette';
import { BranchPicker, runGitignoreDoctor } from './features/git';
import { UnityAssetPickerModal, type UnityPickerMode } from './features/unity-quick-open';
import { useUnitySceneStore } from './stores/unity-scene';
import { useRegisterCommands } from './hooks/useRegisterCommands';
import { useAutoSave } from './hooks/useAutoSave';
import { useCloseGuard } from './hooks/useCloseGuard';
import { useNotificationsStore } from './stores/notifications';
import { useCommandsStore } from './stores/commands';
import { listen } from '@tauri-apps/api/event';
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
import { AuthTab } from './features/auth';
import { useSceneUsageStore } from './features/unity-context';
import { loadState, saveState, loadLayoutSizes, saveLayoutSizes } from './utils/persistence';
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
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const aiPanelMaximized = useUiStore((s) => s.aiPanelMaximized);
  const graphifyIntroOpen = useUiStore((s) => s.graphifyIntroOpen);
  const setGraphifyIntroOpen = useUiStore((s) => s.setGraphifyIntroOpen);
  const dotnetMissingModalOpen = useUiStore((s) => s.dotnetMissingModalOpen);
  const setDotnetMissingModalOpen = useUiStore((s) => s.setDotnetMissingModalOpen);
  const restoredRef = useRef(false);
  const [showThemePicker, setShowThemePicker] = useState(false);
  const [paletteMode, setPaletteMode] = useState<'commands' | 'files' | null>(null);
  const [showBranchPicker, setShowBranchPicker] = useState(false);
  const [unityPicker, setUnityPicker] = useState<UnityPickerMode | null>(null);
  const [newScriptDir, setNewScriptDir] = useState<string | null>(null);
  const persistedLayout = useMemo(() => loadLayoutSizes(), []);

  // Restore persisted state on mount
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;

    useSettingsStore.getState().loadSettings();
    useAuthStore.getState().loadFromDisk();
    useRecentsStore.getState().reload();
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
          for (const file of persisted?.openFilePaths ?? []) {
            try {
              await store.openFile(file.path, file.name);
            } catch {
              // File may have been deleted — skip
            }
          }
          if (persisted?.activeFilePath) {
            store.setActiveFile(persisted.activeFilePath);
          }
        }
      });
    }
  }, []);

  // Set window title from workspace path
  useEffect(() => {
    setProjectWindowTitle(workspacePath ?? null);
  }, [workspacePath]);

  // Listen for explicit "open this project in this window" events
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const fn = await getCurrentWindow().listen<{ path: string }>('open-project', (e) => {
        if (e.payload?.path) {
          useWorkspaceStore.getState().setWorkspace(e.payload.path);
        }
      });
      if (cancelled) safeUnlisten(fn);
      else unlisten = fn;
    })();
    return () => {
      cancelled = true;
      safeUnlisten(unlisten);
    };
  }, []);

  // Auto-save hook
  useAutoSave();

  // Unsaved-changes prompt on window close
  useCloseGuard();

  // Native menu (macOS): bridge menu-action events to the command registry
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const fn = await listen<string>('menu-action', (event) => {
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

  // Open files dragged from the OS file manager into the editor as tabs.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const win = getCurrentWindow();
      const fn = await win.onDragDropEvent(async (event) => {
        if (event.payload.type !== 'drop') return;
        const paths = event.payload.paths;
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
          openFilePaths: state.openFiles
            .filter((f) => !f.path.startsWith('diff://') && !f.path.startsWith('auth://'))
            .map((f) => ({ path: f.path, name: f.name })),
          activeFilePath: (state.activeFilePath?.startsWith('diff://') || state.activeFilePath?.startsWith('auth://')) ? null : state.activeFilePath,
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
      keybinding: 'mod+`',
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
      handler: async () => {
        const selected = await open({
          directory: true,
          multiple: false,
          title: 'Open Folder',
        });
        if (selected) {
          await useWorkspaceStore.getState().setWorkspace(selected as string);
        }
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
      id: 'file.openFolderNewWindow',
      label: 'Open Folder in New Window…',
      category: 'File',
      handler: () => { openFolderInNewWindow(); },
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
        const ui = useUiStore.getState();
        ui.setSettingsOpen(!ui.settingsOpen);
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
      keybinding: 'mod+j',
      handler: () => {
        useUiStore.getState().toggleBottomPanel();
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
      handler: () => setShowBranchPicker(true),
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
        const ws = useWorkspaceStore.getState();
        ws.openFile('auth://account', 'Account').catch(() => {});
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
                onChange={(sizes) =>
                  saveLayoutSizes(
                    rightSidebarVisible && sizes.length > 0
                      ? { main: sizes, rightPanel: sizes[sizes.length - 1] }
                      : { main: sizes },
                  )
                }
                defaultSizes={persistedLayout.main}
              >
                {sidebarVisible && (
                  <Allotment.Pane preferredSize={persistedLayout.main?.[0] ?? 250} minSize={150} maxSize={500}>
                    <SidebarPanel />
                  </Allotment.Pane>
                )}
                <Allotment.Pane>
                  <div className="editor-area">
                    <Allotment vertical onChange={(sizes) => saveLayoutSizes({ vertical: sizes })}>
                      <Allotment.Pane>
                        <div className="editor-section">
                          {settingsOpen ? (
                            <SettingsPanel onClose={() => useUiStore.getState().setSettingsOpen(false)} />
                          ) : (
                            <>
                              <TabBar />
                              {activeFilePath?.startsWith('auth://') ? (
                                <AuthTab />
                              ) : (
                                <>
                                  <Breadcrumbs />
                                  <EditorErrorBoundary>
                                    {activeFilePath ? <EditorPanel /> : <WelcomeScreen hasWorkspace />}
                                  </EditorErrorBoundary>
                                </>
                              )}
                            </>
                          )}
                        </div>
                      </Allotment.Pane>
                      {bottomPanelVisible && (
                        <Allotment.Pane preferredSize={250} minSize={100} maxSize={600}>
                          <BottomPanel />
                        </Allotment.Pane>
                      )}
                    </Allotment>
                  </div>
                </Allotment.Pane>
                {rightSidebarVisible && (
                  <Allotment.Pane preferredSize={persistedLayout.rightPanel ?? 300} minSize={200}>
                    <RightSidebarPanel />
                  </Allotment.Pane>
                )}
              </Allotment>
            </div>
            <RightActivityBar />
          </>
        ) : (
          <WelcomeScreen />
        )}
      </div>
      <StatusBar />
      <NotificationContainer />
      {showThemePicker && (
        <ThemePicker onClose={() => setShowThemePicker(false)} />
      )}
      {paletteMode && (
        <PaletteModal initialMode={paletteMode} onClose={() => setPaletteMode(null)} />
      )}
      {showBranchPicker && (
        <BranchPicker onClose={() => setShowBranchPicker(false)} />
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
