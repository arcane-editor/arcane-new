/**
 * `unity_ui_scaffold` — vetted UI Toolkit screen templates, as a recipe.
 *
 * The agent can already write validated `.uxml`/`.uss` (`unity_ui_write`,
 * Task 14), see how a document actually lays out (`unity_ui_layout`, Task
 * 15), and wire a document onto a GameObject (`unity_attach_ui_document`,
 * Task 12) — but every one of those tools needs a starting document to act
 * on, and an agent asked for "a settings screen" with no reference tends to
 * either under-build (a bare `VisualElement` with no states, no palette, no
 * safe area) or invent conventions the rest of the project does not share.
 * This tool is that starting point: five vetted, complete screens (hud,
 * main-menu, settings, dialog, inventory), parameterised by the project's
 * OWN USS variables (`prompts/ui-design-facts.ts`'s `resolvePalette` via
 * `ui-templates/shared.ts`) and `PanelSettings` reference resolution, so a
 * scaffolded screen matches the theme and coordinate space every other
 * `.uxml`/`.uss` in the project already uses instead of inventing a new one.
 *
 * **It never writes.** Read-tier (`createUnityReadTools`), auto-approved,
 * no `path`/`content` top-level params for the write decorators to key off.
 * It returns the ordered `unity_ui_write` calls to make (full file contents,
 * theme/component USS before the UXML — Global Constraint 1's "no
 * degraded path reads as success" cousin here is "no recipe pretends to be a
 * write"), the element names a controller must use, a minimal controller
 * skeleton, the project's own design rules (reused verbatim from
 * `ui-design-facts.ts`, never duplicated), and the wiring step. The agent
 * still calls `unity_ui_write` itself — which is what actually validates and
 * allocates the GUIDs `<Style src>` needs (`meta-guid.ts`) — so a template
 * bug is caught the same way a hand-written mistake would be, not smuggled
 * past validation because "the tool generated it".
 */

import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool } from '../vendor/types';
import { txt, cap } from './text-result';
import type { UiStack } from './ui-stack';
import type { UiDesignFacts } from '../prompts/ui-design-facts';
import { DESIGN_RULES } from '../prompts/ui-design-facts';
import { resolvePalette, buildContext, type ScreenTemplate, type TemplateContext } from './ui-templates/shared';
import { buildThemeUss } from './ui-templates/theme';
import { buildHudTemplate } from './ui-templates/hud';
import { buildMainMenuTemplate } from './ui-templates/main-menu';
import { buildSettingsTemplate } from './ui-templates/settings';
import { buildDialogTemplate } from './ui-templates/dialog';
import { buildInventoryTemplate } from './ui-templates/inventory';

const schema = Type.Object({
  screen: Type.Union([
    Type.Literal('hud'),
    Type.Literal('main-menu'),
    Type.Literal('settings'),
    Type.Literal('dialog'),
    Type.Literal('inventory'),
  ]),
  name: Type.String({
    description:
      'Screen name in PascalCase, e.g. "MainMenu" — used for file names and element-name prefixes.',
  }),
  directory: Type.Optional(Type.String({ description: 'Default "Assets/UI".' })),
  reuseTheme: Type.Optional(
    Type.Boolean({
      description:
        "Reference the project's existing theme .uss instead of emitting a new one (default true when one exists).",
    }),
  ),
});
type Params = Static<typeof schema>;

type Screen = Params['screen'];

const BUILDERS: Record<Screen, (ctx: TemplateContext) => ScreenTemplate> = {
  hud: buildHudTemplate,
  'main-menu': buildMainMenuTemplate,
  settings: buildSettingsTemplate,
  dialog: buildDialogTemplate,
  inventory: buildInventoryTemplate,
};

/**
 * Injectable data access — same shape as `ui-write-tool.ts`'s `stack` dep:
 * both reach `unity-facts.ts` through a dynamic `import()` because that
 * module statically imports `stores/workspace.ts` (Bun-unsafe, Global
 * Constraint 4), and both use the bounded-wait `ensure*` accessor because
 * this tool's `execute()` can afford to wait for a cold cache rather than
 * silently falling back to "no variables, no panel" on a project that
 * actually has both.
 */
export interface UiScaffoldToolDeps {
  stack: (workspacePath: string) => Promise<UiStack | null>;
  design: (workspacePath: string) => Promise<UiDesignFacts | null>;
}

export const defaultUiScaffoldDeps: UiScaffoldToolDeps = {
  async stack(workspacePath) {
    const { ensureUnityUiStack } = await import('../prompts/unity-facts');
    return ensureUnityUiStack(workspacePath);
  },
  async design(workspacePath) {
    const { getUnityUiDesign } = await import('../prompts/unity-facts');
    return getUnityUiDesign(workspacePath);
  },
};

/** Task 14's uGUI refusal copy — this tool has no `adoptUiToolkit` flag of its own, so it points at the tool that does. */
const UGUI_REFUSAL =
  'This project uses uGUI (Canvas) and has no UI Toolkit documents. Not writing UXML into it. ' +
  'Ask the user first, then pass adoptUiToolkit:true to unity_ui_write.';

