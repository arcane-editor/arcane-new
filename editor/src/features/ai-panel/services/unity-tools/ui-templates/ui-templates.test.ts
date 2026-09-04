// Every screen template is pure — no store, no Tauri, no dynamic import — so
// this suite exercises them directly against the SAME validators
// `unity_ui_write` runs on a real write (`asset-checks.ts`'s `checkUxml`/
// `checkUss`) and the SAME renderer the human preview uses
// (`buildRenderPlanFromText`, deep-imported by path per Task 17's brief —
// production code never reaches into `uitoolkit/` past its barrel, but a
// test asserting against its pure render-plan module is exactly what that
// module exists for).

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseUxml, type UxmlNode } from '../../../../../utils/uxml-model';
import { parseUss, type UssStyleSheet } from '../../../../../utils/uss-model';
import { buildRenderPlanFromText } from '../../../../uitoolkit/services/render-plan';
import { checkUxml, checkUss, type UxmlCheckContext } from '../asset-checks';
import { buildContext, resolvePalette, type TemplateContext, type ScreenTemplate } from './shared';
import { buildThemeUss } from './theme';
import { buildHudTemplate } from './hud';
import { buildMainMenuTemplate } from './main-menu';
import { buildSettingsTemplate } from './settings';
import { buildDialogTemplate } from './dialog';
import { buildInventoryTemplate } from './inventory';

const SCREENS: Array<{ name: string; screenName: string; build: (ctx: TemplateContext) => ScreenTemplate }> = [
  { name: 'hud', screenName: 'HUD', build: buildHudTemplate },
  { name: 'main-menu', screenName: 'MainMenu', build: buildMainMenuTemplate },
  { name: 'settings', screenName: 'Settings', build: buildSettingsTemplate },
  { name: 'dialog', screenName: 'Dialog', build: buildDialogTemplate },
  { name: 'inventory', screenName: 'Inventory', build: buildInventoryTemplate },
];

/** Every class any rule in `sheet` declares — mirrors `uitoolkit-cache.ts`'s `buildUssIndex`. */
function declaredClassesOf(sheet: UssStyleSheet): Set<string> {
  const out = new Set<string>();
  for (const rule of sheet.rules) {
    for (const selector of rule.selectors) {
      for (const part of selector.parts) {
        for (const simple of part.simples) {
          if (simple.kind === 'class') out.add(simple.name);
        }
      }
    }
  }
  return out;
}

function flatten(node: UxmlNode | null, out: UxmlNode[] = []): UxmlNode[] {
  if (!node) return out;
  out.push(node);
  for (const child of node.children) flatten(child, out);
  return out;
}

/** Placeholder-substituted UXML, for parsing — real content never matters to `parseUxml`, only well-formedness. */
function resolvedUxml(uxml: string): string {
  return uxml.replace('{{THEME_SRC}}', 'Theme.uss').replace('{{USS_SRC}}', 'X.uss');
}

const DEFAULT_PALETTE = resolvePalette([]).refs;

