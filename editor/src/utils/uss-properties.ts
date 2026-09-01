// USS (Unity Style Sheets) property knowledge, in one place.
//
// **Why this is not `features/uitoolkit/data/uss.ts`.** That list exists to
// feed Monaco completions, where being incomplete costs a missing suggestion.
// This one is an ALLOWLIST behind a diagnostic, where being incomplete means
// flagging valid USS — and it was missing `text-shadow`, `background-size`,
// `background-repeat`, `all`, `-unity-text-outline` and `-unity-slice-type`,
// among others. Two lists would drift apart the first time anyone added a
// property to one; `data/uss.ts` now re-exports from here so they cannot.
//
// It lives in `utils/` rather than in the feature because the analyzer rules,
// the renderer and the completion provider all read it, and because a leaf
// module with no imports is the only kind Bun's DOM-less test runtime can load
// (see `utils/inputactions-model.ts` for the same reasoning).

/**
 * Every property Unity's USS importer understands.
 *
 * Grouped rather than sorted, matching `data/uss.ts`'s existing shape — the
 * groups are how you check a property is missing, which is the operation that
 * actually matters here.
 */
export const USS_PROPERTY_REGISTRY: readonly string[] = [
  // Layout — flexbox. USS has no float, no grid, no inline flow.
  'align-content', 'align-items', 'align-self',
  'flex', 'flex-basis', 'flex-direction', 'flex-grow', 'flex-shrink', 'flex-wrap',
  'justify-content',
  'display', 'position', 'left', 'top', 'right', 'bottom',
  'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
  'overflow',

  // Box
  'margin', 'margin-left', 'margin-top', 'margin-right', 'margin-bottom',
  'padding', 'padding-left', 'padding-top', 'padding-right', 'padding-bottom',
  'border-width',
  'border-left-width', 'border-top-width', 'border-right-width', 'border-bottom-width',
  'border-color',
  'border-left-color', 'border-top-color', 'border-right-color', 'border-bottom-color',
  'border-radius',
  'border-top-left-radius', 'border-top-right-radius',
  'border-bottom-left-radius', 'border-bottom-right-radius',

  // Background
  'background-color', 'background-image', 'background-size', 'background-repeat',
  'background-position', 'background-position-x', 'background-position-y',

  // Text
  'color', 'font-size', 'letter-spacing', 'word-spacing',
  'white-space', 'text-overflow', 'text-shadow',

  // Visual
  'opacity', 'visibility', 'cursor',

  // Transform + transition
  'transform-origin', 'translate', 'rotate', 'scale',
  'transition', 'transition-property', 'transition-duration',
  'transition-timing-function', 'transition-delay',

  // The CSS-wide keyword property
  'all',

  // ── Unity-specific ────────────────────────────────────────────────────────
  // Text
  '-unity-font', '-unity-font-definition', '-unity-font-style', '-unity-text-align',
  '-unity-text-outline', '-unity-text-outline-color', '-unity-text-outline-width',
  '-unity-paragraph-spacing', '-unity-text-overflow-position', '-unity-text-generator',
  '-unity-editor-text-rendering-mode', '-unity-text-auto-size', '-unity-word-wrap',
  '-unity-font-color', '-unity-rich-text',

  // Background + 9-slice
  '-unity-background-image-tint-color', '-unity-background-scale-mode',
  '-unity-slice-left', '-unity-slice-top', '-unity-slice-right', '-unity-slice-bottom',
  '-unity-slice-scale', '-unity-slice-type', '-unity-scaled-backgrounds',

  // Clipping / overflow
  '-unity-overflow-clip-box', '-unity-clipping',

  // Editor-styling properties Unity serialises into its own USS. They look like
  // mistakes and are not — omitting them flags Unity's own stylesheets, which
  // is exactly the false positive that would sink the feature.
  '-unity-content-offset', '-unity-extend', '-unity-image-position', '-unity-name',
  '-unity-stretch-height', '-unity-stretch-width',
];

const REGISTRY_SET: ReadonlySet<string> = new Set(USS_PROPERTY_REGISTRY);

/**
 * CSS properties that are *not* USS, mapped to what to do instead.
 *
 * Unity's importer drops an unknown declaration silently — no console warning,
 * no import error — so this is the whole value of the check. A diagnostic that
 * only said "invalid" would make the reader go searching; each entry says what
 * to reach for instead.
 */
