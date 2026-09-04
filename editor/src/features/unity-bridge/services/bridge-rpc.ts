import { invoke } from '@tauri-apps/api/core';
import type { ConsoleSnapshot, UnityLogType } from '../../../types/unity';

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

/** A project script backing a MonoBehaviour, resolved by the Unity bridge. */
export interface ComponentScript {
  /** Project-relative, e.g. `Assets/Scripts/PlayerController.cs`. */
  path: string;
  guid: string;
}

export interface HierarchyComponent {
  type: string;
  /**
   * Present only for MonoBehaviours whose source lives under `Assets/`.
   *
   * Absent for every built-in component (Transform, Rigidbody, …) and for
   * package scripts, which are read-only. Its absence across an ENTIRE
   * hierarchy means the installed Unity package predates this field — see
   * `hierarchyHasScriptIdentity`.
   */
  script?: ComponentScript;
  [key: string]: unknown;
}

export interface ProjectScene {
  name: string;
  /** Project-relative, e.g. `Assets/Scenes/Main.unity`. */
  path: string;
  guid: string;
  /** True when Unity currently has this scene open. */
  loaded: boolean;
}

/** A bridge call the editor refused, with a reason fit to show a user. */
export interface RpcRefusal {
  ok: false;
  reason: string;
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

/**
 * The reply to a queued command. `queued` is the marker that distinguishes it
 * from a pre-queue package's synchronous reply, which only arrives once the
 * work is genuinely done.
 */
export interface QueuedAck {
  queued: true;
  /** False when an identical command was already pending — success, not an error. */
  accepted: boolean;
  /** How long Unity's main thread had been idle when the ask landed. */
  editorIdleMs: number;
}

export interface DebuggerEndpoint {
  host: string;
  port: number;
  pid: number;
}

/** A GameObject in a loaded scene, addressed by instance id or hierarchy path. */
export interface SceneTarget {
  instanceId?: number;
  path?: string;
}

export interface AttachUiDocumentParams {
  target: SceneTarget;
  uxmlPath: string;
  /** Create the GameObject (and any missing parents) when the path resolves to nothing. Default true. */
  createIfMissing?: boolean;
  panelSettingsPath?: string;
  /** Create a PanelSettings asset when the project has none. Default true. */
  createPanelSettingsIfMissing?: boolean;
  /** Where a created PanelSettings goes. Default `Assets/UI/PanelSettings.asset`. */
  panelSettingsCreatePath?: string;
  sortingOrder?: number;
}

export interface AttachUiDocumentResult {
  ok: true;
  gameObject: { path: string; instanceId: number; created: boolean };
  uiDocument: { instanceId: number; created: boolean };
  panelSettings: {
    path: string;
    guid: string;
    created: boolean;
    /** True when a default runtime theme had to be written for it. */
    themeCreated: boolean;
    /**
     * How the PanelSettings was chosen: the caller named it, it was the
     * project's only one, or there were none and it was created.
     */
    confidence: 'given' | 'only' | 'created';
  };
  visualTreeAsset: { path: string; guid: string };
  /** The scene is DIRTIED, never saved — saving stays the user's call. */
  scene: { path: string; dirty: boolean };
  undoGroup: string;
}

export type SerializedValueKind =
  | 'int'
  | 'float'
  | 'bool'
  | 'string'
  | 'enum'
  | 'color'
  | 'vector2'
  | 'vector3'
  | 'objectRef'
  | 'null';

/** How an object reference is resolved, in this order: guid, asset path, scene path. */
export interface SerializedObjectRef {
  guid?: string;
  assetPath?: string;
  scenePath?: string;
  /** With `scenePath`, the component on that GameObject to reference. */
  componentType?: string;
  /** With `guid`/`assetPath`, the sub-asset to pick out of the file. */
  subAssetName?: string;
}

export interface SerializedValue {
  kind: SerializedValueKind;
  value?: unknown;
  enumName?: string;
  ref?: SerializedObjectRef;
}

export interface SetSerializedPropertyParams {
  /** A scene object. Mutually exclusive with `assetPath`. */
  target?: SceneTarget;
  /** An asset (ScriptableObject, PanelSettings, prefab…). Mutually exclusive with `target`. */
  assetPath?: string;
  component?: string;
  componentInstanceId?: number;
  property: string;
  value: SerializedValue;
}

export interface SetSerializedPropertyResult {
  ok: true;
  target: { path: string; instanceId: number; type: string; isAsset: boolean };
  property: string;
  /** Unity's `SerializedPropertyType` name, e.g. `Float`. */
  propertyType: string;
  /**
   * The value before and after, in `getGameObject`'s property shape. Both are
   * reported because a set that was coerced or clamped is otherwise
   * indistinguishable from one that took.
   */
  previous: unknown;
  applied: unknown;
  sceneDirty: boolean;
  undoGroup: string;
}

/**
 * How long `attachUiDocument` may take. Well past the bridge's 10s default: the
 * handler may force a synchronous import of a just-written .uxml, and on a cold
 * project that import is the slow part.
 */
const ATTACH_UI_DOCUMENT_TIMEOUT_MS = 30_000;

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
  /**
   * Ask Unity to import changed assets.
   *
   * Queued on the Unity side: this resolves when the ask is ACCEPTED, which is
   * not the same as when the import ran. Unity parks its main thread while
   * unfocused, and blocking on it there does not make the work happen sooner —
   * it just fails after eight seconds. Watch for `unity-refresh-completed` if
   * you need to know the import actually executed.
   */
  refreshAssets: () => rpc<QueuedAck | { ok: boolean }>('refreshAssets'),
  /**
   * Import changed assets and, with `force`, compel a script compile even when
   * Unity's importer saw nothing worth rebuilding. Queued, exactly as
   * `refreshAssets` is.
   *
   * `force` is off by default on purpose: RequestScriptCompilation() recompiles
   * and reloads the domain unconditionally, and paying that on every agent
   * write would cost more than the problem it solves.
   */
  requestCompile: (force = false) =>
    rpc<QueuedAck | { ok: boolean }>('requestCompile', { force }),
  /** Every scene under `Assets/`, flagged with whether Unity has it open. */
  listScenes: () => rpc<{ scenes: ProjectScene[] }>('listScenes'),
  /**
   * Ask Unity to open a scene. Resolves with `{ ok: false, reason }` when the
   * editor refuses (play mode, compiling, or the user cancelled the
   * save-changes prompt) — a refusal is not an error and must not be surfaced
   * as one.
   */
  openScene: (path: string, mode: 'single' | 'additive' = 'single') =>
    rpc<{ ok: boolean; reason?: string }>('openScene', { path, mode }),
  generateSolution: () => rpc<{ ok: boolean }>('generateSolution'),
  executeMenuItem: (path: string) => rpc<{ ok: boolean }>('executeMenuItem', { path }),
  openAsset: (target: { guid?: string; path?: string }) => rpc<{ ok: boolean }>('openAsset', target),
  focusUnity: () => rpc<{ ok: boolean }>('focusUnity'),
  setExternalScriptEditor: (path: string) =>
    rpc<{ ok: boolean }>('setExternalScriptEditor', { path }),
  getDebuggerEndpoint: () => rpc<DebuggerEndpoint>('getDebuggerEndpoint'),
  /**
   * Ask Unity to run tests. Queued on the Unity side (protocol 4+): this
   * resolves once the ask is ACCEPTED, not once the run finishes — the real
   * completion is the `unity-test-run-completed` push, matched by `runId`
   * (see `unity-test-runner`'s `waitForTestRun`). An IDE-side `runId`, minted
   * by the caller (`crypto.randomUUID()`), is what makes that match possible;
   * a pre-protocol-4 package ignores the extra param and answers synchronously
   * once the run finishes, exactly as before.
   */
  runTests: (mode: 'EditMode' | 'PlayMode', filter: string | undefined, runId: string) =>
    rpc<QueuedAck | { ok: boolean }>('runTests', { mode, filter, runId }),
  /**
   * Read a page of Unity's console history. Protocol 4+ only — the caller is
   * responsible for checking `bridgeProtocol` before calling this; against an
   * older bridge the RPC rejects with "Unknown method".
   */
  getConsoleSnapshot: (opts: {
    offset?: number;
    limit?: number;
    types?: UnityLogType[];
    includeStackTrace?: boolean;
    order?: 'newest' | 'oldest';
  } = {}) => rpc<ConsoleSnapshot>('getConsoleSnapshot', opts),
  /**
   * Clear Unity's console. Protocol 4+ only. `ok:false` means Unity's own
   * console specifically could not be cleared (an unsupported Editor version)
   * — the bridge's own hook ring is cleared either way.
   */
  clearConsole: () =>
    rpc<{ ok: true; cleared: 'logEntries' | 'hookRing'; epoch: number } | { ok: false; reason: string }>(
      'clearConsole',
    ),
  /**
   * Attach a UIDocument to a GameObject, wired to a .uxml, a PanelSettings and
   * a theme. Protocol 4+ (the write RPCs). Resolves with `{ ok:false, reason }`
   * when Unity refuses — busy editor, an ambiguous PanelSettings, a .uxml that
   * would not import — which is an answer, not an error.
   *
   * Blocking on the Unity side: it resolves once the scene really changed.
   */
  attachUiDocument: (p: AttachUiDocumentParams) =>
    rpc<AttachUiDocumentResult | RpcRefusal>(
      'attachUiDocument',
      p as unknown as Record<string, unknown>,
      ATTACH_UI_DOCUMENT_TIMEOUT_MS,
    ),
  /**
   * Set one serialized property on a scene object or an asset, inside its own
   * Unity undo group. Protocol 4+. Refusals (`{ ok:false, reason }`) name the
   * real property/component names, so a miss is one retry away.
   */
  setSerializedProperty: (p: SetSerializedPropertyParams) =>
    rpc<SetSerializedPropertyResult | RpcRefusal>(
      'setSerializedProperty',
      p as unknown as Record<string, unknown>,
    ),
};
