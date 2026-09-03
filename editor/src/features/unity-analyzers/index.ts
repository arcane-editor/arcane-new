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
import { loadInputActions } from './services/inputactions-cache';
import { loadUiToolkitIndex, onUiToolkitIndexChanged } from './services/uitoolkit-cache';
import {
  setListenerWorkspace,
  dropAllListenerSnapshots,
  onListenersChanged,
} from './services/unity-events-cache';
import { useUnityIndexStore } from '../../stores/unity-index';
import { blankStringsAndComments } from './services/csharp-scan';
export { blankStringsAndComments } from './services/csharp-scan';
import {
  registerUiToolkitCsProviders,
  disposeUiToolkitCsProviders,
} from './services/uitoolkit-providers';
import { useWorkspaceStore } from '../../stores/workspace';

let initialized = false;
let stopEngineFn: (() => void) | null = null;
let unsubWorkspace: (() => void) | null = null;
let unsubUiToolkit: (() => void) | null = null;
let unsubListeners: (() => void) | null = null;
let unsubIndex: (() => void) | null = null;

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
  // Completion, hover and go-to-definition for the `Q<T>("name")` boundary.
  // Registered next to csharp-ls, not instead of it: Monaco merges completions,
  // stacks hovers, and csharp-ls has no definition for a string literal.
  registerUiToolkitCsProviders(monaco, () => useWorkspaceStore.getState().workspacePath);

  // The ProjectSettings snapshot backs the tag/layer/scene/input checks. It is
  // loaded per workspace and re-run afterwards, because the rules read it
  // synchronously and would otherwise stay silent for the first analysis pass
  // of every session.
  // `.inputactions` rides the same hook for the same reason: the input rules
  // read their snapshot synchronously too. Both are awaited together so the
  // re-analysis pass runs once rather than twice.
  const syncSettings = (path: string | null) => {
    setListenerWorkspace(path);
    void Promise.all([
      loadProjectSettings(path),
      loadInputActions(path),
      // Resolves after the .uxml/.uss pass; the project-wide C# walk that
      // backs the query check's fourth rung continues detached and reports
      // through onUiToolkitIndexChanged below.
      loadUiToolkitIndex(path, blankStringsAndComments),
    ]).then(() => refreshAll(monaco));
  };
  syncSettings(useWorkspaceStore.getState().workspacePath);
  unsubWorkspace = useWorkspaceStore.subscribe((state, prev) => {
    if (state.workspacePath !== prev.workspacePath) syncSettings(state.workspacePath);
  });
  // The UI Toolkit snapshot lands in two phases, and the second one flips the
  // query check from silent to live. Without this the rule would stay quiet
  // until the next keystroke in every open file.
  unsubUiToolkit = onUiToolkitIndexChanged(() => refreshAll(monaco));
  unsubListeners = onListenersChanged(() => refreshAll(monaco));
  // BOTH triggers, not one. A delta leaves `status` untouched while changing
  // what the prefabs wire — the bug `usage-codelens.ts` documents at its own
  // subscription, for exactly this store.
  unsubIndex = useUnityIndexStore.subscribe((state, prev) => {
    if (state.status !== prev.status || state.indexRevision !== prev.indexRevision) {
      dropAllListenerSnapshots();
      refreshAll(monaco);
    }
    // Its own counter, not `indexRevision`: reloading the input snapshot costs
    // a project scan, and it is only stale when the assets themselves changed.
    // Without this the rules keep validating literals against the actions the
    // asset had at workspace open, so renaming an action in Unity makes
    // UNITY0401 report a live action as missing until the project is reopened.
    if (state.inputActionsRevision !== prev.inputActionsRevision) {
      void loadInputActions(useWorkspaceStore.getState().workspacePath).then(() =>
        refreshAll(monaco),
      );
    }
    // Same treatment, same reason: without this, editing a `.uxml` or `.uss` in
    // Unity leaves the query check — and the AI's `unity_ui_toolkit` — reading
    // the documents as they were when the workspace was opened. `loadUiToolkitIndex`
    // resolves after its cheap first phase and fires `onUiToolkitIndexChanged`
    // when the project-wide C# walk lands, so the subscription above re-runs
    // the rules a second time on its own.
    if (state.uiToolkitRevision !== prev.uiToolkitRevision) {
      void loadUiToolkitIndex(
        useWorkspaceStore.getState().workspacePath,
        blankStringsAndComments,
      ).then(() => refreshAll(monaco));
    }
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
  disposeUiToolkitCsProviders();
  unsubWorkspace?.();
  unsubWorkspace = null;
  unsubUiToolkit?.();
  unsubUiToolkit = null;
  unsubListeners?.();
  unsubListeners = null;
  unsubIndex?.();
  unsubIndex = null;
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

// ── C# scanning + ScriptableObject schema ────────────────────────────────────
//
// Exported for the ScriptableObject inspector, which needs to turn an open .cs
// class into a typed form. Kept here rather than in a leaf feature because
// every consumer sits ABOVE this module in the import graph, and moving the
// scanner would mean refactoring 17 rule files that depend on it.
export {
  scanCSharp,
  offsetInSpan,
  offsetToLineCol,
  lineColToOffset,
  classContaining,
} from './services/csharp-scan';
export type {
  CSharpScan,
  ClassDecl,
  FieldDecl,
  EnumDecl,
  EnumMember,
  AttributeUse,
  AttributeArg,
  SourceSpan,
} from './services/csharp-scan';

export { isSerializedField, isSerializedFieldDecl } from './services/serialized-fields';

export {
  buildSoSchema,
  classBaseKind,
  elementTypeOf,
  fieldGroups,
  widgetForType,
} from './services/so-schema';
export type {
  SoSchema,
  SoField,
  SoFieldGroup,
  SoWidgetKind,
  SoBaseKind,
} from './services/so-schema';

// ── Input System snapshot ────────────────────────────────────────────────────
//
// Exported for the AI harness's `unity_input_actions` tool, which needs the
// same parsed view of the project's `.inputactions` assets the rules validate
// against. Sharing the cache rather than re-scanning means the agent and the
// Problems panel can never disagree about which actions exist.
export {
  getInputActionsIndex,
  loadInputActions,
  buildInputActionsIndex,
} from './services/inputactions-cache';
export type {
  InputActionsIndex,
  KnownAction,
} from './services/inputactions-cache';

// ── UI Toolkit snapshot ──────────────────────────────────────────────────────
//
// Exported for the AI harness's `unity_ui_toolkit` tool and its write gate, for
// the same reason the Input System block above is exported: the agent must read
// the SAME parsed view of `.uxml`/`.uss` that UNITY0501 validates `Q<T>("name")`
// against. A private scan here would let the agent and the Problems panel
// disagree about which element names exist, which is the one thing that makes a
// grounded tool worse than no tool.
export {
  getUxmlIndex,
  getUssIndex,
  getCsUiRefIndex,
  loadUiToolkitIndex,
  onUiToolkitIndexChanged,
  buildUxmlIndex,
  buildUssIndex,
  buildCsUiRefIndex,
} from './services/uitoolkit-cache';
export type {
  UxmlIndex,
  UssIndex,
  CsUiRefIndex,
  ElementDecl,
} from './services/uitoolkit-cache';
