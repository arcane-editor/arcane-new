/**
 * Which input system a Unity project actually runs — the single gate every
 * Input Hub surface hangs off.
 *
 * This is deliberately the ONE place that knows how to answer the question.
 * The logic used to live inline in `ai-panel/services/prompts/unity-facts.ts`,
 * where it produced wordy labels (`"New (Input System) available"`) that a
 * second function then re-parsed by substring to recover the tri-state. Both
 * consumers wanted the tri-state; only the prompt wanted prose. So the
 * tri-state is the return value and prose is a separate formatter.
 *
 * Lives in `utils/` rather than in `features/unity-input/` on purpose. Three
 * places across two boundaries need it — `stores/project-context.ts`, the
 * agent's project-facts block, and the Input Hub itself — and a shared folder
 * is importable by anyone (editor/CLAUDE.md). Routing the store through the
 * feature barrel instead would drag that barrel's React components into every
 * store test, where Bun's DOM-less runtime crashes on `stores/theme.ts`'s
 * module-scope `document` access; `stores/edit-review.ts` documents the same
 * trap.
 *
 * PURE and Bun-safe: `detectInputSystem` takes text, not paths, and only
 * `readInputSystem` touches Tauri.
 */

import { invoke } from '@tauri-apps/api/core';

/**
 * How the project is configured to deliver input.
 *
 * Structurally identical to `ContrastInputSystem` in
 * `ai-panel/services/prompts/unity-contrast.ts`, which is a pure module the
 * eval harness imports directly — the two assign to each other freely, and
 * duplicating the union here is what keeps this feature from deep-importing
 * across a feature boundary (`scripts/check-deep-modules.mjs`).
 */
export type InputSystemMode = 'Legacy' | 'New' | 'Both';

/**
 * `ProjectSettings/ProjectSettings.asset` is YAML, so the field is indented
 * and sits alone on its line. Anchoring to the line start is what stops a
 * commented-out or prose mention from being read as configuration.
 */
const ACTIVE_INPUT_HANDLER_RE = /^\s*activeInputHandler:\s*(\d+)\s*$/m;

/** Unity's encoding of the setting. Anything else is treated as unreadable. */
const HANDLER_MODES: Record<string, InputSystemMode> = {
  '0': 'Legacy',
  '1': 'New',
  '2': 'Both',
};

/**
 * Resolve the mode from the two things that can answer it.
 *
 * `activeInputHandler` wins whenever it is readable, because it is what Unity
 * actually consults at runtime: the package can sit in `manifest.json` while
 * the project still delivers input through the legacy Input Manager. The
 * package is only a fallback for when `ProjectSettings.asset` is missing or
 * does not carry the field (older projects, or a partial checkout).
 */
export function detectInputSystem(
  projectSettings: string | null,
  hasInputSystemPackage: boolean,
): InputSystemMode {
  if (projectSettings) {
    const match = ACTIVE_INPUT_HANDLER_RE.exec(projectSettings);
    const mode = match ? HANDLER_MODES[match[1]] : undefined;
    if (mode) return mode;
  }
  return hasInputSystemPackage ? 'New' : 'Legacy';
}

/**
 * True when the New Input System can actually receive input, and therefore
 * when the Input Hub is worth showing at all.
 *
 * Takes `null` so callers can pass an undetected/not-yet-primed workspace
 * straight through: an unknown project shows nothing rather than flickering
 * the icon in before detection lands.
 */
export function isNewInputSystemActive(mode: InputSystemMode | null): boolean {
  return mode === 'New' || mode === 'Both';
}

/** Prose for the agent's project-facts block, where the extra words earn their keep. */
export function inputSystemLabel(mode: InputSystemMode): string {
  switch (mode) {
    case 'New':
      return 'New (Input System package)';
    case 'Both':
      return 'Both (legacy Input Manager + Input System)';
    case 'Legacy':
      return 'Legacy (Input Manager)';
  }
}

/**
 * Read the project from disk and resolve its mode.
 *
 * Best-effort by contract: an unreadable manifest or ProjectSettings degrades
 * to the other signal rather than throwing, because every caller treats this
 * as "should I show the Input Hub?" and a failed read must answer "no", not
 * blow up workspace detection.
 */
export async function readInputSystem(workspacePath: string): Promise<InputSystemMode> {
  const [projectSettings, hasPackage] = await Promise.all([
    invoke<string>('read_file', {
      path: `${workspacePath}/ProjectSettings/ProjectSettings.asset`,
    }).catch(() => null),
    invoke<string>('read_file', { path: `${workspacePath}/Packages/manifest.json` })
      .then((raw) => {
        const deps = JSON.parse(raw).dependencies as Record<string, string> | undefined;
        return Boolean(deps?.['com.unity.inputsystem']);
      })
      .catch(() => false),
  ]);
  return detectInputSystem(projectSettings, hasPackage);
}
