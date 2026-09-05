// "Does this document's own stylesheet actually reach anything?"
//
// The failure this exists for: a `.uxml` full of well-named elements and
// carefully chosen class names, referencing no stylesheet — or one whose rules
// name different classes. It parses. Every string check passes. `unity_ui_write`
// writes it. `unity_ui_layout` lays it out and reports `Problems: none`, because
// the geometry lint measures boxes and boxes are fine. The screen renders as
// flat default grey and nothing in the harness says a word about it.
//
// Geometry and styling are genuinely different questions and `layout-lint.ts`
// only answers the first, so this answers the second. It is deliberately NOT a
// lint: there is no threshold at which "3 of 14 elements are styled" is a bug.
// It reports coverage and lets the reader — the model, mid-turn — decide.
//
// Pure: matched against `CompiledSelector.parts` through `cascade.ts`'s own
// matcher, with no DOM, so it runs under Bun and needs no preview open. The
// same property `cascade.ts` documents for itself, and the reason both can be
// called from a tool.

import { generatedUssClasses } from '../../../utils/uxml-controls';
import { ussPropertyGroup } from '../../../utils/uss-properties';
import { translateDeclaration, type UssStyleSheet } from '../../../utils/uss-model';
import { selectorMatches, isConditional, parseInlineStyle, type MatchTarget } from './cascade';
import type { RenderNode } from './render-plan';

/** `render-plan.ts`'s own machinery classes (`u-el`, the type chain, inline-style handles). */
const SYNTHETIC_CLASS = /^u-(el|t-|i-)/;

/**
 * Groups that make an element *look* like something, as opposed to sit
 * somewhere. `Layout` is excluded on purpose: a document whose only rules are
 * `flex-direction` and `padding` is laid out, not designed, and calling that
 * "styled" is exactly the over-report that would make this signal ignorable.
 */
function isPaint(property: string): boolean {
  const group = ussPropertyGroup(property);
  return group === 'Appearance' || group === 'Text';
}

export interface NodeCoverage {
  id: string;
  name: string | null;
  tag: string;
  /** Authored classes only — Unity's generated ones and the renderer's are stripped. */
  classes: string[];
  /** Non-conditional rules from the loaded sheets that match this element. */
  rules: number;
  /** Distinct Appearance/Text properties that actually reach it, inline style included. */
  paint: number;
}

export interface StyleCoverage {
  /**
   * Every element in the document. The `<UXML>` document node itself is
   * excluded and the render plan has already dropped `<Style>`/`<Template>`, so
   * this counts things a person could actually style.
   */
  total: number;
  /** Elements the project's stylesheets do not touch at all. */
  unstyled: NodeCoverage[];
  /** Elements a rule reaches, but only with layout/motion properties — nothing that paints. */
  unpainted: NodeCoverage[];
  /** Authored classes used in the markup that no loaded sheet declares. Sorted, de-duplicated. */
  undeclaredClasses: string[];
  /** How many stylesheets the document actually resolved. 0 means it references none. */
  sheetsReachable: number;
}

export const EMPTY_STYLE_COVERAGE: StyleCoverage = {
  total: 0,
  unstyled: [],
  unpainted: [],
  undeclaredClasses: [],
  sheetsReachable: 0,
};

/** Every class name any rule in these sheets targets. */
function declaredClasses(sheets: readonly UssStyleSheet[]): Set<string> {
  const out = new Set<string>();
  for (const sheet of sheets) {
    for (const rule of sheet.rules) {
      for (const selector of rule.selectors) {
        for (const part of selector.parts) {
          for (const simple of part.simples) {
            if (simple.kind === 'class') out.add(simple.name);
          }
        }
      }
    }
  }
  return out;
}

/**
 * The classes a human wrote on this element.
 *
 * `RenderNode.classes` is authored classes + the control's Unity-generated ones
 * + its whole type chain + inline-style handles. Only the first group can be
 * "used but declared nowhere" in any sense the author can act on — reporting
 * `unity-button` as undeclared would be noise about a class they never typed.
 */
function authoredClasses(node: RenderNode): string[] {
  const generated = new Set(generatedUssClasses(node.tag));
  return node.classes.filter((c) => !SYNTHETIC_CLASS.test(c) && !generated.has(c));
}

/** The class set the MATCHER sees — synthetic stripped, Unity's own kept (`.unity-button` is a real selector). */
function matchClasses(node: RenderNode): string[] {
  return node.classes.filter((c) => !SYNTHETIC_CLASS.test(c));
}

/**
 * How much of this document the loaded stylesheets actually style.
 *
 * `sheets` must be the sheets the document RESOLVED (`loadStyleSheets`), not
 * every `.uss` in the project — a rule in a sheet the document never references
 * styles nothing, and counting it would report the one failure this function
 * exists to catch as a success.
 */