export const CSS_ONLY_PROPERTIES: ReadonlyMap<string, string> = new Map([
  ['box-shadow', 'USS has no box-shadow. Use a 9-slice background image, or a border plus a nested element.'],
  ['text-shadow-color', 'Use text-shadow, which USS does support.'],
  ['z-index', 'USS has no z-index. Draw order follows the document order of the visual tree; reorder the elements, or call BringToFront() in C#.'],
  ['float', 'USS has no float. Every element is a flex item — use flex-direction and align-self.'],
  ['clear', 'USS has no float, so nothing to clear.'],
  ['gap', 'USS has no gap. Put margin on the children.'],
  ['row-gap', 'USS has no row-gap. Put margin-top/margin-bottom on the children.'],
  ['column-gap', 'USS has no column-gap. Put margin-left/margin-right on the children.'],
  ['grid-template-columns', 'USS has no grid. Nest flex containers, or use a ListView / MultiColumnListView.'],
  ['grid-template-rows', 'USS has no grid. Nest flex containers.'],
  ['grid-area', 'USS has no grid. Nest flex containers.'],
  ['text-transform', 'USS has no text-transform. Change the text itself, in UXML or C#.'],
  ['font-family', 'Use -unity-font-definition (or -unity-font for legacy Font assets).'],
  ['font-weight', 'Use -unity-font-style: bold, or a font asset with the weight built in.'],
  ['font-style', 'Use -unity-font-style: italic.'],
  ['line-height', 'USS has no line-height. Use -unity-paragraph-spacing, or padding on the label.'],
  ['text-align', 'Use -unity-text-align, which sets both axes (e.g. middle-center).'],
  ['text-decoration', 'USS has no text-decoration. Underline needs a separate element or a rich-text tag.'],
  ['box-sizing', 'USS always sizes the border box; there is nothing to set.'],
  ['outline', 'USS has no outline. Use border, or -unity-text-outline for text.'],
  ['filter', 'USS has no filters. Tint with -unity-background-image-tint-color, or use a shader on a material.'],
  ['backdrop-filter', 'USS has no backdrop filters.'],
  ['animation', 'USS has no keyframe animations. Use transition, or animate from C#.'],
  ['animation-name', 'USS has no keyframe animations. Use transition, or animate from C#.'],
  ['transform', 'USS splits this into translate, rotate and scale.'],
  ['content', 'USS has no generated content. Add a real element.'],
  ['pointer-events', 'Use picking-mode="Ignore" in UXML, or element.pickingMode in C#.'],
  ['user-select', 'USS has no user-select. Use a Label vs a TextField to control selectability.'],
  ['aspect-ratio', 'USS has no aspect-ratio. Set width and height, or compute it in C#.'],
  ['object-fit', 'Use -unity-background-scale-mode.'],
  ['inset', 'USS has no inset shorthand. Set left, top, right and bottom.'],
  ['vertical-align', 'Use -unity-text-align, which sets the vertical axis too.'],
]);

/** True when Unity's importer understands `property`. Custom properties always pass. */
export function isUssProperty(property: string): boolean {
  const name = property.trim().toLowerCase();
  // Custom properties are unbounded by definition — `--anything` is legal USS
  // and there is no list to check it against.
  if (name.startsWith('--')) return true;
  return REGISTRY_SET.has(name);
}

/** What to use instead of `property`, when we have specific advice. */
export function ussPropertyRemedy(property: string): string | null {
  return CSS_ONLY_PROPERTIES.get(property.trim().toLowerCase()) ?? null;
}

/**
 * The reset that makes a browser lay out like Yoga.
 *
 * This is the highest-leverage object in the renderer. Only 298 of 2,501 rules
 * in the measured corpus set `flex-direction`, so the other 88% depend on USS's
 * default being `column` where CSS gives `row`. Two of these entries
 * (`min-width`, `position`) additionally corrupt the OVERFLOW DIAGNOSTIC rather
 * than merely the picture, which is why each carries its provenance.
 */
export const USS_DEFAULTS: Readonly<Record<string, string>> = {
  // USS has only `flex` and `none`; there is no inline flow at all.
  display: 'flex',
  // The 88% case. Yoga's default main axis is vertical.
  'flex-direction': 'column',
  // Yoga's raw default is 0, but Unity's USS reference states 1 and Unity's own
  // stylesheets are written as though items shrink. PINNED HERE ON PURPOSE: it
  // is a 1-vs-0 difference that changes every constrained-width layout and
  // biases the overflow detector, so it is asserted in uss-properties.test.ts.
  // If a real project disagrees, that test fails loudly and this is a one-line
  // fix rather than an archaeology exercise.
  'flex-shrink': '1',
  // CSS's automatic minimum size refuses to shrink a flex item below its
  // content width. Yoga has no such rule. Without this the preview INVENTS
  // overflow that Unity never produces — poisoning the diagnostic, not just the
  // render.
  'min-width': '0',
  'min-height': '0',
  // In Yoga every element is a containing block, so `position: absolute` always
  // resolves against the direct parent. CSS defaults to `static` and walks up to
  // the nearest positioned ancestor. Reads like a no-op; is not.
  position: 'relative',
  // App.css sets this globally, but `box-sizing` is not inherited and the global
  // rule does not cross the shadow boundary. Yoga sizes the border box.
  'box-sizing': 'border-box',
  // UI Toolkit Labels do not wrap unless the author opts in. This is the single
  // most common cause of clipped text at narrow aspect ratios.
  'white-space': 'nowrap',
  // Yoga does not collapse margins; CSS flex does not either, but stating it
  // keeps the reset self-describing.
  margin: '0',
  padding: '0',
  'border-width': '0',
  // Text does not overflow its box invisibly in Unity — it is clipped by the
  // element's own overflow setting, which defaults to visible.
  overflow: 'visible',
  'align-items': 'stretch',
  'flex-basis': 'auto',
};