const DEFAULT_RESOLUTION = { width: 1920, height: 1080 };

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Prefer a `scale-with-screen` panel's reference resolution — the one coordinate space that actually drives layout size (see `unity-facts.ts`'s own doc comment). */
function pickResolution(design: UiDesignFacts | null): {
  size: { width: number; height: number };
  note: string;
} {
  const withRes = design?.panels.find((p) => p.scaleMode === 'scale-with-screen' && p.referenceResolution);
  if (withRes?.referenceResolution) {
    const { w, h } = withRes.referenceResolution;
    return { size: { width: w, height: h }, note: `Reference resolution: ${w}×${h} (from ${withRes.name}).` };
  }
  return {
    size: DEFAULT_RESOLUTION,
    note: `Reference resolution: ${DEFAULT_RESOLUTION.width}×${DEFAULT_RESOLUTION.height} (default — no PanelSettings with a usable reference resolution was found).`,
  };
}

function fence(lang: string, content: string): string {
  return `\`\`\`${lang}\n${content}\n\`\`\``;
}

export function createUnityUiScaffoldTool(
  workspacePath: string,
  deps: UiScaffoldToolDeps = defaultUiScaffoldDeps,
): AgentTool {
  return {
    name: 'unity_ui_scaffold',
    label: 'unity ui scaffold',
    description:
      'Get a vetted, complete UI Toolkit screen template (hud, main-menu, settings, dialog, inventory), ' +
      "parameterised by this project's own USS variables and PanelSettings reference resolution. Returns a " +
      'recipe — the exact unity_ui_write calls to make, the element names, a minimal C# controller skeleton, ' +
      'the design rules, and the wiring step — it writes nothing itself. Call this BEFORE hand-writing a new ' +
      'screen from scratch; it saves inventing palette/spacing conventions the rest of the project does not share.',
    parameters: schema,
    async execute(_id, params) {
      const { screen, name, reuseTheme: reuseThemeParam } = params as Params;
      const directory = (params as Params).directory?.replace(/\/+$/, '') || 'Assets/UI';

      const stackResult = await deps.stack(workspacePath).catch(() => null);
      const stack: UiStack = stackResult ?? 'none';
      if (stack === 'ugui') return txt(UGUI_REFUSAL);

      const design = await deps.design(workspacePath).catch((): UiDesignFacts | null => null);
      const palette = resolvePalette(design?.variables ?? []);
      const { size: resolution, note: resolutionNote } = pickResolution(design);

      const themeSheets = design?.themeSheets ?? [];
      const hasExistingTheme = themeSheets.length > 0;
      const reuseExisting = (reuseThemeParam ?? true) && hasExistingTheme;

      const uxmlPath = `${directory}/${name}.uxml`;
      const ussPath = `${directory}/${name}.uss`;
      const themePath = `${directory}/${name}Theme.uss`;
      const existingThemePath = reuseExisting ? `${directory}/${themeSheets[0]}` : null;

      const ctx = buildContext(name, resolution, palette.refs);
      const template = BUILDERS[screen](ctx);

      let uxml = template.uxml;
      if (existingThemePath) uxml = uxml.replace('{{THEME_SRC}}', escapeAttr(existingThemePath));

      const writeCalls: Array<{ path: string; content: string }> = [];
      if (!reuseExisting) writeCalls.push({ path: themePath, content: buildThemeUss(name, palette.declarations) });
      writeCalls.push({ path: ussPath, content: template.uss });
      writeCalls.push({ path: uxmlPath, content: uxml });

      const lines: string[] = [];
      lines.push(`unity_ui_scaffold: ${name} (${screen}) — a vetted starting point. This tool wrote nothing; make these calls yourself.`);
      lines.push('', resolutionNote);
      lines.push(
        reuseExisting
          ? `Reusing this project's existing theme, assumed at ${existingThemePath} alongside this screen ` +
              `(from the project's theme sheets — verify the path and adjust <Style src> if it lives elsewhere). ` +
              'Already resolved in the .uxml below.'
          : `Emitting a new theme sheet (${themePath}) — ${palette.declarations.length} token(s) not already ` +
              "declared by the project's own USS variables.",
      );

      lines.push('', '1) Call unity_ui_write for each of these, IN ORDER (USS before UXML, so each write\'s result gives you the exact <Style src> string for the next one):', '');
      for (const call of writeCalls) {
        const lang = call.path.toLowerCase().endsWith('.uss') ? 'uss' : 'xml';
        lines.push(`unity_ui_write path="${call.path}":`, fence(lang, call.content), '');
      }
      const ussCallsNote = writeCalls
        .filter((c) => c.path.toLowerCase().endsWith('.uss'))
        .map((c) => `src="./${c.path.split('/').pop()}"`)
        .join(' and ');
      lines.push(
        `After the .uss write(s) land, replace ${reuseExisting ? '{{USS_SRC}}' : '{{THEME_SRC}} and {{USS_SRC}}'} ` +
          `in the .uxml above with the exact <Style src="..."> string each write's result gives you — or use the ` +
          `relative-path form directly (${ussCallsNote}), which UI Toolkit also accepts.`,
      );

      lines.push('', '2) Element names the controller must use:', `  ${template.elementNames.join(', ')}`);

      lines.push(
        '',
        `3) Minimal controller skeleton (suggested file: Assets/Scripts/UI/${name}Controller.cs — write it ` +
          'with the standard write tool; this is C#, not UI Toolkit markup):',
        fence('csharp', template.controllerSkeleton),
      );

      lines.push('', '4) Design rules — apply these to every element above:');
      for (const rule of DESIGN_RULES) lines.push(`  ${rule}`);

      lines.push(
        '',
        `5) Then: unity_attach_ui_document with document: "${uxmlPath}" to put it on a GameObject, and ` +
          'unity_ui_layout to see how it actually lays out before assuming it looks right.',
      );

      return txt(cap(lines.join('\n'), 16000));
    },
  };
}
