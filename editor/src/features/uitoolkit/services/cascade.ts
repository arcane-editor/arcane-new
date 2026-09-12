// "Why does this element look like this?"
//
// Every USS rule that matches an element, in specificity order, with the winning
// declaration per property and the ones it beat. Browsers have shipped this
// since 2010; Unity's UI Builder lists matching selectors and resolves nothing,
// so "which of my four rules is setting this colour" is currently answered by
// commenting rules out one at a time.
//
// Matched WITHOUT a DOM, against `CompiledSelector.parts` — which exists for
// precisely this reason. That keeps the whole thing testable under Bun and means
// the same answer can later be given from an analyzer rule with no preview open.

import type { CompiledSelector, UssStyleSheet, Simple } from '../../../utils/uss-model';
import { translateDeclaration } from '../../../utils/uss-model';
import { typeChainFor } from '../../../utils/uxml-controls';
import {
  ussPropertyGroup,
  USS_PROPERTY_GROUP_ORDER,
  type UssPropertyGroup,
} from '../../../utils/uss-properties';
import type { RenderNode } from './render-plan';

/** The subset of a node the matcher needs, plus its ancestors. */
export interface MatchTarget {
  tag: string;
  name: string | null;
  classes: string[];
  /** Nearest ancestor first. */
  ancestors: MatchTarget[];
}

/** Build a match target for `id`, carrying its ancestor chain. */
export function targetFor(root: RenderNode | null, id: string): MatchTarget | null {
  const path: RenderNode[] = [];
  const walk = (node: RenderNode, trail: RenderNode[]): boolean => {
    const next = [...trail, node];
    if (node.id === id) {
      path.push(...next);
      return true;
    }
    return node.children.some((c) => walk(c, next));
  };
  if (!root || !walk(root, [])) return null;

  const toTarget = (n: RenderNode, ancestors: RenderNode[]): MatchTarget => ({
    tag: n.tag,
    name: n.name,
    // Strip only the renderer's synthetic classes (`u-el`, `u-t-*`, `u-i-*`),
    // which exist to make type selectors and inline styles work and which no
    // USS ever targets. Unity's OWN generated classes stay: `.unity-button` is
    // a selector people really write, so hiding it would under-report.
    classes: n.classes.filter((c) => !/^u-(el|t-|i-)/.test(c)),
    ancestors: ancestors.map((a, i) => toTarget(a, ancestors.slice(0, i))).reverse(),
  });

  const node = path[path.length - 1];
  return toTarget(node, path.slice(0, -1));
}

/** Does one compound selector match this element? Pseudo-classes are ignored. */
function compoundMatches(simples: Simple[], target: MatchTarget): boolean {
  for (const s of simples) {
    switch (s.kind) {
      case 'universal':
        break;
      case 'class':
        if (!target.classes.includes(s.name)) return false;
        break;
      case 'id':
        if (target.name !== s.name) return false;
        break;
      case 'type':
        // A USS type selector matches the whole inheritance chain, which is
        // why `VisualElement { }` styles everything.
        if (!typeChainFor(target.tag).includes(s.name)) return false;
        break;
      case 'pseudo':
        // `:hover` and `:checked` describe a state we have no live value for.
        // Reported as conditional rather than evaluated.
        break;
    }
  }
  return true;
}

/** Right-to-left match, the way a browser does it. */
export function selectorMatches(selector: CompiledSelector, target: MatchTarget): boolean {
  const parts = selector.parts;
  if (parts.length === 0) return false;
  if (!compoundMatches(parts[parts.length - 1].simples, target)) return false;

  let candidates = target.ancestors;
  for (let i = parts.length - 2; i >= 0; i--) {
    const combinator = selector.combinators[i];
    if (combinator === 'child') {
      const parent = candidates[0];
      if (!parent || !compoundMatches(parts[i].simples, parent)) return false;
      candidates = parent.ancestors;
    } else {
      const at = candidates.findIndex((a) => compoundMatches(parts[i].simples, a));
      if (at === -1) return false;
      candidates = candidates[at].ancestors;
    }
  }
  return true;
}

/** True when the selector only applies in a state we cannot evaluate. */
export function isConditional(selector: CompiledSelector): boolean {
  return selector.parts.some((p) =>
    p.simples.some((s) => s.kind === 'pseudo' && s.name !== 'root'),
  );
}

export interface CascadeDecl {
  property: string;
  value: string;
  /** False when a later, more specific rule set the same property. */
  winning: boolean;
  /** Set when Unity drops the declaration entirely at import. */
  dropped: string | null;
}

export interface CascadeRule {
  selector: string;
  specificity: [number, number, number];
  sheet: string;
  /** 1-based line of the selector in its stylesheet. */
  line: number;
  /** Only applies on `:hover` / `:checked` / … */
  conditional: boolean;
  declarations: CascadeDecl[];
}

