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
});

function createUnityRunTests(): AgentTool {
  return {
    name: 'unity_run_tests',
    label: 'unity run tests',
    description:
      'Run Unity tests via the Test Runner. Results stream into the Test panel. Requires user approval.',
    parameters: runTestsSchema,
    execute: (id, params, signal) => {
      const { mode = 'EditMode', filter } = params as Static<typeof runTestsSchema>;
      return gated(id, 'unity_run_tests', `run ${mode} tests`, signal, async () => {
        await bridgeRpc.runTests(mode, filter);
        return txt(`Started ${mode} test run${filter ? ` (filter: ${filter})` : ''}. See the Test panel for results.`);
      });
    },
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
    tools.push(createUnityPlay(), createUnityStop(), createUnityRefresh(), createUnityExecuteMenuItem());
  }
  if (get('unity.testRunner.enabled') !== false) {
    tools.push(createUnityRunTests());
  }
  return tools;
}
