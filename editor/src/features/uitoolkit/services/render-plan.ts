// UXML + USS -> a DOM-shaped tree and one blob of CSS.
//
// Pure. Everything that decides *what the browser is told* lives here so it can
// be asserted in a DOM-less test; `PreviewStage` only mounts the result.
//
// The two rewrites that make this work at all are in `uss-model.compileSelector`
// (`:root` -> `:host`, and type selectors -> `.u-t-*` classes). This module's
// job is the other half of that bargain: stamping the type chain onto every
// node so those rewritten selectors have something to match.

import {
  parseUss,
  translateDeclaration,
  type UssStyleSheet,
} from '../../../utils/uss-model';
import { USS_DEFAULTS } from '../../../utils/uss-properties';
import { typeChainFor, generatedUssClasses } from '../../../utils/uxml-controls';
import { TYPE_CLASS_PREFIX } from '../../../utils/uss-model';
import type { UxmlDocument, UxmlNode } from '../../../utils/uxml-model';

/** Class put on every rendered element, carrying the Yoga defaults. */
export const ELEMENT_CLASS = 'u-el';

export interface RenderNode {
  /** `UxmlNode.id` — the link back to source for selection. */
  id: string;
  tag: string;
  /** Authored classes + the control's generated ones + its whole type chain. */
  classes: string[];
  /**
   * The `name` attribute, emitted as a real DOM id.
   *
   * Ids inside a shadow root are scoped to that root and UXML permits duplicate
   * names anyway, so the only thing given up is `getElementById` — which
   * nothing here uses. In exchange `#play-button` keeps Unity's id specificity
   * for free instead of needing a rewrite.
   */
  name: string | null;
  text: string | null;
  inlineStyle: string | null;
  children: RenderNode[];
}

export interface RenderPlan {
  root: RenderNode | null;
  /** Ready to drop straight into a `<style>` inside the shadow root. */
  css: string;
  /** Things deliberately not rendered, for the honesty strip. */
  notes: string[];
}

/** Elements that describe the document rather than appearing in it. */
function isMetadata(localName: string): boolean {
  return localName === 'Style' || localName === 'Template';
}

/** `0.1.2` -> `0-1-2`, so a node id can be used as a class name. */
export function inlineClassFor(id: string): string {
  return `u-i-${id.replace(/\./g, '-')}`;
}

function toRenderNode(node: UxmlNode): RenderNode {
  const chain = typeChainFor(node.localName).map((t) => `${TYPE_CLASS_PREFIX}${t}`);
  const inline = node.inlineStyle ? [inlineClassFor(node.id)] : [];
  return {
    id: node.id,
    tag: node.localName,
    // Order matters only for readability; CSS specificity is unaffected.
    classes: [
      ELEMENT_CLASS,
      ...chain,
      ...generatedUssClasses(node.localName),
      ...node.classes,
      ...inline,
    ],
    name: node.name,
    text: node.text,
    inlineStyle: node.inlineStyle,
    children: node.children.filter((c) => !isMetadata(c.localName)).map(toRenderNode),
  };
}

/**
 * The reset that makes a browser lay out like Yoga, plus the shadow-boundary
 * guard.
 *
 * `:host { all: initial }` is belt: inherited properties — `font-family`,
 * `color`, `white-space`, `cursor` — cross the shadow boundary from the IDE and
 * would otherwise style the preview. The second `:host` block is braces,
 * restoring the values we actually want, because `all: initial` would leave the
 * host with `font-family: Times`.
 *
 * Custom properties are the one thing `all` does NOT reset (per spec), and they
 * inherit across the boundary too. That is handled instead by the `:root` ->
 * `:host` rewrite in `compileSelector`: the document's own definitions land on
 * the host and win.
 */
function resetCss(): string {
  const defaults = Object.entries(USS_DEFAULTS)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join('\n');
  return [
    ':host { all: initial; }',
    ':host {',
    // Unity's `rootVisualElement` is an ordinary VisualElement: a flex COLUMN
    // that stretches its children, filling the panel. `display: block` here
    // gave the document's root a content height instead, so the near-universal
    // `flex-grow: 1` on a screen root grew into nothing and `justify-content`
    // had no free space to distribute -- the whole UI hugged the top of the
    // stage with the rest of the screen empty. This is the panel root, so it
    // has to behave like one.
    '  display: flex;',
    '  flex-direction: column;',
    '  align-items: stretch;',
    '  contain: layout style;',
    "  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;",
    '  font-size: 12px;',
    '  color: rgb(210, 210, 210);',
    '  line-height: 1.2;',
    '}',
    `.${ELEMENT_CLASS} {`,
    defaults,
    '}',
    // The `<UXML>` tag is not an element in Unity: its children are added
    // straight onto `rootVisualElement`. Rendering it as a div puts an extra
    // content-height box between the panel and the document, so a screen root
    // that says `flex-grow: 1` grows inside something that is already only as
    // tall as its content. Standing the document element in for
    // `rootVisualElement` -- the host's only child, filling it -- is what makes
    // the two chains agree.
    `:host > .${ELEMENT_CLASS} { flex-grow: 1; }`,
    BUILTIN_THEME,
  ].join('\n');
}

