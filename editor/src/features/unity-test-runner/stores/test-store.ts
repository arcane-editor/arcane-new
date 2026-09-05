import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { bridgeRpc } from '../../unity-bridge';
import { useUnityStore } from '../../../stores/unity';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useProjectContextStore } from '../../../stores/project-context';
import { useDebugStore } from '../../../stores/debug';
import { notify } from '../../../stores/notifications';
import type { TestRunCompletedPayload } from '../../../types/unity';

export type TestMode = 'EditMode' | 'PlayMode';
export type TestStatus = 'passed' | 'failed' | 'skipped' | 'running' | 'not-run';

// Mirrors the Rust unity_tests.rs serde (camelCase).
export interface TestNode {
  id: string;
  name: string;
  fixture: string;
  assembly: string;
  mode: TestMode;
  filePath: string;
  line: number;
  fullName: string;
}
export interface TestFixtureDTO {
  fqn: string;
  filePath: string;
  tests: TestNode[];
}
export interface TestAssemblyDTO {
  name: string;
  mode: TestMode;
  rootFolder: string;
  fixtures: TestFixtureDTO[];
}

export interface TestResult {
  status: TestStatus;
  durationMs?: number;
  message?: string;
  stackTrace?: string;
}

interface RunState {
  active: boolean;
  mode: TestMode;
  source: 'bridge' | 'headless';
  total: number;
  done: number;
  passed: number;
  failed: number;
  /** The run's id, from the `runStarted` test_event's `runId` (absent for a pre-protocol-4 package). */
  runId?: string;
}

interface HeadlessResult {
  fullName: string;
  status: string;
  durationMs: number;
  message: string;
  stackTrace: string;
}
interface HeadlessSummary {
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  results: HeadlessResult[];
}

function normStatus(s: string): TestStatus {
  switch (s.toLowerCase()) {
    case 'passed':
      return 'passed';
    case 'failed':
      return 'failed';
    case 'skipped':
      return 'skipped';
    default:
      return 'not-run';
  }
}

interface TestState {
  assemblies: TestAssemblyDTO[];
  results: Map<string, TestResult>;
  run: RunState | null;
  discovering: boolean;
  /**
   * The most recent `test_run_completed` push, verbatim. `null` until the
   * first run of this session finishes — a caller awaiting a SPECIFIC run
   * (see `unity-test-runner/services/test-run-wait-core.ts`) matches on its
   * `runId`, not on this alone.
   */
  lastRunCompleted: TestRunCompletedPayload | null;

  discover: (workspacePath?: string) => Promise<void>;
  runAll: (mode: TestMode) => Promise<void>;
  runFiltered: (fullName: string, mode: TestMode) => Promise<void>;
  debugTest: (fullName: string, mode: TestMode) => Promise<void>;
  /** Apply a streamed `unity-test-event` payload (live bridge path). */
  applyEvent: (payload: Record<string, unknown>) => void;
  /** Apply a `unity-test-run-completed` push — the real completion of a queued `runTests`. */
  applyRunCompleted: (payload: TestRunCompletedPayload) => void;
}