export function styleCoverage(
  root: RenderNode | null,
  sheets: readonly UssStyleSheet[],
): StyleCoverage {
  if (!root) return { ...EMPTY_STYLE_COVERAGE, sheetsReachable: sheets.length };

  const declared = declaredClasses(sheets);
  const unstyled: NodeCoverage[] = [];
  const unpainted: NodeCoverage[] = [];
  const undeclared = new Set<string>();
  let total = 0;

  const visit = (node: RenderNode, ancestors: MatchTarget[]): void => {
    total++;

    const target: MatchTarget = {
      tag: node.tag,
      name: node.name,
      classes: matchClasses(node),
      // `cascade.ts`'s matcher wants nearest-ancestor-first.
      ancestors: [...ancestors].reverse(),
    };

    let rules = 0;
    const paint = new Set<string>();

    for (const sheet of sheets) {
      for (const rule of sheet.rules) {
        const matched = rule.selectors.some((s) => selectorMatches(s, target));
        if (!matched) continue;
        // A rule that only applies on `:hover` does not describe how the
        // element looks at rest, which is what "is this styled" asks.
        if (rule.selectors.every((s) => isConditional(s))) continue;
        rules++;
        for (const decl of rule.declarations) {
          // Unity drops these at import, so they paint nothing however they read.
          if (translateDeclaration(decl).css.length === 0) continue;
          if (isPaint(decl.property)) paint.add(decl.property);
        }
      }
    }

    for (const decl of parseInlineStyle(node.inlineStyle)) {
      if (isPaint(decl.property)) paint.add(decl.property);
    }

    const authored = authoredClasses(node);
    for (const cls of authored) {
      if (!declared.has(cls)) undeclared.add(cls);
    }

    const coverage: NodeCoverage = {
      id: node.id,
      name: node.name,
      tag: node.tag,
      classes: authored,
      rules,
      paint: paint.size,
    };
    if (rules === 0 && paint.size === 0) unstyled.push(coverage);
    else if (paint.size === 0) unpainted.push(coverage);

    const nextAncestors = [...ancestors, target];
    for (const child of node.children) visit(child, nextAncestors);
  };

  // `<ui:UXML>` is the document, not an element of it. It renders as the host's
  // only child, it is what `:root` (compiled to `:host`) addresses, and nobody
  // puts a class on it — so counting it made every single-container screen
  // report one unstyled element that no edit could ever fix. Its children are
  // still walked with it as their ancestor, so a `:root > .menu` selector and
  // any descendant selector rooted at the document still match.
  const documentTarget: MatchTarget = {
    tag: root.tag,
    name: root.name,
    classes: matchClasses(root),
    ancestors: [],
  };
  if (root.tag === 'UXML') {
    for (const child of root.children) visit(child, [documentTarget]);
  } else {
    visit(root, []);
  }

  return {
    total,
    unstyled,
    unpainted,
    undeclaredClasses: [...undeclared].sort(),
    sheetsReachable: sheets.length,
  };
}

/** `#play-button`, or `<Button>` when it has no name — the same label shape `layout-lint.ts` uses. */
export function coverageLabel(node: NodeCoverage): string {
  return node.name ? `#${node.name}` : `<${node.tag}>`;
}

const MAX_LISTED = 6;

/**
 * The block appended to a UI write's result, and to the layout tool's.
 *
 * Returns `null` when there is nothing to say — a fully styled document must
 * not produce a paragraph saying so, or the block stops being read.
 */
export function formatStyleCoverage(documentPath: string, coverage: StyleCoverage): string | null {
  if (coverage.total === 0) return null;

  const lines: string[] = [];

  if (coverage.sheetsReachable === 0) {
    lines.push(
      `${documentPath} references no stylesheet, so every one of its ${coverage.total} elements ` +
        'renders with Unity default styling. Write the .uss and reference it with <Style src>.',
    );
  } else if (coverage.unstyled.length > 0) {
    const listed = coverage.unstyled.slice(0, MAX_LISTED).map(coverageLabel).join(', ');
    const more = coverage.unstyled.length - Math.min(coverage.unstyled.length, MAX_LISTED);
    lines.push(
      `${coverage.unstyled.length} of ${coverage.total} elements matched no rule in this ` +
        `document's stylesheets: ${listed}${more > 0 ? `, …${more} more` : ''}.`,
    );
  }

  if (coverage.unpainted.length > 0 && coverage.sheetsReachable > 0) {
    const listed = coverage.unpainted.slice(0, MAX_LISTED).map(coverageLabel).join(', ');
    const more = coverage.unpainted.length - Math.min(coverage.unpainted.length, MAX_LISTED);
    lines.push(
      `${coverage.unpainted.length} element(s) are laid out but never painted — no colour, ` +
        `background, border or type reaches them: ${listed}${more > 0 ? `, …${more} more` : ''}.`,
    );
  }

  if (coverage.undeclaredClasses.length > 0) {
    const listed = coverage.undeclaredClasses.slice(0, MAX_LISTED).join(', ');
    const more = coverage.undeclaredClasses.length - Math.min(coverage.undeclaredClasses.length, MAX_LISTED);
    lines.push(
      `Classes used in the markup that no reachable stylesheet declares: ${listed}` +
        `${more > 0 ? `, …${more} more` : ''}. These style nothing.`,
    );
  }

  return lines.length > 0 ? lines.join('\n') : null;
}
