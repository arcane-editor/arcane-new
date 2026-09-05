// USS parsing and translation to browser-evaluable CSS.
//
// Three jobs, deliberately in one module because they share the same tokens:
//   1. `parseUss`            — source -> rules/declarations WITH source offsets
//   2. `compileSelector`     — a USS selector -> a CSS selector + structural parts
//   3. `translateDeclaration`— a USS declaration -> zero or more CSS declarations
//
// The measured shape of the problem (193 real .uss files, 2,501 rules): 90
// distinct properties of which only 23 are `-unity-*`; the only at-rule anywhere
// is `@import`; seven pseudo-classes; child/descendant/universal/list
// combinators and nothing else — no sibling combinators, no attribute
// selectors. So this is a subset parser by design, not a general CSS engine.
//
// A leaf module: no imports beyond the property tables, so analyzer rules and
// Bun tests can both load it.

import { isUssProperty, ussPropertyRemedy, CSS_ONLY_PROPERTIES } from './uss-properties';
import type { UxmlSpan } from './uxml-model';

export type Combinator = 'descendant' | 'child';

export type Simple =
  | { kind: 'type'; name: string }
  | { kind: 'class'; name: string }
  | { kind: 'id'; name: string }
  | { kind: 'universal' }
  | { kind: 'pseudo'; name: string };

export interface CompiledSelector {
  /** As authored. */
  source: string;
  /** Browser-evaluable rewrite — see the notes on `compileSelector`. */
  css: string;
  /** One entry per compound selector, for a DOM-free matcher. */
  parts: { simples: Simple[] }[];
  /** `parts.length - 1` entries. */
  combinators: Combinator[];
  /** CSS-style [id, class+pseudo, type]. */
  specificity: [number, number, number];
  span: UxmlSpan;
}

export interface UssDeclaration {
  property: string;
  value: string;
  important: boolean;
  span: UxmlSpan;
  /** Lands on the property token alone, so a squiggle is precise. */
  propertySpan: UxmlSpan;
}

export interface UssRule {
  selectors: CompiledSelector[];
  declarations: UssDeclaration[];
  span: UxmlSpan;
}

export interface UssImport {
  url: string;
  span: UxmlSpan;
}

export interface UssStyleSheet {
  /** Absolute path, or `<inline>` for a `style=""` attribute. */
  path: string;
  rules: UssRule[];
  imports: UssImport[];
  source: string;
}

// ── Comment blanking ─────────────────────────────────────────────────────────

/**
 * Replace comment bodies with spaces, preserving length and therefore every
 * offset after them.
 *
 * Deleting comments instead would shift every subsequent offset, which is the
 * classic way squiggles end up one comment to the left. Same technique
 * `csharp-scan.ts` uses for the same reason.
 */
function blankComments(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    if (source[i] === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      for (let k = i; k < stop; k++) out += source[k] === '\n' ? '\n' : ' ';
      i = stop;
      continue;
    }
    out += source[i];
    i++;
  }
  return out;
}

// ── Selectors ────────────────────────────────────────────────────────────────

/** Unity states with no DOM equivalent; the renderer toggles these as classes. */
const STATE_PSEUDO: Record<string, string> = {
  checked: 'u-s-checked',
  selected: 'u-s-selected',
  disabled: 'u-s-disabled',
  enabled: 'u-s-enabled',
  inactive: 'u-s-inactive',
};

/** Pseudo-classes the browser already implements identically. */
const NATIVE_PSEUDO = new Set(['hover', 'active', 'focus']);

/**
 * Every pseudo-class USS implements, without the leading colon.
 *
 * Exported because `compoundToCss` DROPS anything outside this set — an
 * unrecognised pseudo-class makes the whole selector invalid in CSS, so passing
 * it through would silently discard the rule. Unity does exactly the same thing
 * with exactly as little noise, which is why a checker has to be able to name
 * the set rather than infer it.
 */