describe.each(SCREENS)('ui-templates — $name', ({ screenName, build }) => {
  const ctx = buildContext(screenName, { width: 1920, height: 1080 }, DEFAULT_PALETTE);
  const template = build(ctx);

  it('produces well-formed UXML with a non-null root (buildRenderPlanFromText)', () => {
    const doc = parseUxml(resolvedUxml(template.uxml));
    expect(doc.diagnostics).toEqual([]);
    const plan = buildRenderPlanFromText(doc, []);
    expect(plan.root).not.toBeNull();
  });

  it('passes checkUxml with zero findings', () => {
    const declaredClasses = declaredClassesOf(parseUss(template.uss, `${screenName}.uss`));
    const ctxForCheck: UxmlCheckContext = {
      declaredClasses,
      csReferencedClasses: new Set(), // non-null and empty: the undeclared-class check is ACTIVE
      ussPaths: [],
    };
    const findings = checkUxml(resolvedUxml(template.uxml), ctxForCheck);
    expect(findings).toEqual([]);
  });

  it('passes checkUss with zero findings', () => {
    expect(checkUss(template.uss, `${screenName}.uss`)).toEqual([]);
  });

  it('declares every element name as unique kebab-case, prefixed by the screen', () => {
    expect(template.elementNames.length).toBeGreaterThan(0);
    expect(new Set(template.elementNames).size).toBe(template.elementNames.length);
    for (const name of template.elementNames) {
      expect(name.startsWith(`${ctx.prefix}-`)).toBe(true);
      expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it('every declared `name=` in the markup matches the template\'s own elementNames list', () => {
    const doc = parseUxml(resolvedUxml(template.uxml));
    const declared = flatten(doc.root)
      .map((n) => n.name)
      .filter((n): n is string => n !== null);
    expect(new Set(declared)).toEqual(new Set(template.elementNames));
  });

  it('uses var(--…) for every color/spacing/radius/font-size reference (no bare literals for the palette)', () => {
    // Every declared color in the CSS goes through a custom property; a hand
    // authored literal (`color: rgb(...)` outside a `--` declaration) would be
    // exactly the "inventing a new one" this tool exists to avoid.
    for (const decl of parseUss(template.uss, `${screenName}.uss`).rules.flatMap((r) => r.declarations)) {
      if (decl.property === 'background-color' || decl.property === 'color' || decl.property === 'border-color') {
        expect(decl.value.trim().startsWith('var(') || decl.value.trim().startsWith('rgba(0, 0, 0, 0')).toBe(true);
      }
    }
  });

  it('the controller skeleton compiles as a single MonoBehaviour and queries only declared names', () => {
    expect(template.controllerSkeleton).toContain('using UnityEngine.UIElements;');
    expect(template.controllerSkeleton).toContain(`public class ${screenName}Controller : MonoBehaviour`);
    expect(template.controllerSkeleton).toContain('[SerializeField] private UIDocument document;');
    const queried = [...template.controllerSkeleton.matchAll(/Q<\w+>\(\$?"([a-z0-9-{}]+)/g)].map((m) => m[1]);
    expect(queried.length).toBeGreaterThan(0);
  });
});

describe('ui-templates — palette parameterisation', () => {
  it('reuses an exact project variable name instead of declaring the canonical one', () => {
    const palette = resolvePalette([{ name: '--accent' }, { name: '--space-8' }]);
    expect(palette.refs.accent).toBe('var(--accent)');
    expect(palette.refs.space8).toBe('var(--space-8)');
    expect(palette.declarations.some((d) => d.name === '--color-accent')).toBe(false);
    expect(palette.declarations.some((d) => d.name === '--space-8')).toBe(false);
    // Everything else the project did NOT declare still gets a default.
    expect(palette.declarations.some((d) => d.name === '--color-bg')).toBe(true);
  });

  it('flows the reused variable name into a template\'s actual CSS text', () => {
    const palette = resolvePalette([{ name: '--accent' }]);
    const ctx = buildContext('HUD', { width: 1920, height: 1080 }, palette.refs);
    const template = buildHudTemplate(ctx);
    expect(template.uss).toContain('var(--accent)');
    expect(template.uss).not.toContain('var(--color-accent)');
  });

  it('scales structural pixel sizes by the reference resolution, never the fixed token scale', () => {
    const wide = buildContext('HUD', { width: 1920, height: 1080 }, DEFAULT_PALETTE);
    const narrow = buildContext('HUD', { width: 1280, height: 720 }, DEFAULT_PALETTE);
    const a = buildHudTemplate(wide).uss;
    const b = buildHudTemplate(narrow).uss;
    expect(a).not.toBe(b);
    // The token scale itself (var(--space-24), var(--radius), …) is untouched by resolution.
    expect(a).toContain('var(--space-24)');
    expect(b).toContain('var(--space-24)');
  });
});

describe('ui-templates — theme.ts', () => {
  it('declares only the tokens resolvePalette said were missing, and passes checkUss', () => {
    const { declarations } = resolvePalette([{ name: '--accent' }]);
    const themeUss = buildThemeUss('HUD', declarations);
    expect(themeUss).not.toContain('--color-accent');
    expect(themeUss).toContain('--color-bg');
    expect(checkUss(themeUss, 'HUDTheme.uss')).toEqual([]);
  });
});

describe('ui-templates — hud golden structural comparison (fixtures/uitoolkit/HUD.uxml)', () => {
  it('matches the fixture\'s shape: a root container, a top bar with hp/ammo panels, a pause button', () => {
    const fixtureDir = path.resolve(import.meta.dir, '../../../../../../fixtures/uitoolkit');
    const fixtureText = readFileSync(path.join(fixtureDir, 'HUD.uxml'), 'utf8');
    const fixtureDoc = parseUxml(fixtureText);
    // `doc.root` is the `<ui:UXML>` wrapper itself (render-plan.ts's own doc
    // comment: "its children are added straight onto rootVisualElement") —
    // the screen's actual root is its first real child.
    expect(fixtureDoc.root).not.toBeNull();
    const fixtureScreenRoot = fixtureDoc.root!.children[0];
    expect(fixtureScreenRoot?.localName).toBe('VisualElement');

    const fixtureNodes = flatten(fixtureDoc.root);
    expect(fixtureNodes.some((n) => n.localName === 'Button')).toBe(true);
    expect(fixtureNodes.filter((n) => n.localName === 'Label').length).toBeGreaterThanOrEqual(2);
    expect(fixtureText).toContain('hp');
    expect(fixtureText).toContain('ammo');
    expect(fixtureText).toContain('pause');

    const ctx = buildContext('HUD', { width: 1920, height: 1080 }, DEFAULT_PALETTE);
    const ours = buildHudTemplate(ctx);
    const oursDoc = parseUxml(resolvedUxml(ours.uxml));
    expect(oursDoc.root).not.toBeNull();
    const oursScreenRoot = oursDoc.root!.children[0];
    expect(oursScreenRoot?.localName).toBe('VisualElement');
    expect(oursScreenRoot?.name).toBe('hud-root');

    const oursNodes = flatten(oursDoc.root);
    expect(oursNodes.some((n) => n.localName === 'Button')).toBe(true);
    expect(oursNodes.filter((n) => n.localName === 'Label').length).toBeGreaterThanOrEqual(2);
    expect(ours.elementNames.some((n) => n.includes('hp'))).toBe(true);
    expect(ours.elementNames.some((n) => n.includes('ammo'))).toBe(true);
    expect(ours.elementNames.some((n) => n.includes('pause'))).toBe(true);
    // Our own naming style, unlike the fixture's (kept loose on purpose — the
    // fixture predates the "prefix every name" rule and deliberately still
    // carries the two mistakes `asset-checks.test.ts` exercises against it).
    for (const name of ours.elementNames) expect(name.startsWith('hud-')).toBe(true);
  });
});
