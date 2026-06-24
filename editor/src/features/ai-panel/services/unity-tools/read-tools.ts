// Unity read-only agent tools (F-5.2). Auto-approved tier. Each tool degrades
// gracefully when the bridge is offline (never throws), and `get_console_errors`
// + the static half of `find_asset_references` work fully offline.

import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool } from '../vendor/types';
import { bridgeRpc, type HierarchyNode } from '../../../unity-bridge';
import { useUnityStore } from '../../../../stores/unity';
import { useUnityIndexStore } from '../../../../stores/unity-index';
import { readScriptGuidFromMeta } from './script-guid';
import { txt, bridgeConnected, NOT_CONNECTED, cap } from './shared';

// ── get_console_errors (offline-safe: reads the local 10k log ring) ──────────

const consoleSchema = Type.Object({
  severity: Type.Optional(
    Type.Union([Type.Literal('error'), Type.Literal('warning'), Type.Literal('all')], {
      description: "Minimum severity to include. Default 'error'.",
    }),
  ),
  limit: Type.Optional(Type.Integer({ description: 'Max entries (default 50).' })),
});

function createGetConsoleErrors(): AgentTool {
  return {
    name: 'get_console_errors',
    label: 'get console errors',
    description:
      "Get recent Unity console entries captured this IDE session (works even if the bridge RPC channel is busy). Use this to inspect runtime errors/exceptions and their stack traces.",
    parameters: consoleSchema,
    async execute(_id, params) {
      const { severity = 'error', limit = 50 } = params as Static<typeof consoleSchema>;
      const logs = useUnityStore.getState().logs;
      const allow =
        severity === 'all'
          ? null
          : severity === 'warning'
            ? new Set(['Warning', 'Error', 'Assert', 'Exception'])
            : new Set(['Error', 'Assert', 'Exception']);
      const filtered = (allow ? logs.filter((l) => allow.has(l.logType)) : logs).slice(-limit);
      if (filtered.length === 0) return txt('No matching Unity console entries captured this session.');
      const body = filtered
        .map((l) => {
          const frames = (l.parsedFrames ?? [])
            .slice(0, 4)
            .map((f) => `    at ${f.className}.${f.methodName} (${f.filePath}:${f.lineNumber})`)
            .join('\n');
          return `[${l.logType}] ${l.message}${frames ? '\n' + frames : ''}`;
        })
        .join('\n\n');
      return txt(cap(`${filtered.length} console entr${filtered.length === 1 ? 'y' : 'ies'}:\n\n${body}`));
    },
  };
}

// ── get_editor_state ─────────────────────────────────────────────────────────

