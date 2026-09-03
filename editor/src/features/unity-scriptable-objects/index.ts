// ── First-class ScriptableObject support ────────────────────────────────────
//
// Sits ABOVE `unity-analyzers` (schema) and `unity-context` (usage store) in the
// import graph, which is what lets it depend on both. Putting this in
// `unity-context` instead would create a mutual barrel import with
// `unity-analyzers` — the failure mode that broke app startup before.
//
// Nothing may import this feature except `app-shell` and `editor`.

export { default as UnityInspectorPanel } from './components/UnityInspectorPanel';
export { default as ScriptableObjectsPanel } from './components/ScriptableObjectsPanel';
export { default as ScriptableObjectEditor } from './components/ScriptableObjectEditor';

export {
  readAssetFields,
  writeAssetFields,
  describeRejection,
} from './services/asset-fields-client';
export type {
  SoAssetSnapshot,
  SoFieldValue,
  SoFieldEdit,
  SoEditResult,
  SoValueKind,
} from './services/asset-fields-client';

export { buildRows, toEdit, toMemberEdit } from './services/so-value-model';
export type { SoRow, SoRowState } from './services/so-value-model';

export { scriptPathGate, inspectorView } from './services/so-inspector-gate';
export type { ScriptPathGate, InspectorView, GateInput } from './services/so-inspector-gate';

export {
  pickColumns,
  cellValue,
  formatCell,
  instanceRows,
  MAX_INSTANCE_COLUMNS,
} from './services/so-instance-columns';

export { initSoInstanceCodeLens } from './services/so-codelens';

export { computeDrift, fixEditsFor, describeDrift, defaultRawFor } from './services/so-drift';
export type { DriftFinding, DriftKind, DriftAsset } from './services/so-drift';
