/**
 * The UI Toolkit design-facts half of the Unity facts block (Task 16, B9).
 *
 * `unity_ui_write`/`unity_ui_layout`/`unity_ui_scaffold` give the model tools
 * to write and inspect `.uxml`/`.uss`, but nothing so far tells it what a
 * GOOD one looks like for THIS project: the theme's real `--custom-property`
 * variables (so it reuses `--color-bg` instead of inventing a fifth grey),
 * the PanelSettings coordinate space every `px` value in a `.uxml` is
 * measured against (`utils/panel-settings.ts`'s header explains why guessing
 * this is a 38%-off bug, not a rounding error), and a fixed set of layout
 * rules USS actually enforces (flex only, no grid/float/box-shadow — those
 * parse and are silently dropped, not rejected).
 *
 * Pure and store-free, so it is directly testable under Bun — the same split,
 * and the same reason, as `input-facts.ts`/`subsystem-facts.ts` next door.
 * `unity-facts.ts` gathers the real data (analyzers' `UssIndex`, a
 * size-gated `PanelSettings` scan) and hands it in as plain data.
 */

import type { PanelScaleMode, ScreenMatchMode } from '../../../../utils/panel-settings';
import type { UiStack } from '../unity-tools/ui-stack';

export interface UiDesignVariableFacts {
  /** Custom property name, including the leading `--`. */
  name: string;
  /** Raw declared value, as authored (the render function trims it). */
  value: string;
  /** Basename of the first `.uss` (in project order) that declares it. */
  sheet: string;
}

export interface UiDesignPanelFacts {
  name: string;
  /** Workspace-relative path of the `PanelSettings` asset. */
  path: string;
  scaleMode: PanelScaleMode;
  /** Null when the asset carries no usable reference resolution. */
  referenceResolution: { w: number; h: number } | null;
  screenMatchMode: ScreenMatchMode;
  /** Meaningful only for `scale-with-screen` + `match-width-or-height`. */
  match: number;
}

export interface UiDesignFacts {
  variables: UiDesignVariableFacts[];
  panels: UiDesignPanelFacts[];
  /** Every `.uss` (basename) that declares at least one variable, deduped. */
  themeSheets: string[];
  stack: UiStack;
}

/** One `.uss` document's declarations, flattened across all its rules — the shape `collectUssVariables` needs. */
export interface UssSheetDeclarations {
  /** Project path (or any path — only used for sort order and the basename). */
  path: string;
  declarations: Array<{ property: string; value: string }>;
}

/**
 * Custom-property (`--foo`) declarations across a project's `.uss` sheets,
 * deduped to one variable per name.
 *
 * Pulled out of `unity-facts.ts` (fix round 1, F2) so this is directly
 * testable under Bun: `unity-facts.ts` statically imports `stores/
 * workspace.ts`, which is not. Sheets are sorted by path HERE — not trusted
 * to arrive pre-sorted — so "the first sheet that declares it" is
 * deterministic regardless of the order the caller's scan happened to return
 * them in (e.g. `read_files_bulk` chunk order, which is not guaranteed).
 */
export function collectUssVariables(
  sheets: readonly UssSheetDeclarations[],
): { variables: UiDesignVariableFacts[]; themeSheets: string[] } {
  const sorted = [...sheets].sort((a, b) => a.path.localeCompare(b.path));
  const seen = new Set<string>();
  const variables: UiDesignVariableFacts[] = [];

  for (const sheet of sorted) {
    const base = sheet.path.split('/').pop() ?? sheet.path;
    for (const decl of sheet.declarations) {
      if (!decl.property.startsWith('--') || seen.has(decl.property)) continue;
      seen.add(decl.property);
      variables.push({ name: decl.property, value: decl.value, sheet: base });
    }
  }

  const themeSheets = uniqSorted(variables.map((v) => v.sheet));
  return { variables, themeSheets };
}

/** Character budget for the variable/panel listing (frozen per conversation, re-sent every turn). */
const DEFAULT_BUDGET = 900;

/** Longer than this and a value stops being "a token" and starts being prompt bloat. */
const VALUE_MAX_CHARS = 24;

const SCALE_MODE_LABEL: Record<PanelScaleMode, string> = {
  'constant-pixel': 'ConstantPixelSize',
  'scale-with-screen': 'ScaleWithScreenSize',
  'constant-physical': 'ConstantPhysicalSize',
};

/**
 * Fixed, always-sent-in-full design rules for every `.uxml`/`.uss` the model
 * writes. Small and constant, so it is reserved out of the budget FIRST
 * (`uiDesignFactLines`) rather than competing with the per-project variable
 * and panel listings for space — those are what should shrink on a huge
 * project, not this.
 */
const DESIGN_RULES: readonly string[] = [
  '- Spacing scale: 4/8/12/16/24/32px only.',
  '- Type scale: 12/14/16/20/24/32px at the reference resolution.',
  '- Text contrast ≥ 4.5:1.',
  '- Flex only — no grid/float/box-shadow (USS drops them silently, no error).',
  '- Screen root: `flex-grow:1` + `justify-content`.',
  '- HUD safe area ≥ 24px from every edge.',
  '- Overlays: `position:absolute` only.',
  '- State via `:hover`/`:active`/`:focus`/`:disabled` + modifier classes (`.btn--primary`).',
  '- Hover: set `transition-property`/`transition-duration`.',
  '- Use `-unity-text-align`, `-unity-font-definition` (not CSS text-align/font-family).',
  '- Every interactive element, and every element C# reads, gets a `name`.',
  '- Pick one `border-radius` value, reuse it everywhere.',
];

