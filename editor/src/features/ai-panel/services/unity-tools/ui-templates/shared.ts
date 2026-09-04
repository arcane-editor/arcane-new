/**
 * Shared plumbing for `unity_ui_scaffold`'s five screen templates
 * (`hud.ts`/`main-menu.ts`/`settings.ts`/`dialog.ts`/`inventory.ts`) and its
 * `theme.ts` companion: name helpers (PascalCase screen name -> kebab-case
 * element prefix, element name -> a C# field name) and the small coherent
 * palette (background, surface, text, muted text, accent, danger; the 4/8/
 * 12/16/24/32 spacing scale; one radius; the 12/14/16/20/24/32 type scale —
 * the exact scales `prompts/ui-design-facts.ts`'s `DESIGN_RULES` state) that
 * every template references through `var(--…)`.
 *
 * **Why a var() reference is the same string either way.** `resolvePalette`
 * gives every semantic role a single CANONICAL custom-property name (e.g.
 * `--color-accent`). When the project already declares that exact name, or a
 * common alias of it (`--accent`, `--primary`, …), templates reference THAT
 * name — the project's own token — and nothing new is declared for it. When
 * nothing matches, templates reference the canonical name and it is added to
 * `declarations`, which `theme.ts` turns into the `:root { … }` block for a
 * freshly emitted theme sheet. Either way every screen template's own CSS
 * text is identical — only which declarations `theme.ts` needs to emit
 * changes — which is what keeps `hud.ts` et al. simple pure string builders
 * with no theme-reuse branching of their own; `ui-scaffold-tool.ts` is the
 * only place that branches on `reuseTheme`.
 *
 * Pure module: no imports, directly testable under Bun (the same shape as
 * `meta-guid.ts` next door).
 */

// ── Names ────────────────────────────────────────────────────────────────────

/**
 * PascalCase (or anything else) -> the kebab-case prefix every element name in
 * that screen's markup starts with. `"MainMenu"` -> `"main-menu"`, `"HUD"` ->
 * `"hud"` (matching `fixtures/uitoolkit/HUD.uxml`'s own `hud-*` naming),
 * `"Dialog"` -> `"dialog"`.
 */
export function kebabPrefix(name: string): string {
  const withHyphens = name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-');
  const cleaned = withHyphens
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return cleaned || 'screen';
}

/** `elementName("hud", "hp-value")` -> `"hud-hp-value"`. */
export function elementName(prefix: string, suffix: string): string {
  return `${prefix}-${suffix}`;
}

/**
 * Words that already read as "this is a `csType`" when they end an element's
 * kebab suffix — so `fieldNameFor` does not ALSO append the C# type name.
 * Keyed to avoid the two failure modes a bare "does the name already end
 * with the type's own name" check hits: `"quality-dropdown"` + `DropdownField`
 * doesn't end with `dropdownfield` (-> would wrongly become
 * `qualityDropdownDropdownField`), and `"hp-bar"` + `ProgressBar` doesn't end
 * with `progressbar` either (-> `hpBarProgressBar`) even though both already
 * read fine on their own. Unlisted types fall back to the type's own
 * lowercase name, which still correctly de-dupes the common case
 * (`"play-button"` + `Button`).
 */
const FIELD_SUFFIX_ALIASES: Record<string, readonly string[]> = {
  Label: ['label', 'text', 'value', 'title', 'name'],
  Button: ['button'],
  ProgressBar: ['bar', 'progress'],
  Slider: ['slider'],
  SliderInt: ['slider'],
  Toggle: ['toggle'],
  DropdownField: ['dropdown'],
  TextField: ['field', 'text'],
  ScrollView: ['scroll', 'list'],
};

/**
 * The C# field name a controller skeleton declares for one element:
 * `fieldNameFor("hud-hp-value", "hud", "Label")` -> `"hpValue"` (the last
 * kebab segment, `"value"`, already reads as a `Label`, so nothing is
 * appended); `fieldNameFor("settings-quality-dropdown", "settings",
 * "DropdownField")` -> `"qualityDropdown"`. The prefix is stripped first (it
 * says which screen, not what the field holds); a `VisualElement` — almost
 * always a plain container — never gets the type appended at all.
 */