export const useTestStore = create<TestState>((set, get) => ({
  assemblies: [],
  results: new Map(),
  run: null,
  discovering: false,
  lastRunCompleted: null,

  discover: async (workspacePath) => {
    const ws = workspacePath ?? useWorkspaceStore.getState().workspacePath;
    if (!ws) return;
    set({ discovering: true });
    try {
      const assemblies = await invoke<TestAssemblyDTO[]>('unity_tests_discover', {
        workspacePath: ws,
      });
      set({ assemblies, discovering: false });
    } catch (err) {
      console.warn('[TestRunner] discover failed:', err);
      set({ discovering: false });
    }
  },

  runAll: async (mode) => {
    await runWith(set, get, mode, undefined);
  },

  runFiltered: async (fullName, mode) => {
    await runWith(set, get, mode, fullName);
  },

  debugTest: async (fullName, mode) => {
    if (!useUnityStore.getState().connected) {
      notify.warning('Debugging tests requires a connected Unity Editor.');
      return;
    }
    try {
      await useDebugStore.getState().attach(false);
      await bridgeRpc.runTests(mode, fullName, crypto.randomUUID());
    } catch (err) {
      notify.error(`Debug test failed: ${err}`);
    }
  },

  applyEvent: (payload) => {
    const phase = payload.phase as string;
    if (phase === 'runStarted') {
      set({
        run: {
          active: true,
          mode: (payload.mode as TestMode) ?? 'EditMode',
          source: 'bridge',
          total: (payload.total as number) ?? 0,
          done: 0,
          passed: 0,
          failed: 0,
          runId: (payload.runId as string | null | undefined) ?? undefined,
        },
      });
    } else if (phase === 'testStarted') {
      const id = (payload.id as string) ?? (payload.fullName as string);
      if (id) markResult(set, id, { status: 'running' });
    } else if (phase === 'testFinished') {
      const id = (payload.id as string) ?? (payload.fullName as string);
      const status = normStatus((payload.status as string) ?? '');
      if (id) {
        markResult(set, id, {
          status,
          durationMs: payload.durationMs as number,
          message: payload.message as string,
          stackTrace: payload.stackTrace as string,
        });
      }
      set((s) =>
        s.run
          ? {
              run: {
                ...s.run,
                done: s.run.done + 1,
                passed: s.run.passed + (status === 'passed' ? 1 : 0),
                failed: s.run.failed + (status === 'failed' ? 1 : 0),
              },
            }
          : {},
      );
    } else if (phase === 'runFinished') {
      set((s) => (s.run ? { run: { ...s.run, active: false } } : {}));
    }
  },

  applyRunCompleted: (payload) => {
    set((s) => ({
      lastRunCompleted: payload,
      // The old `test_event` runFinished (above) already flips this for the
      // live path; this covers a caller that only listens for the completed
      // push, and is a no-op if runFinished already ran.
      run: s.run ? { ...s.run, active: false } : s.run,
    }));
  },
}));

function markResult(
  set: (fn: (s: TestState) => Partial<TestState>) => void,
  fullName: string,
  result: TestResult,
): void {
  set((s) => {
    const next = new Map(s.results);
    next.set(fullName, result);
    return { results: next };
  });
}

/** Shared run path: prefer the live bridge (streaming); fall back to headless. */
async function runWith(
  set: (fn: (s: TestState) => Partial<TestState>) => void,
  get: () => TestState,
  mode: TestMode,
  filter: string | undefined,
): Promise<void> {
  void get;
  if (useUnityStore.getState().connected) {
    // Live path — results stream via `unity-test-event` → applyEvent.
    try {
      await bridgeRpc.runTests(mode, filter, crypto.randomUUID());
    } catch (err) {
      notify.error(`Test run failed: ${err}`);
    }
    return;
  }

  // Headless fallback (Unity closed).
  const ws = useWorkspaceStore.getState().workspacePath;
  const version = useProjectContextStore.getState().unityVersion;
  if (!ws || !version) {
    notify.warning('Unity not connected and no editor version resolved — cannot run tests headlessly.');
    return;
  }
  set(() => ({ run: { active: true, mode, source: 'headless', total: 0, done: 0, passed: 0, failed: 0 } }));
  notify.info('Running tests headlessly (Unity batch mode) — this can take a while…');
  try {
    const summary = await invoke<HeadlessSummary>('unity_tests_run_headless', {
      workspacePath: ws,
      unityVersion: version,
      mode,
      filter: filter ?? null,
    });
    set((s) => {
      const next = new Map(s.results);
      for (const r of summary.results) {
        next.set(r.fullName, {
          status: normStatus(r.status),
          durationMs: r.durationMs,
          message: r.message,
          stackTrace: r.stackTrace,
        });
      }
      return {
        results: next,
        run: {
          active: false,
          mode,
          source: 'headless',
          total: summary.results.length,
          done: summary.results.length,
          passed: summary.passed,
          failed: summary.failed,
        },
      };
    });
  } catch (err) {
    notify.error(`Headless test run failed: ${err}`);
    set((s) => (s.run ? { run: { ...s.run, active: false } } : {}));
  }
}
