import { describe, it, expect, beforeEach } from 'bun:test';
import {
  consumePendingOpenForWorkspace,
  routePendingOpenToProjectWindow,
  type OpenRequest,
  type StartupOpenDeps,
} from './startup-open';

// Deliberately no `mock.module` here. Bun applies a module mock to the whole
// test PROCESS, so mocking `./multi-window` from this file replaced it for
// every other test file in the run — which is how `project-drop.test.ts`
// started failing on a function it imports for real. The module takes its
// dependencies as an argument instead.

/** Every side effect, in the order it happened. Ordering is the point of two
 *  of these tests, so a flat log beats per-mock counters. */
let calls: string[] = [];

let claimResult: OpenRequest | null = null;
let peekResult: OpenRequest | null = null;
let claimedWorkspace: string | null | undefined;
let claimRejects = false;
let peekRejects = false;
let openFileRejects = false;
let openedFile: { path: string; name: string } | null = null;
let navigation: { line: number; column: number } | null = null;
let openProjectRejects: Error | null = null;
let openedProject: string | null = null;

const deps: StartupOpenDeps = {
  claim: async (workspacePath) => {
    calls.push('claim');
    claimedWorkspace = workspacePath;
    if (claimRejects) throw new Error('ipc down');
    return claimResult;
  },
  peek: async () => {
    calls.push('peek');
    if (peekRejects) throw new Error('ipc down');
    return peekResult;
  },
  raiseWindow: async () => {
    calls.push('raise');
  },
  setNavigation: (nav) => {
    calls.push(nav ? 'setNavigation' : 'clearNavigation');
    navigation = nav;
  },
  openFile: async (path, name) => {
    calls.push('openFile');
    if (openFileRejects) throw new Error('gone');
    openedFile = { path, name };
  },
  openProject: async (path) => {
    calls.push('openProject');
    if (openProjectRejects) throw openProjectRejects;
    openedProject = path;
  },
};

function request(overrides: Partial<OpenRequest> = {}): OpenRequest {
  return { project: '/Proj', file: null, line: 1, column: 1, ...overrides };
}

beforeEach(() => {
  calls = [];
  claimResult = null;
  peekResult = null;
  claimedWorkspace = undefined;
  claimRejects = false;
  peekRejects = false;
  openFileRejects = false;
  openedFile = null;
  navigation = null;
  openProjectRejects = null;
  openedProject = null;
});

describe('consumePendingOpenForWorkspace', () => {
  it('does nothing when no request is pending', async () => {
    expect(await consumePendingOpenForWorkspace('/Proj', deps)).toBe(false);
    expect(calls).toEqual(['claim']);
  });

  it('passes the workspace so Rust can decide whether the request is ours', async () => {
    await consumePendingOpenForWorkspace('/Proj', deps);
    expect(claimedWorkspace).toBe('/Proj');
  });

  /** "Open Project in UnityIDE" on an app that is already running: there is no
   *  file, and raising the window IS the whole visible outcome. */
  it('raises the window and opens no file for a project-only request', async () => {
    claimResult = request();
    expect(await consumePendingOpenForWorkspace('/Proj', deps)).toBe(true);
    expect(calls).toEqual(['claim', 'raise']);
    expect(openedFile).toBeNull();
  });

  /**
   * EditorPanel consumes the pending navigation on the activeFilePath effect
   * that openFile triggers, so setting it afterwards lands one tab too late.
   */
  it('sets the navigation before opening the file', async () => {
    claimResult = request({ file: '/Proj/Assets/Player.cs', line: 42, column: 7 });

    expect(await consumePendingOpenForWorkspace('/Proj', deps)).toBe(true);
    expect(calls).toEqual(['claim', 'raise', 'setNavigation', 'openFile']);
    expect(navigation).toEqual({ line: 42, column: 7 });
    expect(openedFile).toEqual({ path: '/Proj/Assets/Player.cs', name: 'Player.cs' });
  });

  it('derives the tab name from a Windows path too', async () => {
    claimResult = request({ project: 'C:\\Proj', file: 'C:\\Proj\\Assets\\Player.cs' });
    await consumePendingOpenForWorkspace('C:\\Proj', deps);
    expect(openedFile?.name).toBe('Player.cs');
  });

  /**
   * The file may have been deleted between the double-click and now. The
   * project is open and focused either way, and a stale pending navigation
   * would otherwise jump the NEXT tab the user opens to line 42.
   */
  it('still counts as claimed when the file cannot be opened, and clears the navigation', async () => {
    claimResult = request({ file: '/Proj/Gone.cs', line: 42, column: 7 });
    openFileRejects = true;

    expect(await consumePendingOpenForWorkspace('/Proj', deps)).toBe(true);
    expect(calls).toEqual(['claim', 'raise', 'setNavigation', 'openFile', 'clearNavigation']);
    expect(navigation).toBeNull();
  });

  it('reports no claim when the IPC call fails', async () => {
    claimRejects = true;
    expect(await consumePendingOpenForWorkspace('/Proj', deps)).toBe(false);
  });
});

describe('routePendingOpenToProjectWindow', () => {
  it('opens the project window for a pending request', async () => {
    peekResult = request({ project: '/Proj', file: '/Proj/Assets/Player.cs' });
    expect(await routePendingOpenToProjectWindow(deps)).toBe(true);
    expect(openedProject).toBe('/Proj');
  });

  /** Peeks, never claims: consuming here would strand the request in the
   *  welcome window, which cannot open a file. */
  it('does not claim the request', async () => {
    peekResult = request();
    await routePendingOpenToProjectWindow(deps);
    expect(calls).not.toContain('claim');
  });

  it('routes nothing when there is no request, or no project in it', async () => {
    expect(await routePendingOpenToProjectWindow(deps)).toBe(false);

    peekResult = request({ project: null, file: '/loose/File.cs' });
    expect(await routePendingOpenToProjectWindow(deps)).toBe(false);
    expect(openedProject).toBeNull();
  });

  /**
   * A moved project, or a window that failed to spawn. Reporting false is what
   * makes the welcome window show itself — it starts hidden so a launch from
   * Unity does not flash a panel on the way to the project, and an unrouted
   * request would otherwise leave the app running with no visible window.
   */
  it('reports failure when the project window cannot be opened', async () => {
    peekResult = request();
    openProjectRejects = new Error('Project folder not found: /Proj');
    expect(await routePendingOpenToProjectWindow(deps)).toBe(false);
  });

  it('reports failure when the IPC call fails', async () => {
    peekRejects = true;
    expect(await routePendingOpenToProjectWindow(deps)).toBe(false);
  });
});
