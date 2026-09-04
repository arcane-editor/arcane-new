/**
 * Which UI stack a Unity project actually uses.
 *
 * `unity_ui_write` needs this to refuse writing UI Toolkit documents into a
 * project that has committed to uGUI and never asked for UI Toolkit — the
 * refusal `ui-write-tool.ts` renders for the `ugui` case. Detection is a pure
 * function of three project-wide counts; gathering them (a file scan) is
 * `unity-facts.ts`'s job (`primeUnityFacts`, cached once per workspace on
 * `UnityFacts.uiStack`), same split as every other pure/IO pairing in this
 * feature (`asset-checks.ts`/`asset-gate.ts`).
 *
 * Pure module: no imports, directly testable under Bun.
 */

export type UiStack = 'uitoolkit' | 'ugui' | 'both' | 'none';

export interface UiStackSignals {
  /** How many `.uxml` documents the project has (`unity-analyzers`' `UxmlIndex.docCount`). */
  uxmlCount: number;
  /** How many `.asset` files serialize a `PanelSettings` — UI Toolkit's render target, even with 0 `.uxml`. */
  panelSettingsCount: number;
  /** How many `.unity`/`.prefab` files (≤ 2 MB) contain a Canvas component (`--- !u!223`, uGUI's class id). */
  canvasScenes: number;
}

/**
 * `uitoolkit` needs either a `.uxml` document or a `PanelSettings` asset —
 * either one alone means the project has started down that path, e.g. a
 * PanelSettings created ahead of any document. `ugui` needs an actual Canvas
 * in a scene or prefab; the `UnityEngine.UI` package being installed is not
 * enough on its own (plenty of projects keep it as a dependency of something
 * else and never place a Canvas).
 */
export function detectUiStack({ uxmlCount, panelSettingsCount, canvasScenes }: UiStackSignals): UiStack {
  const hasUiToolkit = uxmlCount > 0 || panelSettingsCount > 0;
  const hasUgui = canvasScenes > 0;
  if (hasUiToolkit && hasUgui) return 'both';
  if (hasUiToolkit) return 'uitoolkit';
  if (hasUgui) return 'ugui';
  return 'none';
}
