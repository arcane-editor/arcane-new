/**
 * The input half of the Unity facts block.
 *
 * Pure and separate for two reasons. It is the piece worth asserting — the
 * prompt line the model actually reads was, until now, asserted nowhere — and
 * `unity-facts.ts` cannot be imported under Bun at all: its store imports
 * reach `stores/theme.ts`, which touches `document` at module scope. Same
 * split, and the same reason, as `unity-contrast.ts`.
 */

import type { InputSystemMode } from '../../../../utils/input-system';

/** The action names the project actually declares, for the facts block. */
export interface InputActionsFacts {
  assetPaths: string[];
  maps: Array<{ name: string; actions: string[] }>;
}


/** Character budget for action names in the facts block (frozen per session). */
const INPUT_ACTION_NAME_BUDGET = 700;

/**
 * Input lines for the facts block: the project's real action names, then the
 * API crib for the mode it actually runs.
 *
 * The crib used to live in `unity-context.ts`'s static "Common API crib",
 * where it taught legacy `Input.GetAxis` to EVERY project — stated in the base
 * prompt, which renders BEFORE this block, so a New-Input-System project was
 * told the wrong default first and only softly corrected afterwards. Detection
 * already lives here, so the crib does too.
 */
export function inputFactLines(
  inputSystem: InputSystemMode,
  ia: InputActionsFacts | null,
): string[] {
  const lines: string[] = [];

  if (ia) {
    lines.push(`- Input actions (${ia.assetPaths.join(', ')}):`);
    // Budgeted: this block is frozen per conversation, so it is re-sent on
    // every turn. Names first — they are what stops a guessed literal.
    let used = 0;
    for (const map of ia.maps) {
      const shown: string[] = [];
      for (const name of map.actions) {
        if (used + name.length > INPUT_ACTION_NAME_BUDGET) break;
        used += name.length + 2;
        shown.push(name);
      }
      const more = map.actions.length - shown.length;
      const tail = more > 0 ? `, …${more} more` : '';
      lines.push(`    ${map.name} (${map.actions.length}): ${shown.join(', ')}${tail}`);
    }
    lines.push(
      '  Use these exact names — a wrong action name compiles and then silently never fires. Call unity_input_actions for bindings, control types and C# call sites.',
    );
  }

  switch (inputSystem) {
    case 'New':
      lines.push(
        '- Input API: `InputAction` / `PlayerInput` (`using UnityEngine.InputSystem;`). Enable in `OnEnable`, disable in `OnDisable`, and unsubscribe every `performed`/`started`/`canceled` handler you add. `ReadValue<T>()` must match the action\'s control type. Direct polling is `Keyboard.current.spaceKey.wasPressedThisFrame`, never `Input.GetKey`.',
      );
      break;
    case 'Both':
      lines.push(
        '- Input API: both handlers are enabled, so `Input.GetAxis` and `InputAction` both work. Prefer the Input System for new code, and follow whichever the file you are editing already uses.',
      );
      break;
    case 'Legacy':
      lines.push(
        '- Input API: legacy Input Manager — `Input.GetAxis("Horizontal")`, `Input.GetKey(KeyCode.Space)`, `Input.GetMouseButtonDown(0)`. `UnityEngine.InputSystem` is NOT available in this project.',
      );
      break;
  }
  return lines;
}