export function fieldNameFor(name: string, prefix: string, csType: string): string {
  const rest = name.startsWith(`${prefix}-`) ? name.slice(prefix.length + 1) : name;
  const segments = rest.split('-').filter(Boolean);
  const camel = segments
    .map((part, i) => (i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('');
  if (csType === 'VisualElement') return camel;
  const lastSegment = (segments[segments.length - 1] ?? '').toLowerCase();
  const aliases = FIELD_SUFFIX_ALIASES[csType] ?? [csType.toLowerCase()];
  return aliases.includes(lastSegment) ? camel : `${camel}${csType}`;
}

// ── Palette ──────────────────────────────────────────────────────────────────

export interface ProjectVariable {
  /** Custom property name, including the leading `--` — `UiDesignVariableFacts.name`'s shape. */
  name: string;
}

export interface PaletteRefs {
  bg: string;
  surface: string;
  text: string;
  textMuted: string;
  accent: string;
  danger: string;
  space4: string;
  space8: string;
  space12: string;
  space16: string;
  space24: string;
  space32: string;
  radius: string;
  fontSize12: string;
  fontSize14: string;
  fontSize16: string;
  fontSize20: string;
  fontSize24: string;
  fontSize32: string;
}

export interface ThemeDeclaration {
  name: string;
  value: string;
}

export interface ResolvedPalette {
  /** Every template's `var(--…)` reference for each semantic role — always a canonical name. */
  refs: PaletteRefs;
  /** Canonical name/value pairs not covered by a project variable — what a freshly emitted theme.uss must declare. */
  declarations: ThemeDeclaration[];
}

type ColorKey = 'bg' | 'surface' | 'text' | 'textMuted' | 'accent' | 'danger';

/** Canonical name, default value, and common aliases a project might already use for the same role. */
const COLOR_ROLES: Record<ColorKey, { canonical: string; value: string; aliases: string[] }> = {
  bg: {
    canonical: '--color-bg',
    value: 'rgb(18, 18, 22)',
    aliases: ['--bg', '--background', '--color-background'],
  },
  surface: {
    canonical: '--color-surface',
    value: 'rgb(32, 32, 38)',
    aliases: ['--surface', '--panel', '--color-panel'],
  },
  text: {
    canonical: '--color-text',
    value: 'rgb(235, 235, 240)',
    aliases: ['--text', '--fg', '--foreground', '--color-foreground'],
  },
  textMuted: {
    canonical: '--color-text-muted',
    value: 'rgb(160, 160, 170)',
    aliases: ['--text-muted', '--muted', '--color-muted', '--text-secondary'],
  },
  accent: {
    canonical: '--color-accent',
    value: 'rgb(90, 170, 255)',
    aliases: ['--accent', '--primary', '--color-primary'],
  },
  danger: {
    canonical: '--color-danger',
    value: 'rgb(230, 90, 90)',
    aliases: ['--danger', '--error', '--color-error'],
  },
};

/** Spacing scale, radius and type scale: canonical name only — no alias guessing (see this module's header). */
const SCALE_ROLES: ReadonlyArray<{ key: keyof PaletteRefs; canonical: string; value: string }> = [
  { key: 'space4', canonical: '--space-4', value: '4px' },
  { key: 'space8', canonical: '--space-8', value: '8px' },
  { key: 'space12', canonical: '--space-12', value: '12px' },
  { key: 'space16', canonical: '--space-16', value: '16px' },
  { key: 'space24', canonical: '--space-24', value: '24px' },
  { key: 'space32', canonical: '--space-32', value: '32px' },
  { key: 'radius', canonical: '--radius', value: '8px' },
  { key: 'fontSize12', canonical: '--font-size-12', value: '12px' },
  { key: 'fontSize14', canonical: '--font-size-14', value: '14px' },
  { key: 'fontSize16', canonical: '--font-size-16', value: '16px' },
  { key: 'fontSize20', canonical: '--font-size-20', value: '20px' },
  { key: 'fontSize24', canonical: '--font-size-24', value: '24px' },
  { key: 'fontSize32', canonical: '--font-size-32', value: '32px' },
];

/**
 * Resolve every semantic role to a `var(--…)` reference, against the
 * project's real USS custom properties (`UiDesignFacts.variables`, or `[]`
 * for a project with none / not yet known).
 */
export function resolvePalette(variables: readonly ProjectVariable[]): ResolvedPalette {
  const known = new Set(variables.map((v) => v.name));
  const declarations: ThemeDeclaration[] = [];
  const refs = {} as PaletteRefs;

  for (const key of Object.keys(COLOR_ROLES) as ColorKey[]) {
    const role = COLOR_ROLES[key];
    const matched = [role.canonical, ...role.aliases].find((n) => known.has(n));
    refs[key] = `var(${matched ?? role.canonical})`;
    if (!matched) declarations.push({ name: role.canonical, value: role.value });
  }

  for (const role of SCALE_ROLES) {
    refs[role.key] = `var(${role.canonical})`;
    if (!known.has(role.canonical)) declarations.push({ name: role.canonical, value: role.value });
  }

  return { refs, declarations };
}

// ── Template context ─────────────────────────────────────────────────────────

export interface TemplateContext {
  /** PascalCase, as given to the tool — e.g. `"MainMenu"`. */
  name: string;
  /** `kebabPrefix(name)` — every element name in this screen starts with this. */
  prefix: string;
  /** The PanelSettings reference resolution to author pixel sizes against. */
  resolution: { width: number; height: number };
  /** `resolution.width / 1920` — structural (non-token) pixel sizes below scale by this. */
  scale: number;
  palette: PaletteRefs;
}

export function buildContext(
  name: string,
  resolution: { width: number; height: number },
  palette: PaletteRefs,
): TemplateContext {
  return { name, prefix: kebabPrefix(name), resolution, scale: resolution.width / 1920, palette };
}

/**
 * A structural (non-token) pixel size, scaled from a 1920-wide baseline to
 * this screen's actual reference resolution — e.g. a 640px settings panel
 * becomes ~427px at a 1280-wide reference resolution. The fixed design
 * tokens (`palette.space*`/`radius`/`fontSize*`) never scale — the spacing
 * and type scales are constants, not proportions (`DESIGN_RULES`).
 */
export function px(base: number, ctx: TemplateContext): string {
  return `${Math.max(1, Math.round(base * ctx.scale))}px`;
}

// ── Controller skeleton ──────────────────────────────────────────────────────

export interface ControllerField {
  /** The UI Toolkit C# type: `Label`, `Button`, `ProgressBar`, `Slider`, `Toggle`, `DropdownField`, `VisualElement`, … */
  csType: string;
  elementName: string;
}

export function controllerFields(
  ctx: TemplateContext,
  entries: ReadonlyArray<{ csType: string; suffix: string }>,
): ControllerField[] {
  return entries.map((e) => ({ csType: e.csType, elementName: elementName(ctx.prefix, e.suffix) }));
}

/**
 * A minimal `MonoBehaviour` skeleton: a `UIDocument` field, one field per
 * `fields` entry, and an `OnEnable` that binds each with `Q<T>("name")` — the
 * shape `unity_ui_toolkit`'s own docs tell the agent to use. Shared by every
 * screen template except `inventory.ts`, whose slot grid binds through a loop
 * instead of one field per slot (see that file's header).
 */
export function buildControllerSkeleton(
  ctx: TemplateContext,
  fields: readonly ControllerField[],
  /** Extra statements appended inside `OnEnable`, after every `Q<T>()` bind — `dialog.ts`'s focus-trap call. */
  extraOnEnableLines: readonly string[] = [],
): string {
  const fieldLines = fields.map(
    (f) => `    private ${f.csType} ${fieldNameFor(f.elementName, ctx.prefix, f.csType)};`,
  );
  const bindLines = fields.map(
    (f) =>
      `        ${fieldNameFor(f.elementName, ctx.prefix, f.csType)} = root.Q<${f.csType}>("${f.elementName}");`,
  );
  return [
    'using UnityEngine;',
    'using UnityEngine.UIElements;',
    '',
    `public class ${ctx.name}Controller : MonoBehaviour`,
    '{',
    '    [SerializeField] private UIDocument document;',
    '',
    ...fieldLines,
    '',
    '    private void OnEnable()',
    '    {',
    '        VisualElement root = document.rootVisualElement;',
    ...bindLines,
    ...extraOnEnableLines.map((l) => `        ${l}`),
    '    }',
    '}',
    '',
  ].join('\n');
}

// ── Result shape every screen template returns ──────────────────────────────

export interface ScreenTemplate {
  /** `<Name>.uss` content — the screen's own component styles. */
  uss: string;
  /**
   * `<Name>.uxml` content. Always carries two `<Style src="{{THEME_SRC}}" />`
   * / `<Style src="{{USS_SRC}}" />` placeholders — the template never
   * resolves either (see this module's header). `ui-scaffold-tool.ts`
   * resolves `{{THEME_SRC}}` itself ONLY when reusing an existing theme (a
   * real, already-on-disk path, known up front — no write, nothing to wait
   * on); `{{USS_SRC}}` is always left in place for the model to fill in from
   * the component `.uss` write's own result, the same as `{{THEME_SRC}}`
   * when a new theme is being written.
   */
  uxml: string;
  /** Every kebab-case element name the markup declares, in the order the controller should read them. */
  elementNames: string[];
  /** The `MonoBehaviour` skeleton's full text. */
  controllerSkeleton: string;
}
