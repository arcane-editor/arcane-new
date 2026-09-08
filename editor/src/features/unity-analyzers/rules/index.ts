/**
 * Every analyzer rule, as data.
 *
 * Deliberately separate from `services/register-rules.ts`: that module imports
 * the engine, the engine imports three Zustand stores, and one of those
 * reaches `@tauri-apps/api`. So importing the rule list through the engine
 * pulls in Tauri, which cannot load under `bun test` — which is why thirteen
 * of these rules had no coverage at all while the engine around them had
 * plenty. This module imports nothing but the rules themselves.
 */

import type { AnalyzerRule } from '../services/analyzer-engine';

import { nearMissMessagesRule } from './near-miss-messages';
import { nonSerializableTypesRule } from './non-serializable-types';
import { getComponentInUpdateRule } from './getcomponent-in-update';
import { cameraMainRule } from './camera-main';
import { allocInUpdateRule } from './alloc-in-update';
import { emptyMessagesRule } from './empty-messages';
import { waitForSecondsInLoopRule } from './waitforseconds-in-loop';
import { nullPropagationUnityObjectRule } from './null-propagation-unity-object';
import { destroyThisRule } from './destroy-this';
import { editorApiInRuntimeRule } from './editor-api-in-runtime';
import { projectSettingsLiteralsRule } from './project-settings-literals';
import { inputActionsRule } from './input-actions';
import { inputCallbackLeakRule } from './input-callback-leak';
import { inputLegacyApiRule } from './input-legacy-api';
import { uitoolkitQueryRule } from './uitoolkit-query';
import { unityEventListenersRule } from './unity-event-listeners';

/**
 * Registration order, which is also the order findings are produced in
 * (cosmetic only — the Problems panel sorts).
 */
export const ALL_RULES: readonly AnalyzerRule[] = [
  nearMissMessagesRule,
  nonSerializableTypesRule,

  // Hot-path performance. This family is the one `Microsoft.Unity.Analyzers`
  // does not cover at all: it reports what is semantically wrong for Unity,
  // not what is ruinous to do sixty times a second.
  getComponentInUpdateRule,
  cameraMainRule,
  allocInUpdateRule,
  emptyMessagesRule,
  waitForSecondsInLoopRule,

  nullPropagationUnityObjectRule,
  destroyThisRule,
  editorApiInRuntimeRule,

  projectSettingsLiteralsRule,

  inputActionsRule,
  inputCallbackLeakRule,
  inputLegacyApiRule,

  // Validated against the project's .uxml/.uss rather than against C# alone.
  uitoolkitQueryRule,
  unityEventListenersRule,
];

/**
 * Codes that a rule used to emit and no rule emits now.
 *
 * Never reuse one. A user may hold a `#pragma warning disable UNITY0208` from
 * a version where that code meant something else, and silently repurposing it
 * would suppress an unrelated inspection.
 *
 *   UNITY0203/0204  string-apis — `Invoke("x")` matched any delegate, and the
 *                   Animator fix rewrote `material.SetFloat("_Cutoff", v)`
 *                   into `Animator.StringToHash`, which compiles and is wrong.
 *                   UNT0016 and UNT0041 cover the real cases.
 *   UNITY0208       foreach allocation — List, arrays and Dictionary all
 *                   return struct enumerators, so it fired on correct code.
 * Two more rules were deleted without retiring a code, because the codes they
 * used were never theirs alone:
 *
 *   deltatime-in-fixedupdate  claimed UNITY0303. `Time.deltaTime` read inside
 *                   FixedUpdate RETURNS the fixed timestep — that is
 *                   documented Unity behaviour — so half this rule reported a
 *                   defect in correct code. UNT0004 covers the real half
 *                   (fixedDeltaTime read from Update).
 *   transform-position-per-axis  claimed UNITY0304. It ran over every method
 *                   of every class and flagged ordinary code. UNT0022 and
 *                   UNT0032 cover the real case.
 *
 * Both codes were ALSO in use by `project-settings-literals`, which is the
 * collision this reorganisation removed: `#pragma warning disable UNITY0303`
 * used to silence two unrelated inspections at once. They now belong to that
 * rule alone.
 */
export const RETIRED_CODES: readonly string[] = ['UNITY0203', 'UNITY0204', 'UNITY0208'];
