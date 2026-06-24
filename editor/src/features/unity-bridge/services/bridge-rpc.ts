import { invoke } from '@tauri-apps/api/core';

/**
 * Typed wrappers over the `unity_ipc_request` Tauri command, which sends an
 * id-correlated `rpc_request` to the connected Unity bridge and resolves with
 * the `result` payload (or rejects on bridge error / timeout / disconnect).
 *
 * Every call degrades gracefully: callers should treat a rejection as "bridge
 * unavailable" and fall back, rather than surfacing a hard error.
 */

async function rpc<T = unknown>(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs?: number,
): Promise<T> {
  return invoke<T>('unity_ipc_request', { method, params, timeoutMs });
}

/** True when an RPC can even be attempted (a Unity client is connected). */
export interface EditorState {
  isPlaying: boolean;
  isPaused: boolean;
  isCompiling: boolean;
  unityVersion: string;
  activeScenes: string[];
}

export interface HierarchyComponent {
  type: string;
  [key: string]: unknown;
}

export interface HierarchyNode {
  name: string;
  active: boolean;
  tag: string;
  layer: number;
  instanceId: number;
  components: HierarchyComponent[];
  children: HierarchyNode[];
}

export interface SceneHierarchy {
  scenes: Array<{ name: string; path: string; roots: HierarchyNode[] }>;
  truncated: boolean;
}

export interface SelectionObject {
  name: string;
  instanceId: number;
  type: string;
  path: string;
}

export interface ProjectAsset {
  name: string;
  path: string;
  guid: string;
  type: string;
}

export interface DebuggerEndpoint {
  host: string;
  port: number;
  pid: number;
}

export const bridgeRpc = {
  getEditorState: () => rpc<EditorState>('getEditorState'),
  getSceneHierarchy: () => rpc<SceneHierarchy>('getSceneHierarchy'),
  getGameObject: (target: { instanceId?: number; path?: string }) =>
    rpc<HierarchyNode & { components: HierarchyComponent[] }>('getGameObject', target),
  getSelection: () => rpc<{ objects: SelectionObject[] }>('getSelection'),
  findReferencesToScript: (guid: string) =>
    rpc<{ gameObjects: Array<{ scene: string; path: string; instanceId: number }> }>(
      'findReferencesToScript',
      { guid },
    ),
  getProjectAssets: (query: string, type?: string) =>
    rpc<{ assets: ProjectAsset[] }>('getProjectAssets', { query, type }),
  refreshAssets: () => rpc<{ ok: boolean }>('refreshAssets'),
  generateSolution: () => rpc<{ ok: boolean }>('generateSolution'),
  executeMenuItem: (path: string) => rpc<{ ok: boolean }>('executeMenuItem', { path }),
  openAsset: (target: { guid?: string; path?: string }) => rpc<{ ok: boolean }>('openAsset', target),
  focusUnity: () => rpc<{ ok: boolean }>('focusUnity'),
  setExternalScriptEditor: (path: string) =>
    rpc<{ ok: boolean }>('setExternalScriptEditor', { path }),
  getDebuggerEndpoint: () => rpc<DebuggerEndpoint>('getDebuggerEndpoint'),
  /** Run Unity tests via the bridge (TestRunnerApi). Results stream as `unity-test-event`. */
  runTests: (mode: 'EditMode' | 'PlayMode', filter?: string) =>
    rpc<{ ok: boolean }>('runTests', { mode, filter }, 5 * 60_000),
};