export const USS_PSEUDO_CLASSES: ReadonlySet<string> = new Set([
  'root',
  ...NATIVE_PSEUDO,
  ...Object.keys(STATE_PSEUDO),
]);

/** Prefix for a materialised UXML type name. See `compileSelector`. */
export const TYPE_CLASS_PREFIX = 'u-t-';

function parseCompound(text: string): Simple[] {
  const simples: Simple[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '*') {
      simples.push({ kind: 'universal' });
      i++;
    } else if (ch === '.') {
      const start = ++i;
      while (i < n && /[\w-]/.test(text[i])) i++;
      simples.push({ kind: 'class', name: text.slice(start, i) });
    } else if (ch === '#') {
      const start = ++i;
      while (i < n && /[\w-]/.test(text[i])) i++;
      simples.push({ kind: 'id', name: text.slice(start, i) });
    } else if (ch === ':') {
      const start = ++i;
      while (i < n && /[\w-]/.test(text[i])) i++;
      simples.push({ kind: 'pseudo', name: text.slice(start, i) });
    } else if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      while (i < n && /[\w.-]/.test(text[i]) && text[i] !== '.') i++;
      simples.push({ kind: 'type', name: text.slice(start, i) });
    } else {
      i++;
    }
  }
  return simples;
}

function compoundToCss(simples: Simple[]): string {
  let out = '';
  for (const s of simples) {
    switch (s.kind) {
      case 'universal':
        out += '*';
        break;
      case 'class':
        out += `.${s.name}`;
        break;
      case 'id':
        // Emitted as a real id. Ids inside a shadow root are scoped to that
        // root, and UXML permits duplicate names anyway, so the only thing lost
        // is `getElementById` — which nothing here uses. In exchange the
        // cascade keeps Unity's id specificity for free.
        out += `#${s.name}`;
        break;
      case 'type':
        // USS type selectors match the C# inheritance chain, so `VisualElement`
        // matches every element. The renderer stamps the whole chain onto each
        // node as `u-t-*` classes; rewriting the selector to match one of those
        // reproduces Unity's semantics with no matcher code.
        out += `.${TYPE_CLASS_PREFIX}${s.name}`;
        break;
      case 'pseudo':
        if (s.name === 'root') {
          // `:root` matches the document element — inside a shadow root that is
          // NOTHING. Every custom-property block in the corpus is `:root { }`,
          // so without this rewrite `var()` silently falls through to the IDE's
          // own tokens, which inherit across the shadow boundary and render
          // something plausible and wrong.
          out += ':host';
        } else if (NATIVE_PSEUDO.has(s.name)) {
          out += `:${s.name}`;
        } else if (STATE_PSEUDO[s.name]) {
          out += `.${STATE_PSEUDO[s.name]}`;
        }
        // An unknown pseudo-class is dropped rather than passed through: an
        // unrecognised one makes the whole selector invalid in CSS, which would
        // silently discard the rule.
        break;
    }
  }
  return out;
}

function specificityOf(parts: { simples: Simple[] }[]): [number, number, number] {
  let a = 0, b = 0, c = 0;
  for (const part of parts) {
    for (const s of part.simples) {
      if (s.kind === 'id') a++;
      // A type selector is emitted as a class but keeps TYPE weight, so the
      // cascade preserves Unity's ordering rather than the rewrite's.
      else if (s.kind === 'class' || s.kind === 'pseudo') b++;
      else if (s.kind === 'type') c++;
    }
  }
  return [a, b, c];
}