function createGetEditorState(): AgentTool {
  return {
    name: 'get_editor_state',
    label: 'get editor state',
    description:
      'Get the live Unity Editor state: play/pause/compile status, Unity version, and the list of open scenes. Requires a connected bridge.',
    parameters: Type.Object({}),
    async execute() {
      if (!bridgeConnected()) return txt(NOT_CONNECTED);
      try {
        const s = await bridgeRpc.getEditorState();
        return txt(
          `Unity ${s.unityVersion} — ${s.isPlaying ? (s.isPaused ? 'paused' : 'playing') : 'edit mode'}` +
            `${s.isCompiling ? ' (compiling)' : ''}\nOpen scenes: ${s.activeScenes.join(', ') || '(none)'}`,
        );
      } catch (e) {
        return txt(`Could not read editor state: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

// ── get_scene_hierarchy ──────────────────────────────────────────────────────

function formatNode(n: HierarchyNode, depth: number, maxDepth: number, out: string[]): void {
  const indent = '  '.repeat(depth);
  const comps = n.components.map((c) => c.type).join(', ');
  out.push(`${indent}${n.name}${n.active ? '' : ' (inactive)'} [${comps || 'no components'}]`);
  if (depth < maxDepth) {
    for (const c of n.children) formatNode(c, depth + 1, maxDepth, out);
  } else if (n.children.length > 0) {
    out.push(`${indent}  …${n.children.length} more (depth limit)`);
  }
}

const hierarchySchema = Type.Object({
  maxDepth: Type.Optional(Type.Integer({ description: 'Tree depth to render (default 6).' })),
});

function createGetSceneHierarchy(): AgentTool {
  return {
    name: 'get_scene_hierarchy',
    label: 'get scene hierarchy',
    description:
      'Get the live GameObject hierarchy of the open scene(s) in Unity, with each object\'s component types. Requires a connected bridge.',
    parameters: hierarchySchema,
    async execute(_id, params) {
      if (!bridgeConnected()) return txt(NOT_CONNECTED);
      const { maxDepth = 6 } = params as Static<typeof hierarchySchema>;
      try {
        const h = await bridgeRpc.getSceneHierarchy();
        const out: string[] = [];
        for (const scene of h.scenes) {
          out.push(`# Scene: ${scene.name}`);
          for (const root of scene.roots) formatNode(root, 0, maxDepth, out);
        }
        if (h.truncated) out.push('…(hierarchy truncated by the bridge — large scene)');
        return txt(cap(out.join('\n') || '(no open scenes)'));
      } catch (e) {
        return txt(`Could not read hierarchy: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

// ── get_game_object ──────────────────────────────────────────────────────────

const gameObjectSchema = Type.Object({
  instanceId: Type.Optional(Type.Integer({ description: 'Instance id (preferred).' })),
  path: Type.Optional(Type.String({ description: 'Hierarchy path "Parent/Child".' })),
});

function createGetGameObject(): AgentTool {
  return {
    name: 'get_game_object',
    label: 'get game object',
    description:
      'Get a live GameObject\'s components and their serialized property values from Unity, by instanceId or hierarchy path. Use after get_scene_hierarchy to inspect a specific object (e.g. to check whether a serialized field is assigned). Requires a connected bridge.',
    parameters: gameObjectSchema,
    async execute(_id, params) {
      if (!bridgeConnected()) return txt(NOT_CONNECTED);
      const t = params as Static<typeof gameObjectSchema>;
      if (t.instanceId == null && !t.path) return txt('Provide instanceId or path.');
      try {
        const go = await bridgeRpc.getGameObject(t);
        return txt(cap(JSON.stringify(go, null, 1)));
      } catch (e) {
        return txt(`Could not read GameObject: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

// ── find_asset_references ────────────────────────────────────────────────────

const refsSchema = Type.Object({
  scriptPath: Type.Optional(Type.String({ description: 'Absolute path to a .cs script.' })),
  guid: Type.Optional(Type.String({ description: 'Asset GUID (alternative to scriptPath).' })),
});

function createFindAssetReferences(): AgentTool {
  return {
    name: 'find_asset_references',
    label: 'find asset references',
    description:
      'Find which scenes/prefabs/assets reference a script or asset (by GUID). The static half uses the offline GUID index (works without Unity); when the bridge is connected it also lists the live GameObject instances using the script.',
    parameters: refsSchema,
    async execute(_id, params) {
      const { scriptPath, guid: guidIn } = params as Static<typeof refsSchema>;
      const guid = guidIn ?? (scriptPath ? await readScriptGuidFromMeta(scriptPath) : null);
      if (!guid) return txt('Could not resolve a GUID (pass guid, or a scriptPath whose .meta exists).');

      const out: string[] = [];
      const hits = await useUnityIndexStore.getState().findReferences(guid);
      if (hits.length === 0) out.push(`No assets reference ${guid} (per the offline index).`);
      else {
        out.push(`Referenced in ${hits.length} asset(s):`);
        for (const h of hits.slice(0, 50)) out.push(`  ${h.path} (${h.count}×)`);
      }

      if (bridgeConnected()) {
        try {
          const live = await bridgeRpc.findReferencesToScript(guid);
          if (live.gameObjects.length > 0) {
            out.push(`\nLive GameObjects using this script (${live.gameObjects.length}):`);
            for (const g of live.gameObjects.slice(0, 50)) out.push(`  ${g.scene}: ${g.path}`);
          }
        } catch {
          out.push('\n(live scene instances unavailable — bridge error)');
        }
      } else {
        out.push('\n(live scene instances unavailable — Unity not connected)');
      }
      return txt(cap(out.join('\n')));
    },
  };
}

/** Bridge/index-backed Unity read tools (auto-approved tier). */
export function createUnityBridgeReadTools(): AgentTool[] {
  return [
    createGetConsoleErrors(),
    createGetEditorState(),
    createGetSceneHierarchy(),
    createGetGameObject(),
    createFindAssetReferences(),
  ];
}