/**
 * A minimal stand-in for Unity's default runtime theme.
 *
 * `UnityDefaultRuntimeTheme.tss` resolves to `unity-theme://default`, which
 * lives inside the engine and is on disk nowhere -- so without this every stock
 * control renders with only the project's own USS. The visible symptom is
 * button labels sitting hard left, because Unity centres them and we had
 * nothing that said so.
 *
 * Deliberately tiny, and deliberately LOW specificity (bare class selectors,
 * emitted before any stylesheet) so a project rule always wins. This is an
 * approximation of the parts that are stable across Unity versions, not the
 * theme -- which is why `buildRenderPlan` says so in its notes.
 */
const BUILTIN_THEME = [
  '.unity-text-element { -webkit-user-select: none; user-select: none; }',
  // Unity centres button labels; without this they render left-aligned.
  '.unity-button { text-align: center; align-items: center; justify-content: center;',
  '  padding: 2px 6px; margin: 2px; border-radius: 3px; }',
  '.unity-label { text-align: left; align-items: flex-start; }',
  '.unity-base-field { flex-direction: row; align-items: center; }',
  '.unity-scroll-view { flex-direction: column; }',
].join('\n');

function sheetCss(sheet: UssStyleSheet, notes: string[]): string {
  const out: string[] = [];
  for (const rule of sheet.rules) {
    const decls: string[] = [];
    for (const decl of rule.declarations) {
      const translated = translateDeclaration(decl);
      decls.push(...translated.css.map((d) => `  ${d};`));
      if (translated.unsupported) {
        const note = `${decl.property}: ${translated.unsupported}`;
        if (!notes.includes(note)) notes.push(note);
      }
    }
    if (decls.length === 0) continue;
    // One CSS rule per selector rather than a comma list: an unrecognised
    // pseudo-class compiles to an empty string, and leaving that in a comma
    // list would invalidate every sibling selector along with it.
    const selectors = rule.selectors.map((s) => s.css).filter((s) => s.trim() !== '');
    if (selectors.length === 0) continue;
    out.push(`${selectors.join(',\n')} {\n${decls.join('\n')}\n}`);
  }
  return out.join('\n\n');
}

/** Build the plan. `sheets` are the stylesheets the document resolved to. */
export function buildRenderPlan(
  doc: UxmlDocument,
  sheets: readonly UssStyleSheet[],
): RenderPlan {
  const notes: string[] = [];
  const root = doc.root ? toRenderNode(doc.root) : null;

  const parts = [resetCss()];
  for (const sheet of sheets) {
    const css = sheetCss(sheet, notes);
    if (css !== '') parts.push(`/* ${sheet.path} */\n${css}`);
  }

  const inlineRules: string[] = [];
  (function collectInline(node: UxmlNode | null) {
    if (!node) return;
    if (node.inlineStyle) {
      // Parsed as a rule body so it goes through `translateDeclaration` like
      // every other declaration -- a `style="-unity-text-align: middle-center"`
      // has to expand the same way it would from a stylesheet.
      const sheet = parseUss(`x { ${node.inlineStyle} }`, '<inline>');
      const decls = sheet.rules.flatMap((r) =>
        r.declarations.flatMap((d) => translateDeclaration(d).css),
      );
      if (decls.length > 0) {
        inlineRules.push(`.${inlineClassFor(node.id)} {\n${decls.map((d) => `  ${d};`).join('\n')}\n}`);
      }
    }
    for (const child of node.children) collectInline(child);
  })(doc.root);
  // Last, so an inline style wins over a stylesheet -- which is Unity's order.
  if (inlineRules.length > 0) parts.push(`/* inline style="" */\n${inlineRules.join('\n\n')}`);

  notes.push(
    "Unity's built-in theme is not on disk, so stock controls use an approximation of it.",
  );

  if (doc.styleRefs.length > sheets.length) {
    notes.push(
      `${doc.styleRefs.length - sheets.length} stylesheet(s) could not be resolved, so the preview is missing their styles.`,
    );
  }

  return { root, css: parts.join('\n\n'), notes };
}

/** Convenience for tests and for the single-file case. */
export function buildRenderPlanFromText(
  doc: UxmlDocument,
  sheetSources: readonly { path: string; content: string }[],
): RenderPlan {
  return buildRenderPlan(
    doc,
    sheetSources.map((s) => parseUss(s.content, s.path)),
  );
}