/** Compile one USS selector (no commas) into CSS plus its structural parts. */
export function compileSelector(source: string, offset: number): CompiledSelector {
  const text = source.trim();
  const parts: { simples: Simple[] }[] = [];
  const combinators: Combinator[] = [];

  // Split on combinators, keeping `>` as an explicit token.
  const tokens = text.split(/\s*(>)\s*|\s+/).filter((t) => t !== undefined && t !== '');
  let pendingChild = false;
  for (const token of tokens) {
    if (token === '>') {
      pendingChild = true;
      continue;
    }
    if (parts.length > 0) combinators.push(pendingChild ? 'child' : 'descendant');
    pendingChild = false;
    parts.push({ simples: parseCompound(token) });
  }

  const css = parts
    .map((p, idx) => (idx === 0 ? '' : combinators[idx - 1] === 'child' ? ' > ' : ' ') + compoundToCss(p.simples))
    .join('');

  return {
    source: text,
    css,
    parts,
    combinators,
    specificity: specificityOf(parts),
    span: { start: offset, end: offset + source.length },
  };
}

// ── Declarations ─────────────────────────────────────────────────────────────

const TEXT_ALIGN_H: Record<string, string> = { left: 'left', center: 'center', right: 'right' };
const TEXT_ALIGN_V: Record<string, string> = {
  upper: 'flex-start', middle: 'center', lower: 'flex-end',
};

const FONT_STYLE: Record<string, [string, string]> = {
  normal: ['400', 'normal'],
  bold: ['700', 'normal'],
  italic: ['400', 'italic'],
  'bold-and-italic': ['700', 'italic'],
};

const SCALE_MODE: Record<string, string> = {
  'scale-to-fit': 'contain',
  'scale-and-crop': 'cover',
  'stretch-to-fill': '100% 100%',
};

/** Unity cursor keywords that have a CSS peer. Anything else must be dropped. */
const CURSOR_MAP: Record<string, string> = {
  arrow: 'default',
  text: 'text',
  'resize-vertical': 'ns-resize',
  'resize-horizontal': 'ew-resize',
  'resize-up-left': 'nwse-resize',
  'resize-up-right': 'nesw-resize',
  link: 'pointer',
  pan: 'grab',
  orbit: 'grab',
  zoom: 'zoom-in',
  'split-resize-up-down': 'ns-resize',
  'split-resize-left-right': 'ew-resize',
};

/** CSS cursor keywords, which USS also accepts and which need no mapping. */
const NATIVE_CURSORS = new Set([
  'default', 'pointer', 'text', 'move', 'grab', 'grabbing', 'crosshair', 'wait',
  'help', 'not-allowed', 'ns-resize', 'ew-resize', 'nwse-resize', 'nesw-resize',
  'zoom-in', 'zoom-out', 'none', 'initial', 'inherit',
]);

/**
 * `-unity-*` properties with no CSS equivalent at all. Dropped and reported —
 * the alternative is emitting a declaration the browser discards anyway, which
 * loses the information that anything was lost.
 */
const UNITY_UNSUPPORTED: Record<string, string> = {
  '-unity-background-image-tint-color': 'Background tinting has no CSS equivalent; the image renders untinted in this preview.',
  '-unity-font': 'Font assets are not loaded in this preview; a system font is substituted.',
  '-unity-font-definition': 'Font assets are not loaded in this preview; a system font is substituted.',
  '-unity-text-outline': 'Text outlines are not rendered in this preview.',
  '-unity-text-outline-color': 'Text outlines are not rendered in this preview.',
  '-unity-text-outline-width': 'Text outlines are not rendered in this preview.',
  '-unity-paragraph-spacing': 'Paragraph spacing is not rendered in this preview.',
  '-unity-overflow-clip-box': 'The clip box is not modelled in this preview.',
  '-unity-slice-type': '9-slice rendering is not modelled in this preview.',
  '-unity-text-generator': 'Text generator selection does not affect this preview.',
  '-unity-editor-text-rendering-mode': 'Editor text rendering does not affect this preview.',
};

