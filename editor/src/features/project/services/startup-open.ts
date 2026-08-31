import { invoke } from '@tauri-apps/api/core';
import { setPendingNavigation } from '../../../utils/editor-navigation';
import { openProjectInNewWindow } from './multi-window';
import { raiseCurrentWindow } from '../../../utils/window-focus';

/**
 * A project (and optionally a file position) the app was launched to open,
 * collected from the Rust side (`cli.rs`).
 *
 * Unity reaches us two ways and both land here:
 *   - `UnityIDE --goto "<file>:<line>:<col>" "<project>"` — the configured
 *     external script editor, i.e. double-clicking a script.
 *   - `UnityIDE --project "<project>"` — "Open Project in UnityIDE", and
 *     Unity's own `Assets > Open C# Project`.
 *
 * `file` is null for the second shape, which is why it is not simply a "goto".
 */
export interface OpenRequest {
  project: string | null;
  file: string | null;
  line: number;
  column: number;
}

/**
 * Everything this module reaches for outside itself.
 *
 * Injected rather than imported at the call sites so the tests can supply
 * their own without `mock.module`. That matters here specifically: bun applies
 * a module mock to the whole test PROCESS, so mocking `./multi-window` from
 * this file's test silently replaced it for every other test file in the run
 * too — which is exactly how `project-drop.test.ts` started failing on a
 * function it imports for real. Same shape as `openDroppedProject`'s injected
 * `openProject` next door.
 */
export interface StartupOpenDeps {
  claim(workspacePath: string | null): Promise<OpenRequest | null>;
  peek(): Promise<OpenRequest | null>;
  raiseWindow(): Promise<void>;
  setNavigation(nav: { line: number; column: number } | null): void;
  openFile(path: string, name: string): Promise<void>;
  openProject(path: string): Promise<void>;
}

const defaultDeps: StartupOpenDeps = {
  claim: (workspacePath) => invoke<OpenRequest | null>('claim_pending_open', { workspacePath }),
  peek: () => invoke<OpenRequest | null>('peek_pending_open'),
  raiseWindow: raiseCurrentWindow,
  setNavigation: setPendingNavigation,
  // Imported at call time, not module-load time. `stores/workspace` pulls in
  // the theme store, which touches `document` while it initialises — so a
  // static import here would make this module unloadable in a plain `bun test`
  // process and force every test that touches it back onto process-wide module
  // mocks. Vite resolves this to the same chunk App.tsx already imports
  // statically, so it costs no extra bundle.
  openFile: async (path, name) => {
    const { useWorkspaceStore } = await import('../../../stores/workspace');
    await useWorkspaceStore.getState().openFile(path, name);
  },
  openProject: openProjectInNewWindow,
};

/** Paths arrive `/`-separated from Rust (`path_util.rs`); normalise anyway. */
function basename(p: string): string {
  return p.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? p;
}

/**
 * Claim a pending open request for this project window and act on it.
 *
 * The claim is conditional on the Rust side: a request carrying a different
 * project is left pending for the window that owns it, so several windows can
 * boot concurrently without any of them swallowing another's request.
 *
 * Returns true when a request was claimed.
 */
export async function consumePendingOpenForWorkspace(
  workspacePath: string | null,
  deps: StartupOpenDeps = defaultDeps,
): Promise<boolean> {
  let request: OpenRequest | null = null;
  try {
    request = await deps.claim(workspacePath);
  } catch {
    return false;
  }
  if (!request) return false;

  // Raise before opening, not after: the user acted in Unity and is waiting to
  // see this window. A large file taking a moment to load should happen in
  // front of them, not behind Unity.
  await deps.raiseWindow();

  if (request.file) {
    // Set the navigation before opening: EditorPanel consumes it on the
    // activeFilePath effect, which fires as a result of openFile.
    deps.setNavigation({ line: request.line, column: request.column });
    try {
      await deps.openFile(request.file, basename(request.file));
    } catch {
      // The file may have been deleted or renamed between the double-click and
      // now. The project is open and focused either way, which is most of what
      // was asked for — but a pending navigation left behind would jump the
      // NEXT tab the user opens to line 42.
      deps.setNavigation(null);
    }
  }
  return true;
}

/**
 * Welcome-window half: if a request is waiting for a project no window has
 * open, open that project. The window that boots then claims the request itself
 * via `consumePendingOpenForWorkspace`.
 *
 * Peeks rather than claims — consuming here would strand the request in a
 * window that cannot act on it.
 *
 * Returns true only when a project window was actually opened. The welcome
 * window uses a false to decide it should show itself: it starts hidden so a
 * launch from Unity does not flash a 720x480 panel on the way to the project,
 * and if there is nothing to route it is the only surface left.
 */
export async function routePendingOpenToProjectWindow(
  deps: StartupOpenDeps = defaultDeps,
): Promise<boolean> {
  let request: OpenRequest | null = null;
  try {
    request = await deps.peek();
  } catch {
    return false;
  }
  if (!request?.project) return false;

  try {
    await deps.openProject(request.project);
  } catch {
    // A moved or deleted project, or a window that failed to spawn. Report it
    // as unrouted so the welcome window shows itself and the user gets an
    // actionable surface instead of an app with no visible window.
    return false;
  }
  return true;
}
