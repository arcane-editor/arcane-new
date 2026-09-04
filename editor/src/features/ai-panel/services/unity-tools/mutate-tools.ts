// Unity engine-mutate agent tools (F-5.2 + F-5.6 tier 3). Each blocks on an
// explicit inline approval before touching the engine (see approval-gate.ts).
// Only registered in agent / plan-execution modes.

import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '../vendor/types';
import { bridgeRpc } from '../../../unity-bridge';
import { useUnityStore } from '../../../../stores/unity';
import { useSettingsStore } from '../../../../stores/settings';
import { requestEngineApproval } from '../approval-gate';
import { txt, bridgeConnected } from './shared';
import { describeTestRunOutcome } from './test-run-outcome-text';
import { recordTestRunForConsoleCheck } from './test-run-registry';

/** Run an engine action behind the connection check + inline approval gate. */
async function gated(
  toolCallId: string,
  toolName: string,
  verb: string,
  signal: AbortSignal | undefined,
  action: () => Promise<AgentToolResult>,
): Promise<AgentToolResult> {
  if (!bridgeConnected()) return txt(`Cannot ${verb}: Unity Editor not connected.`);
  const decision = await requestEngineApproval(toolCallId, toolName, verb, signal);
  if (decision !== 'approve') return txt(`User rejected the Unity action (${verb}).`);
  try {
    return await action();
  } catch (e) {
    return txt(`${verb} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function createUnityPlay(): AgentTool {
  return {
    name: 'unity_play',
    label: 'unity play',
    description: 'Enter Play Mode in the connected Unity Editor. Requires user approval.',
    parameters: Type.Object({}),
    execute: (id, _p, signal) =>
      gated(id, 'unity_play', 'enter Play Mode', signal, async () => {
        await useUnityStore.getState().sendPlay();
        return txt('Requested Play Mode.');
      }),
  };
}

function createUnityStop(): AgentTool {
  return {
    name: 'unity_stop',
    label: 'unity stop',
    description: 'Exit Play Mode in the connected Unity Editor. Requires user approval.',
    parameters: Type.Object({}),
    execute: (id, _p, signal) =>
      gated(id, 'unity_stop', 'exit Play Mode', signal, async () => {
        await useUnityStore.getState().sendStop();
        return txt('Requested exit from Play Mode.');
      }),
  };
}

function createUnityRefresh(): AgentTool {
  return {
    name: 'unity_refresh',
    label: 'unity refresh',
    description:
      'Trigger an Asset Database refresh / script recompile in Unity (after file changes). Requires user approval.',
    parameters: Type.Object({}),
    execute: (id, _p, signal) =>
      gated(id, 'unity_refresh', 'refresh assets', signal, async () => {
        await bridgeRpc.refreshAssets();
        return txt('Asset refresh requested.');
      }),
  };
}

const runTestsSchema = Type.Object({
  mode: Type.Optional(
    Type.Union([Type.Literal('EditMode'), Type.Literal('PlayMode')], {
      description: "Test mode (default 'EditMode').",
    }),
  ),
  filter: Type.Optional(Type.String({ description: 'Optional NUnit full-name filter.' })),
  timeoutSec: Type.Optional(
    Type.Integer({
      description:
        'Override how long to wait for the run to finish, in seconds, clamped to 10-3600 ' +
        '(default 300 for EditMode, 900 for PlayMode).',
    }),
  ),
});

/** Min/max `unity_run_tests(timeoutSec:...)` — see MIN_TIMEOUT_SEC/MAX_TIMEOUT_SEC. */
const MIN_TIMEOUT_SEC = 10;
const MAX_TIMEOUT_SEC = 3600;

/** 0/negative/absent all mean "use the per-mode default"; anything else is clamped to [10, 3600]. */
function clampTimeoutSec(timeoutSec: number | undefined): number | undefined {
  if (timeoutSec == null || timeoutSec <= 0) return undefined;
  return Math.min(MAX_TIMEOUT_SEC, Math.max(MIN_TIMEOUT_SEC, timeoutSec));
}

function createUnityRunTests(): AgentTool {
  return {
    name: 'unity_run_tests',
    label: 'unity run tests',
    description:
      'Run Unity tests via the Test Runner and wait for the result — pass/fail counts and, for any ' +
      'failure, its message and where it happened. Requires user approval.',
    parameters: runTestsSchema,
    execute: (id, params, signal) => {
      const { mode = 'EditMode', filter, timeoutSec } = params as Static<typeof runTestsSchema>;
      return gated(id, 'unity_run_tests', `run ${mode} tests`, signal, async () => {
        // Dynamic import: `unity-test-runner`'s barrel re-exports `TestPanel`
        // (a React component), which would drag DOM-touching code into scope
        // if imported statically — see Global Constraint 4 / `ui-toolkit-tool.ts`
        // for the same seam.
        const { waitForTestRun } = await import('../../../unity-test-runner');
        const clamped = clampTimeoutSec(timeoutSec);
        const outcome = await waitForTestRun(mode, filter, {
          signal,
          timeoutMs: clamped != null ? clamped * 1000 : undefined,
        });
        // Only a REAL run — Task 13's console check must not think a run
        // happened when it never started (`ok:false` means Unity refused or
        // couldn't, not that anything ran).
        if (outcome.status === 'report' && outcome.summary.ok) {
          recordTestRunForConsoleCheck(outcome.summary);
        }
        return txt(describeTestRunOutcome(outcome));
      });
    },
  };
}

function createUnityConsoleClear(): AgentTool {
  return {
    name: 'unity_console_clear',
    label: 'unity console clear',
    description:
      "Clear Unity's console (and this IDE's log ring). Requires user approval.",
    parameters: Type.Object({}),
    execute: (id, _p, signal) =>
      gated(id, 'unity_console_clear', 'clear the Unity console', signal, async () => {
        const { clearedUnity, unityReason } = await useUnityStore.getState().clearLogs({ unity: true });
        return txt(clearedUnity ? "Cleared Unity's console." : unityReason ?? "Unity's console was not cleared.");
      }),
  };
}

const menuItemSchema = Type.Object({
  path: Type.String({ description: 'Menu path, e.g. "Assets/Refresh".' }),
});

function createUnityExecuteMenuItem(): AgentTool {
  return {
    name: 'unity_execute_menu_item',
    label: 'unity execute menu item',
    description:
      'Execute a Unity Editor menu item by path (e.g. "Assets/Refresh"). Requires user approval.',
    parameters: menuItemSchema,
    execute: (id, params, signal) => {
      const { path } = params as Static<typeof menuItemSchema>;
      return gated(id, 'unity_execute_menu_item', `execute menu item "${path}"`, signal, async () => {
        const r = await bridgeRpc.executeMenuItem(path);
        return txt(r.ok ? `Executed "${path}".` : `Menu item "${path}" not found.`);
      });
    },
  };
}

/** Engine-mutate Unity tools, filtered by their enabling settings. */
export function createUnityMutateTools(): AgentTool[] {
  const get = useSettingsStore.getState().getSetting;
  const tools: AgentTool[] = [];
  if (get('unity.bridge.enabled') !== false) {
    tools.push(
      createUnityPlay(),
      createUnityStop(),
      createUnityRefresh(),
      createUnityExecuteMenuItem(),
      createUnityConsoleClear(),
    );
  }
  if (get('unity.testRunner.enabled') !== false) {
    tools.push(createUnityRunTests());
  }
  // Every mutate tool blocks on `gated()` HUMAN approval (and unity_run_tests
  // additionally awaits the run itself — up to 15 minutes for PlayMode) — opt
  // out of the loop's per-tool budget so a user away from the keyboard, or a
  // slow test suite, doesn't cause spurious timeouts. The abort signal still
  // cuts through (Stop always works, and `waitForTestRun` races it).
  return tools.map((t) => ({ ...t, timeoutMs: Number.POSITIVE_INFINITY }));
}