/** Normalise `MiddleCenter` / `middle-center` / `Middle-Center` to `middle-center`. */
function normaliseKeyword(value: string): string {
  const trimmed = value.trim();
  if (trimmed.includes('-') || trimmed === trimmed.toLowerCase()) return trimmed.toLowerCase();
  // Unity writes some enum values in PascalCase; split on the case boundaries.
  return trimmed.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

export interface TranslatedDeclaration {
  /** Zero or more `property: value` strings, ready to join with `;`. */
  css: string[];
  /** Set when something was deliberately dropped, with the reason to show. */
  unsupported?: string;
}

/** Translate one USS declaration into browser CSS. */
export function translateDeclaration(decl: UssDeclaration): TranslatedDeclaration {
  const property = decl.property.trim().toLowerCase();
  const value = decl.value.trim();

  // Custom properties are native CSS and pass through untouched — which is what
  // makes the `:root` -> `:host` rewrite in `compileSelector` load-bearing.
  if (property.startsWith('--')) return { css: [`${property}: ${value}`] };

  if (CSS_ONLY_PROPERTIES.has(property)) {
    return { css: [], unsupported: ussPropertyRemedy(property) ?? undefined };
  }
  if (UNITY_UNSUPPORTED[property]) {
    return { css: [], unsupported: UNITY_UNSUPPORTED[property] };
  }

  switch (property) {
    case '-unity-text-align': {
      const parts = normaliseKeyword(value).split('-');
      const v = TEXT_ALIGN_V[parts[0]];
      const h = TEXT_ALIGN_H[parts[1]];
      if (!v || !h) return { css: [], unsupported: `Unrecognised -unity-text-align value '${value}'.` };
      // Two axes. The vertical half only works because the defaults reset makes
      // every element display:flex.
      return { css: [`text-align: ${h}`, `align-items: ${v}`] };
    }
    case '-unity-font-style': {
      const mapped = FONT_STYLE[normaliseKeyword(value)];
      if (!mapped) return { css: [], unsupported: `Unrecognised -unity-font-style value '${value}'.` };
      return { css: [`font-weight: ${mapped[0]}`, `font-style: ${mapped[1]}`] };
    }
    case '-unity-background-scale-mode': {
      const mapped = SCALE_MODE[normaliseKeyword(value)];
      if (!mapped) return { css: [], unsupported: `Unrecognised -unity-background-scale-mode value '${value}'.` };
      return { css: [`background-size: ${mapped}`] };
    }
    case 'cursor': {
      const key = normaliseKeyword(value);
      if (NATIVE_CURSORS.has(key)) return { css: [`cursor: ${key}`] };
      const mapped = CURSOR_MAP[key];
      if (mapped) return { css: [`cursor: ${mapped}`] };
      // An unmapped keyword invalidates the whole declaration in CSS, so the
      // browser would discard it silently. Drop it here so we can say so.
      return { css: [], unsupported: `Cursor '${value}' has no CSS equivalent; the default cursor is shown.` };
    }
    case 'white-space': {
      const key = normaliseKeyword(value);
      if (key !== 'normal' && key !== 'nowrap' && key !== 'pre' && key !== 'pre-wrap') {
        // `white-space: wrap` appears once in Unity's own stylesheets and is
        // invalid in USS and CSS alike. Unity says nothing about it; we do.
        return { css: [], unsupported: `'${value}' is not a valid white-space value. Use 'normal' to wrap or 'nowrap' to clip.` };
      }
      return { css: [`white-space: ${key}`] };
    }
    default:
      break;
  }

  // `-unity-*` properties not otherwise handled: pass nothing, say nothing
  // specific. They are real USS but affect editor styling we do not model.
  if (property.startsWith('-unity-')) {
    return isUssProperty(property)
      ? { css: [] }
      : { css: [], unsupported: `'${property}' is not a USS property.` };
  }

  if (!isUssProperty(property)) {
    return { css: [], unsupported: `'${property}' is not a USS property; Unity drops it at import.` };
  }
  return { css: [`${property}: ${value}`] };
}

// ── Sheet parsing ────────────────────────────────────────────────────────────

const IMPORT_RE = /@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)\s*;/g;

