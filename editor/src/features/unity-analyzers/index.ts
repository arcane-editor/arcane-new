// Public API for the Unity static-analysis suite (T4.1–T4.4).
//
// Activation is Unity-gated and internally inert for non-Unity projects: the
// engine's publish path self-gates on `unity.analyzers.enabled` +
// `isUnityProject`, each rule additionally honours its own setting sub-gate, and
// the FormerlySerializedAs rename hook checks the same gates before augmenting an
// edit. Calling `initUnityAnalyzers` in a non-Unity project is a no-op in effect
// (it wires watchers that produce nothing until a Unity project is active).
//
// Wiring: the app controller calls `initUnityAnalyzers(monaco)` once Monaco is
// available (this feature deliberately does NOT touch App.tsx itself).

import type { Monaco } from '@monaco-editor/react';
import {
  startEngine,
  stopEngine,
  refreshAll,
  runAnalyzersOnText as runAnalyzersOnTextRaw,
  type Finding,
} from './services/analyzer-engine';
import { registerAllRules } from './services/register-rules';
import { registerFsaRename, unregisterFsaRename } from './services/fsa-rename';
import { loadProjectSettings } from './services/project-settings-cache';
import { useWorkspaceStore } from '../../stores/workspace';

let initialized = false;
let stopEngineFn: (() => void) | null = null;
let unsubWorkspace: (() => void) | null = null;

/**
 * Initialise the Unity analyzers: register all rules, start the debounced
 * model-change engine + quick-fix source, and register the FormerlySerializedAs
 * rename post-processor. Idempotent.
 */
export function initUnityAnalyzers(monaco: Monaco): void {
  if (initialized) return;
  initialized = true;
  registerAllRules();
  stopEngineFn = startEngine(monaco);
  registerFsaRename();

  // The ProjectSettings snapshot backs the tag/layer/scene/input checks. It is
  // loaded per workspace and re-run afterwards, because the rules read it
  // synchronously and would otherwise stay silent for the first analysis pass
  // of every session.
  const syncSettings = (path: string | null) => {
    void loadProjectSettings(path).then(() => refreshAll(monaco));
  };
  syncSettings(useWorkspaceStore.getState().workspacePath);
  unsubWorkspace = useWorkspaceStore.subscribe((state, prev) => {
    if (state.workspacePath !== prev.workspacePath) syncSettings(state.workspacePath);
  });
}

/** Tear down all analyzer wiring (engine, code actions, rename hook). */
export function stopUnityAnalyzers(): void {
  if (stopEngineFn) {
    stopEngineFn();
    stopEngineFn = null;
  } else {
    stopEngine();
  }
  unregisterFsaRename();
  unsubWorkspace?.();
  unsubWorkspace = null;
  initialized = false;
}

/**
 * Re-run analysis for all open C# models. Call after a Unity-analyzer setting
 * changes or the project's Unity-ness flips so diagnostics update immediately.
 */
export function refreshUnityAnalyzers(monaco: Monaco): void {
  refreshAll(monaco);
}

/**
 * Reused by the AI analyzer-gate (T5.4): run the exact same rule set against
 * arbitrary text without touching Monaco or the stores. Ensures rules are
 * registered first, so callers that never invoked `initUnityAnalyzers` (e.g. a
 * headless AI pass) still get the full rule set. Returns findings only.
 */
export function runAnalyzersOnText(
  text: string,
  filePath: string,
  opts?: Parameters<typeof runAnalyzersOnTextRaw>[2],
): Finding[] {
  registerAllRules();
  return runAnalyzersOnTextRaw(text, filePath, opts);
}

export type { Finding, Severity } from './services/analyzer-engine';
