/**
 * Legacy `Input` calls in a project configured for the New Input System only.
 *
 * When `activeInputHandler` is 1, Unity compiles the legacy `UnityEngine.Input`
 * class but throws `InvalidOperationException` the moment it is touched:
 *
 *   "You are trying to read Input using the UnityEngine.Input class, but you
 *    have switched active Input handling to Input System package in Player
 *    Settings."
 *
 * So this is not a style preference -- it is a guaranteed runtime crash that
 * the compiler cannot see, and it is the single most common way an AI-generated
 * or tutorial-copied script breaks a modern Unity project.
 *
 * Deliberately silent when the project is set to `Both`, where the legacy class
 * genuinely still works, and when the mode is unknown.
 *
 * No quick fix on purpose: converting a call means creating an action, binding
 * it, and wiring a callback across two files. A one-click "fix" that guessed at
 * that would produce code that compiles and still does not work, which is worse
 * than the honest diagnostic.
 */

import type { AnalyzerRule, Finding } from '../services/analyzer-engine';
import { getInputActionsIndex } from '../services/inputactions-cache';

const RULE_ID = 'unity/input-legacy-api';

/**
 * Members of `UnityEngine.Input` that throw under the new handler. Matched on
 * the blanked view so a mention inside a comment or string never counts.
 */
const LEGACY_INPUT_RE =
  /\bInput\s*\.\s*(GetAxisRaw|GetAxis|GetButtonDown|GetButtonUp|GetButton|GetKeyDown|GetKeyUp|GetKey|GetMouseButtonDown|GetMouseButtonUp|GetMouseButton|mousePosition|mouseScrollDelta|touchCount|touches|anyKey|anyKeyDown|acceleration)\b/g;

/** The nearest Input System equivalent, so the message can point somewhere. */
const REPLACEMENTS: Record<string, string> = {
  GetAxis: 'an action of type Value, read with ReadValue<float>() or ReadValue<Vector2>()',
  GetAxisRaw: 'an action of type Value, read with ReadValue<float>() or ReadValue<Vector2>()',
  GetButton: 'a Button action, read with IsPressed()',
  GetButtonDown: 'a Button action, read with WasPressedThisFrame()',
  GetButtonUp: 'a Button action, read with WasReleasedThisFrame()',
  GetKey: 'Keyboard.current[Key.X].isPressed, or a bound Button action',
  GetKeyDown: 'Keyboard.current[Key.X].wasPressedThisFrame, or a bound Button action',
  GetKeyUp: 'Keyboard.current[Key.X].wasReleasedThisFrame, or a bound Button action',
  GetMouseButton: 'Mouse.current.leftButton.isPressed',
  GetMouseButtonDown: 'Mouse.current.leftButton.wasPressedThisFrame',
  GetMouseButtonUp: 'Mouse.current.leftButton.wasReleasedThisFrame',
  mousePosition: 'Mouse.current.position.ReadValue()',
  mouseScrollDelta: 'Mouse.current.scroll.ReadValue()',
  touchCount: 'Touchscreen.current.touches.Count',
  touches: 'Touchscreen.current.touches',
  anyKey: 'Keyboard.current.anyKey.isPressed',
  anyKeyDown: 'Keyboard.current.anyKey.wasPressedThisFrame',
  acceleration: 'Accelerometer.current.acceleration.ReadValue()',
};

export const inputLegacyApiRule: AnalyzerRule = {
  id: RULE_ID,
  defaultSeverity: 'error',
  settingKey: 'unity.inputDiagnostics.enabled',

  run(scan): Finding[] {
    const index = getInputActionsIndex();
    // Only `New` is a crash. `Both` supports the legacy class, and an unknown
    // mode (cold start, unreadable ProjectSettings) must stay quiet rather
    // than accuse every Input call in the project.
    if (index?.inputSystem !== 'New') return [];

    const findings: Finding[] = [];
    LEGACY_INPUT_RE.lastIndex = 0;
    for (let m = LEGACY_INPUT_RE.exec(scan.code); m !== null; m = LEGACY_INPUT_RE.exec(scan.code)) {
      const member = m[1];
      findings.push({
        ruleId: RULE_ID,
        code: 'UNITY0405',
        severity: 'error',
        message:
          `Input.${member} throws at runtime: this project has Active Input Handling set to ` +
          `"Input System Package", which disables the legacy UnityEngine.Input class entirely. ` +
          `Use ${REPLACEMENTS[member] ?? 'the Input System equivalent'}.`,
        start: m.index,
        end: m.index + m[0].length,
      });
    }
    return findings;
  },
};