/** Parse a stylesheet. Never throws; a half-typed rule yields what parsed. */
export function parseUss(source: string, path: string): UssStyleSheet {
  const blanked = blankComments(source);
  const rules: UssRule[] = [];
  const imports: UssImport[] = [];

  IMPORT_RE.lastIndex = 0;
  for (let m = IMPORT_RE.exec(blanked); m !== null; m = IMPORT_RE.exec(blanked)) {
    imports.push({
      url: m[2] ?? m[4] ?? '',
      span: { start: m.index, end: m.index + m[0].length },
    });
  }

  let i = 0;
  const n = blanked.length;
  while (i < n) {
    const open = blanked.indexOf('{', i);
    if (open === -1) break;

    // Everything between the previous `}` and this `{`. Statement at-rules end
    // in `;` and do NOT own the block that follows, so `@import url(…);` sitting
    // above `.a { }` would otherwise make this whole rule look like an at-rule
    // and get skipped. Cut at the last `;` to get the real selector list.
    const preludeAll = blanked.slice(i, open);
    const lastSemi = preludeAll.lastIndexOf(';');
    const preludeStart = i + lastSemi + 1;
    const prelude = preludeAll.slice(lastSemi + 1);

    // A block at-rule (`@media`, `@keyframes`) does own its block; skip it whole.
    if (prelude.trimStart().startsWith('@')) {
      const close = matchBrace(blanked, open);
      i = close === -1 ? n : close + 1;
      continue;
    }

    const close = matchBrace(blanked, open);
    const body = blanked.slice(open + 1, close === -1 ? n : close);
    const bodyOffset = open + 1;

    const selectors: CompiledSelector[] = [];
    let cursor = preludeStart;
    for (const chunk of prelude.split(',')) {
      const leading = chunk.length - chunk.trimStart().length;
      const trimmed = chunk.trim();
      if (trimmed !== '') selectors.push(compileSelector(trimmed, cursor + leading));
      cursor += chunk.length + 1; // +1 for the comma
    }

    if (selectors.length > 0) {
      rules.push({
        selectors,
        declarations: parseDeclarations(source, body, bodyOffset),
        span: { start: i, end: (close === -1 ? n : close) + 1 },
      });
    }

    i = (close === -1 ? n : close) + 1;
  }

  return { path, rules, imports, source };
}

/** Index of the `}` matching the `{` at `open`, or -1 when unterminated. */
function matchBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function parseDeclarations(source: string, body: string, bodyOffset: number): UssDeclaration[] {
  const out: UssDeclaration[] = [];
  let i = 0;
  const n = body.length;
  while (i < n) {
    while (i < n && /\s/.test(body[i])) i++;
    if (i >= n) break;

    const propStart = i;
    while (i < n && body[i] !== ':' && body[i] !== ';' && body[i] !== '}') i++;
    if (i >= n || body[i] !== ':') {
      // No colon — a half-typed declaration. Skip to the next `;`.
      const semi = body.indexOf(';', propStart);
      if (semi === -1) break;
      i = semi + 1;
      continue;
    }
    const propEnd = i;
    i++; // ':'

    const valStart = i;
    let depth = 0;
    while (i < n) {
      const ch = body[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === ';' && depth === 0) break;
      i++;
    }
    const rawValue = body.slice(valStart, i);
    if (i < n) i++; // ';'

    const property = body.slice(propStart, propEnd).trim();
    if (property === '') continue;

    const important = /!\s*important\s*$/i.test(rawValue);
    const value = important ? rawValue.replace(/!\s*important\s*$/i, '').trim() : rawValue.trim();

    // Offsets are computed against the ORIGINAL source, which is why comments
    // were blanked rather than deleted.
    const absPropStart = bodyOffset + propStart + (body.slice(propStart, propEnd).length - body.slice(propStart, propEnd).trimStart().length);
    out.push({
      property,
      value,
      important,
      span: { start: bodyOffset + propStart, end: bodyOffset + i },
      propertySpan: { start: absPropStart, end: absPropStart + property.length },
    });

    void source;
  }
  return out;
}
