import { getMonaco } from '../../editor';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useProjectContextStore } from '../../../stores/project-context';
import { useAsmdefStore, initAsmdefIndexListener } from '../../../stores/asmdef';
import { startReferenceDiagnostics, stopReferenceDiagnostics } from './reference-diagnostics';

// Whether the live (Unity-only) machinery is currently wired up.
let active = false;
let stopDiagnostics: (() => void) | null = null;

/**
 * Activate asmdef awareness for the current workspace. Intended to be called
 * once on app mount; it is internally inert for non-Unity projects:
 *  - the file-index-changed listener self-gates on `isUnityProject`,
 *  - the diagnostics watcher self-gates on `isUnityProject` + the setting,
 *  - the graph is only built for Unity workspaces.
 *
 * It also subscribes to project-context so that when a Unity project is opened
 * (or the workspace switches to one) the graph is (re)built, and tears the
 * graph down when leaving a Unity project. Returns a disposer (used in tests /
 * teardown; App mounts it for the process lifetime).
 */
export function initAsmdefFeature(): () => void {
  // The file-index-changed → debounced refresh listener is always installed
  // but no-ops outside Unity projects.
  initAsmdefIndexListener();

  // Build the graph + start diagnostics for the current project if it's Unity,
  // and react to future project-type transitions.
  syncForCurrentProject();
  const unsub = useProjectContextStore.subscribe((state, prev) => {
    if (state.isUnityProject !== prev.isUnityProject) {
      syncForCurrentProject();
    }
  });

  return () => {
    unsub();
    teardown();
  };
}

function syncForCurrentProject(): void {
  if (useProjectContextStore.getState().isUnityProject) {
    activate();
  } else {
    teardown();
  }
}

let monacoPoll: ReturnType<typeof setInterval> | null = null;

function activate(): void {
  const workspacePath = useWorkspaceStore.getState().workspacePath;
  if (workspacePath) {
    void useAsmdefStore.getState().refresh(workspacePath);
  }
  if (active) return; // already wired — refresh above is enough
  active = true;
  startDiagnosticsWhenMonacoReady();
}

/**
 * The marker watcher needs a Monaco instance, which only exists once an editor
 * has mounted. Markers can't appear before that anyway, so poll briefly until
 * Monaco is available, then start the watcher. Bails if the project flips to
 * non-Unity while we wait.
 */
function startDiagnosticsWhenMonacoReady(): void {
  if (monacoPoll) return;
  const tryStart = (): boolean => {
    if (!active || !useProjectContextStore.getState().isUnityProject) {
      return true; // stop polling
    }
    const monaco = getMonaco();
    if (monaco) {
      stopDiagnostics = startReferenceDiagnostics(monaco);
      return true;
    }
    return false;
  };
  if (tryStart()) return;
  monacoPoll = setInterval(() => {
    if (tryStart()) {
      if (monacoPoll) clearInterval(monacoPoll);
      monacoPoll = null;
    }
  }, 500);
}

function teardown(): void {
  if (monacoPoll) {
    clearInterval(monacoPoll);
    monacoPoll = null;
  }
  if (stopDiagnostics) {
    stopDiagnostics();
    stopDiagnostics = null;
  } else {
    stopReferenceDiagnostics();
  }
  useAsmdefStore.getState().reset();
  active = false;
}
