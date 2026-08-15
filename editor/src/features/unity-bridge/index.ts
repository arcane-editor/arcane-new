// Unity Editor Bridge — frontend client for the C# bridge package.
// RPC wrappers, install flow, and the install banner. The bridge connection
// state itself lives in the shared `unity` store (src/stores/unity.ts).

export { bridgeRpc } from './services/bridge-rpc';
export type {
  EditorState,
  HierarchyNode,
  HierarchyComponent,
  ComponentScript,
  ProjectScene,
  SceneHierarchy,
  SelectionObject,
  ProjectAsset,
  DebuggerEndpoint,
} from './services/bridge-rpc';
export { isBridgeInstalled, installBridge, BRIDGE_DOCS_URL } from './services/bridge-installer';
export { maybeRefreshUnityAfterSave } from './services/refresh-on-save';
export { triggerRecompileAndWait } from './services/compile-wait';
export type { CompileWaitOutcome } from './services/compile-wait';
export { BridgeInstallBanner } from './components/BridgeInstallBanner';
export { UnityBridgeStatusItem } from './components/UnityBridgeStatusItem';