const NO_VARIABLES_LINE =
  '- USS variables: none declared — define a small set (colors, spacing, radius) in a theme .uss and reference them with var(), not new literals.';

const NO_PANEL_LINE =
  '- Panel: none found — lay out at 1920×1080 and create PanelSettings when wiring (unity_attach_ui_document does it).';

function totalLength(lines: readonly string[]): number {
  return lines.reduce((n, l) => n + l.length + 1, 0);
}

function uniqSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function truncateValue(value: string): string {
  return value.length > VALUE_MAX_CHARS ? value.slice(0, VALUE_MAX_CHARS) : value;
}

/**
 * The `- USS variables (...): ...` line, budgeted like `subsystem-facts.ts`'s
 * `budgeted()`: names (here, `--name value` tokens) are added in sorted order
 * until the budget runs out, then the rest are counted rather than dropped
 * silently.
 */
function variablesLine(
  variables: readonly UiDesignVariableFacts[],
  themeSheets: readonly string[],
  budget: number,
): string {
  if (variables.length === 0) return NO_VARIABLES_LINE;

  const sorted = [...variables].sort((a, b) => a.name.localeCompare(b.name));
  const sheets = uniqSorted(themeSheets);
  const prefix = `- USS variables (${sorted.length}, from ${sheets.join(', ')}): `;
  const suffix = ' — reference these with var(), not new literals.';
  const bodyBudget = Math.max(0, budget - prefix.length - suffix.length);

  const shown: string[] = [];
  let used = 0;
  for (const v of sorted) {
    const token = `${v.name} ${truncateValue(v.value)}`;
    const cost = token.length + (shown.length > 0 ? 2 : 0);
    if (used + cost > bodyBudget) break;
    used += cost;
    shown.push(token);
  }
  const more = sorted.length - shown.length;
  const tail = more > 0 ? ` (+${more} more)` : '';
  return `${prefix}${shown.join(', ')}${tail}${suffix}`;
}

/** `match width`/`match height`/`match <value>`, or null when no match mode applies. */
function matchLabel(panel: UiDesignPanelFacts): string | null {
  if (panel.scaleMode !== 'scale-with-screen') return null;
  if (panel.screenMatchMode !== 'match-width-or-height') return null;
  if (panel.match === 0) return 'match width';
  if (panel.match === 1) return 'match height';
  return `match ${panel.match}`;
}

function panelLine(panel: UiDesignPanelFacts): string {
  const scale = SCALE_MODE_LABEL[panel.scaleMode];
  if (!panel.referenceResolution) {
    return `- Panel: ${panel.name} — ${scale}. Lay out in those pixels.`;
  }
  const { w, h } = panel.referenceResolution;
  const match = matchLabel(panel);
  const parenthetical = match ? ` (${match})` : '';
  return `- Panel: ${panel.name} — ${scale}, reference ${w}×${h}${parenthetical}. Lay out in those pixels.`;
}

/** One line per `PanelSettings`, sorted by path, budgeted the same way `variablesLine` is. */
function panelsLines(panels: readonly UiDesignPanelFacts[], budget: number): string[] {
  if (panels.length === 0) return [NO_PANEL_LINE];

  const sorted = [...panels].sort((a, b) => a.path.localeCompare(b.path));
  const shown: string[] = [];
  let used = 0;
  for (const p of sorted) {
    const line = panelLine(p);
    const cost = line.length + 1;
    // Always show at least the first panel even over budget: a silently
    // empty panels section is a worse failure mode than one line that runs
    // long (constraint #2 — no degraded state should read as "nothing here").
    if (shown.length > 0 && used + cost > budget) break;
    used += cost;
    shown.push(line);
  }
  const more = sorted.length - shown.length;
  if (more > 0) {
    shown.push(`- Panel: (+${more} more not shown — call unity_ui_toolkit for the rest).`);
  }
  return shown;
}

/**
 * UI Toolkit design-facts lines: the project's real USS custom-property
 * variables, the coordinate space its `PanelSettings` render through, a
 * mixed-stack caution when the project also has uGUI, and the fixed design
 * rules every `.uxml`/`.uss` should follow.
 *
 * `budget` bounds the variable/panel listing only — the design rules are
 * reserved out of it first (see `DESIGN_RULES`'s doc comment) so they are
 * never the thing that gets cut on a large project.
 */
export function uiDesignFactLines(facts: UiDesignFacts, budget = DEFAULT_BUDGET): string[] {
  const stackNote =
    facts.stack === 'both'
      ? [
          '- This project also uses uGUI (Canvas) elsewhere — do not migrate an existing uGUI screen to UI ' +
            'Toolkit unless asked; call unity_ui_toolkit to check which stack a given screen already uses.',
        ]
      : [];

  const reserved = totalLength(DESIGN_RULES) + totalLength(stackNote);
  const remaining = Math.max(0, budget - reserved);

  const varLine = variablesLine(facts.variables, facts.themeSheets, remaining);
  const afterVars = Math.max(0, remaining - varLine.length - 1);
  const panelLinesOut = panelsLines(facts.panels, afterVars);

  return [varLine, ...panelLinesOut, ...stackNote, ...DESIGN_RULES];
}
