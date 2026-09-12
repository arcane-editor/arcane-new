// ── What the Inspector panel should show ────────────────────────────────────
//
// Pure decision logic, extracted from the component so it can be tested without
// React or Tauri — the convention every other decision in this codebase follows.

import type { SoBaseKind } from '../../unity-analyzers';

export interface ScriptPathGate {
  /** Absolute path of the open script. */
  abs: string;
  /** Workspace-relative path. */
  rel: string;
}

export interface GateInput {
  isUnityProject: boolean;
  workspacePath: string | null;
  activeFilePath: string | null;
  /**
   * Does this workspace-relative path name a RUNTIME script (under `Assets/`,
   * not under `Assets/Editor/`)?
   *
   * Injected rather than imported so this module stays free of feature
   * barrels — importing one pulls React and the theme store, which touch
   * `document` at load and cannot be exercised by the test runner. The caller
   * passes `classifyFile`; the classification rule stays owned by `csharp`.
   */
  isRuntimeScript: (rel: string) => boolean;
}

/**
 * Is the active file a runtime C# script we can inspect?
 *
 * Mirrors the gate the asset-usage panel has always applied, so the two views
 * agree on when the Inspector has anything to say at all. `classifyFile` is
 * purely path-based — `MonoBehaviour` there means "under Assets/, not under
 * Assets/Editor/", which is true of ScriptableObject scripts too.
 */
export function scriptPathGate({
  isUnityProject,
  workspacePath,
  activeFilePath,
  isRuntimeScript,
}: GateInput): ScriptPathGate | null {
  if (!isUnityProject || !workspacePath || !activeFilePath) return null;
  if (!activeFilePath.toLowerCase().endsWith('.cs')) return null;
  // Virtual tabs are not files on disk.
  if (activeFilePath.startsWith('diff://') || activeFilePath.startsWith('auth://')) return null;
  const prefix = workspacePath.endsWith('/') ? workspacePath : workspacePath + '/';
  if (!activeFilePath.startsWith(prefix)) return null;
  const rel = activeFilePath.slice(prefix.length);
  if (!isRuntimeScript(rel)) return null;
  return { rel, abs: activeFilePath };
}

/** Which view the Inspector renders for a script we have a schema for. */
export type InspectorView = 'tabs' | 'sceneUsage';

/**
 * Choose between the ScriptableObject tabs and the classic usage list.
 *
 * The base check in the schema is syntactic and only sees the immediate base
 * list, so `WeaponDef : BaseDef` (where `BaseDef : ScriptableObject` lives in
 * another file) reports `unknown`. Rather than build a cross-file type
 * resolver, we let the project answer: if `.asset` instances of this script
 * exist, it IS a ScriptableObject — an asset whose `m_Script` points here could
 * not exist otherwise.
 */
export function inspectorView(
  baseKind: SoBaseKind,
  instanceCount: number,
): InspectorView {
  if (baseKind === 'scriptableObject') return 'tabs';
  if (baseKind === 'monoBehaviour') return 'sceneUsage';
  return instanceCount > 0 ? 'tabs' : 'sceneUsage';
}