function specLess(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

/**
 * Every rule that styles this element, most specific first, with each
 * declaration marked as winning or beaten.
 *
 * Conditional rules (`:hover`) are listed but never allowed to win: they are not
 * in effect, and letting them strike out the base value would misreport what the
 * element looks like right now.
 */
export function cascadeFor(
  target: MatchTarget,
  sheets: readonly UssStyleSheet[],
): CascadeRule[] {
  const matched: CascadeRule[] = [];

  for (const sheet of sheets) {
    for (const rule of sheet.rules) {
      for (const selector of rule.selectors) {
        if (!selectorMatches(selector, target)) continue;
        matched.push({
          selector: selector.source,
          specificity: selector.specificity,
          sheet: sheet.path,
          line: lineOf(sheet.source, selector.span.start),
          conditional: isConditional(selector),
          declarations: rule.declarations.map((d) => {
            const t = translateDeclaration(d);
            return {
              property: d.property,
              value: d.value,
              winning: true,
              dropped: t.css.length === 0 ? t.unsupported ?? 'Unity drops this at import.' : null,
            };
          }),
        });
        break; // one entry per rule, however many of its selectors matched
      }
    }
  }

  // Later and more specific wins, so resolve from the strongest downwards.
  matched.sort((a, b) => (specLess(a.specificity, b.specificity) ? 1 : -1));

  const claimed = new Set<string>();
  for (const rule of matched) {
    for (const decl of rule.declarations) {
      if (rule.conditional || decl.dropped !== null) {
        decl.winning = false;
        continue;
      }
      if (claimed.has(decl.property)) decl.winning = false;
      else claimed.add(decl.property);
    }
  }
  return matched;
}

// ── What actually applies ────────────────────────────────────────────────────

/**
 * Split a UXML `style="…"` attribute into declarations.
 *
 * Semicolons inside `url("a;b")` or `rgb(…)` are not separators, so this tracks
 * quotes and paren depth rather than splitting on `;` — the same class of bug
 * as splitting a CSV on commas.
 */
export function parseInlineStyle(style: string | null): Array<{ property: string; value: string }> {
  if (!style) return [];
  const out: Array<{ property: string; value: string }> = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  const flush = (end: number) => {
    const chunk = style.slice(start, end);
    const colon = chunk.indexOf(':');
    if (colon > 0) {
      const property = chunk.slice(0, colon).trim();
      const value = chunk.slice(colon + 1).trim();
      if (property && value) out.push({ property, value });
    }
    start = end + 1;
  };
  for (let i = 0; i < style.length; i++) {
    const c = style[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ';' && depth === 0) flush(i);
  }
  flush(style.length);
  return out;
}

export type SourceState =
  /** The value in effect. */
  | 'winner'
  /** Set, but a stronger declaration took the property. */
  | 'overridden'
  /** Unity's importer discards it, so it never applies at all. */
  | 'dropped'
  /** Only applies in a state we have no live value for (`:hover`). */
  | 'state';

export interface PropertySource {
  /** The selector that set it, or `style=""` for the UXML's own attribute. */
  selector: string;
  /** Where to jump. Null for an inline style, which lives in the UXML. */
  sheet: string | null;
  line: number;
  value: string;
  state: SourceState;
  /** Why Unity drops it. Only set when `state` is `dropped`. */
  note: string | null;
}

export interface PropertyEntry {
  property: string;
  group: UssPropertyGroup;
  /** The value in effect, or null when nothing survives to set one. */
  value: string | null;
  /** Where `value` came from — or the strongest source, when nothing wins. */
  origin: PropertySource;
  /** Everything that set this property, strongest first. */
  sources: PropertySource[];
}

/**
 * One entry per property, carrying its own provenance.
 *
 * This replaces the pair of lists the panel used to show — the resolved values,
 * then every matched rule again underneath. The second list restated the first
 * at four times the height and still made "which rule set this?" a matter of
 * reading both and joining them by eye. Folding the sources into the property
 * puts the answer and the working in the same row.
 *
 * Inline styles are listed first and win outright: UI Toolkit applies them
 * above every selector regardless of specificity, so a view that omits them
 * names the wrong winner whenever both set the same property.
 */
export function propertyEntries(
  inlineStyle: string | null,
  rules: readonly CascadeRule[],
): PropertyEntry[] {
  const byProperty = new Map<string, PropertySource[]>();
  const add = (property: string, source: PropertySource) => {
    const list = byProperty.get(property);
    if (list) list.push(source);
    else byProperty.set(property, [source]);
  };

  const inlineClaimed = new Set<string>();
  for (const { property, value } of parseInlineStyle(inlineStyle)) {
    const first = !inlineClaimed.has(property);
    inlineClaimed.add(property);
    add(property, {
      selector: 'style=""',
      sheet: null,
      line: 0,
      value,
      state: first ? 'winner' : 'overridden',
      note: null,
    });
  }

  // `rules` arrives strongest-first from `cascadeFor`, with `winning` already
  // resolved among the selectors; inline is the one thing it cannot know about.
  for (const rule of rules) {
    for (const decl of rule.declarations) {
      const state: SourceState = decl.dropped
        ? 'dropped'
        : rule.conditional
          ? 'state'
          : decl.winning && !inlineClaimed.has(decl.property)
            ? 'winner'
            : 'overridden';
      add(decl.property, {
        selector: rule.selector,
        sheet: rule.sheet,
        line: rule.line,
        value: decl.value,
        state,
        note: decl.dropped,
      });
    }
  }

  const entries: PropertyEntry[] = [];
  for (const [property, sources] of byProperty) {
    const winner = sources.find((s) => s.state === 'winner') ?? null;
    entries.push({
      property,
      group: ussPropertyGroup(property),
      value: winner ? winner.value : null,
      origin: winner ?? sources[0],
      sources,
    });
  }

  // Group order first, then alphabetical inside a group: the grouping is the
  // scanning aid, the sort inside it is so a property stays where you left it.
  return entries.sort((a, b) => {
    const byGroup =
      USS_PROPERTY_GROUP_ORDER.indexOf(a.group) - USS_PROPERTY_GROUP_ORDER.indexOf(b.group);
    return byGroup !== 0 ? byGroup : a.property.localeCompare(b.property);
  });
}
