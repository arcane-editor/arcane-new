// UXML parsing: source text -> a visual tree with byte-exact source offsets.
//
// **Why this is hand-rolled rather than `DOMParser`.** Two independent reasons,
// either sufficient. `DOMParser` cannot report source offsets — there is no API
// for it — and offsets are the whole point here: tree-to-source jumps,
// source-to-tree selection, and every diagnostic's line/column come from them.
// And `DOMParser` does not exist under Bun (verified: `typeof DOMParser` is
// `'undefined'`), so a parser built on it could not be unit-tested, while this
// one is also read by analyzer rules that run in that same DOM-less runtime.
//
// **Why it recovers instead of throwing.** The preview reads the LIVE Monaco
// buffer, so it sees a half-typed tag on nearly every keystroke. A throwing
// parser would flash the fallback view continuously. The contract is: always a
// usable tree, plus diagnostics describing what was wrong.
//
// A leaf module by design — no imports at all, so it is loadable from rules,
// from the renderer, and from a Bun test alike.

export interface UxmlSpan {
  /** 0-based offset into the source. */
  start: number;
  /** Exclusive. */
  end: number;
}

export interface UxmlAttr {
  /** As authored: `picking-mode`, `src`, `xmlns:ui`. */
  name: string;
  /** Entity-decoded. */
  value: string;
  nameSpan: UxmlSpan;
  /** Interior of the quotes, in RAW source offsets — for precise squiggles. */
  valueSpan: UxmlSpan;
}

export interface UxmlNode {
  /** Stable index chain: `0`, `0.1`, `0.1.2`. Identical source gives identical ids. */
  id: string;
  /** As authored: `ui:VisualElement`, `VisualElement`, `sg:ResizableElement`. */
  rawName: string;
  /** Namespace prefix, or null when unprefixed. */
  ns: string | null;
  /** Prefix stripped: `VisualElement`. */
  localName: string;
  attrs: UxmlAttr[];
  /** The `name` attribute — what `Q<T>("...")` resolves against. */
  name: string | null;
  /** The `class` attribute, whitespace-split, in source order. */
  classes: string[];
  /** Source span of each class token, index-aligned with `classes`. */
  classSpans: UxmlSpan[];
  /** The `text` attribute. UXML carries text as an attribute, never as a child node. */
  text: string | null;
  /** The `style` attribute — a raw USS declaration list. */
  inlineStyle: string | null;
  children: UxmlNode[];
  parentId: string | null;
  /** The whole element, including children and the closing tag. */
  span: UxmlSpan;
  /** Just `<foo ...>`, for tree-to-source jumps. */
  openTagSpan: UxmlSpan;
}

export interface UxmlStyleRef {
  /** Raw attribute text, still entity-encoded — pass to `parseStyleRef`. */
  raw: string;
  /** `src` (a path or project:// uri) or `path` (Resources-relative, no extension). */
  kind: 'src' | 'path';
  /** The element the sheet attaches to. Unity applies it to that subtree, not the document. */
  ownerNodeId: string | null;
  span: UxmlSpan;
}

export interface UxmlTemplateRef {
  name: string;
  raw: string;
  span: UxmlSpan;
}

export interface UxmlInstanceRef {
  nodeId: string;
  templateName: string;
  span: UxmlSpan;
}

export interface UxmlDiagnostic {
  code: 'unclosed-tag' | 'unexpected-close' | 'bad-attr' | 'no-root';
  message: string;
  span: UxmlSpan;
}

export interface UxmlDocument {
  root: UxmlNode | null;
  byId: Map<string, UxmlNode>;
  styleRefs: UxmlStyleRef[];
  templates: UxmlTemplateRef[];
  instances: UxmlInstanceRef[];
  /** Prefix -> namespace. The default xmlns is keyed by the empty string. */
  namespaces: Record<string, string>;
  diagnostics: UxmlDiagnostic[];
  source: string;
}

// ── Entities ─────────────────────────────────────────────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
};

/**
 * Decode XML entities in one pass.
 *
 * One pass matters: decoding `&amp;` before the others would turn the literal
 * text `&amp;lt;` into `<`. Every guid-carrying `<Style src>` in a real project
 * is `&amp;`-escaped, so this runs on the hot path for stylesheet resolution.
 */
export function decodeXmlEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

// ── Style refs ───────────────────────────────────────────────────────────────

export interface ParsedStyleRef {
  kind: 'project' | 'relative';
  /** Workspace-relative path (`Assets/UI/Theme.uss`), percent-decoded. */
  path: string | null;
  /** The 32-hex guid, when the uri carries one. Prefer this — it survives moves. */
  guid: string | null;
  /** Sub-asset name after `#`. */
  fragment: string | null;
}

/**
 * Resolve a `<Style src="...">` value into its parts.
 *
 * The failure this exists to prevent: a real `src` looks like
 * `project://database/Assets/UI/Theme.uss?fileID=743...&amp;guid=dace...&amp;type=3`,
 * and the `&amp;` is universal, not occasional. Handing that to `URLSearchParams`
 * without decoding first finds no `guid` at all, so every stylesheet silently
 * falls back to a path that may since have moved.
 */
export function parseStyleRef(raw: string): ParsedStyleRef {
  const decoded = decodeXmlEntities(raw).trim();

  const hashAt = decoded.indexOf('#');
  const fragment = hashAt === -1 ? null : decoded.slice(hashAt + 1) || null;
  const withoutFragment = hashAt === -1 ? decoded : decoded.slice(0, hashAt);

  const qAt = withoutFragment.indexOf('?');
  const beforeQuery = qAt === -1 ? withoutFragment : withoutFragment.slice(0, qAt);
  const query = qAt === -1 ? '' : withoutFragment.slice(qAt + 1);

  let guid: string | null = null;
  const guidMatch = /(?:^|&)guid=([0-9a-fA-F]{32})/.exec(query);
  if (guidMatch) guid = guidMatch[1].toLowerCase();

  const PREFIX = 'project://database/';
  if (beforeQuery.startsWith(PREFIX)) {
    return { kind: 'project', path: safeDecodeUri(beforeQuery.slice(PREFIX.length)), guid, fragment };
  }
  return { kind: 'relative', path: safeDecodeUri(beforeQuery) || null, guid, fragment };
}

function safeDecodeUri(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    // A stray `%` in a path is not worth failing the whole preview over.
    return text;
  }
}

// ── Positions ────────────────────────────────────────────────────────────────

/** 1-based line and column for a 0-based offset. CRLF counts as one break. */
export function offsetToPosition(source: string, offset: number): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(offset, source.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < clamped; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: clamped - lineStart + 1 };
}

// ── Scanner ──────────────────────────────────────────────────────────────────

const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_.:-]/;

interface ScannedTag {
  rawName: string;
  attrs: UxmlAttr[];
  selfClosing: boolean;
  /** Offset just past the tag's `>`, or the end of source when truncated. */
  end: number;
  truncated: boolean;
}

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

/** Scan one open tag beginning at `start` (which points at `<`). */
function scanOpenTag(src: string, start: number): ScannedTag {
  const n = src.length;
  let i = start + 1;

  let nameEnd = i;
  if (nameEnd < n && NAME_START.test(src[nameEnd])) {
    nameEnd++;
    while (nameEnd < n && NAME_CHAR.test(src[nameEnd])) nameEnd++;
  }
  const rawName = src.slice(i, nameEnd);
  i = nameEnd;

  const attrs: UxmlAttr[] = [];
  let truncated = false;

  for (;;) {
    while (i < n && isSpace(src[i])) i++;
    if (i >= n) { truncated = true; break; }

    if (src[i] === '/' && i + 1 < n && src[i + 1] === '>') {
      return { rawName, attrs, selfClosing: true, end: i + 2, truncated };
    }
    if (src[i] === '>') {
      return { rawName, attrs, selfClosing: false, end: i + 1, truncated };
    }

    // Attribute name
    if (!NAME_START.test(src[i])) {
      // Junk inside a tag. Skip one char rather than spinning; the tag still
      // yields whatever attributes parsed cleanly.
      i++;
      continue;
    }
    const anStart = i;
    i++;
    while (i < n && NAME_CHAR.test(src[i])) i++;
    const nameSpan: UxmlSpan = { start: anStart, end: i };
    const attrName = src.slice(anStart, i);

    while (i < n && isSpace(src[i])) i++;
    if (i >= n) { truncated = true; break; }
    if (src[i] !== '=') {
      // Valueless attribute (`enabled`). Record it with an empty value span.
      attrs.push({ name: attrName, value: '', nameSpan, valueSpan: { start: i, end: i } });
      continue;
    }
    i++; // '='
    while (i < n && isSpace(src[i])) i++;
    if (i >= n) { truncated = true; break; }

    const quote = src[i];
    if (quote === '"' || quote === "'") {
      const vStart = i + 1;
      const close = src.indexOf(quote, vStart);
      if (close === -1) {
        // Unterminated value — the common mid-keystroke shape.
        truncated = true;
        attrs.push({
          name: attrName,
          value: decodeXmlEntities(src.slice(vStart)),
          nameSpan,
          valueSpan: { start: vStart, end: n },
        });
        i = n;
        break;
      }
      attrs.push({
        name: attrName,
        value: decodeXmlEntities(src.slice(vStart, close)),
        nameSpan,
        valueSpan: { start: vStart, end: close },
      });
      i = close + 1;
      continue;
    }

    // Unquoted value — not legal XML, but recoverable.
    const vStart = i;
    while (i < n && !isSpace(src[i]) && src[i] !== '>' && src[i] !== '/') i++;
    attrs.push({
      name: attrName,
      value: decodeXmlEntities(src.slice(vStart, i)),
      nameSpan,
      valueSpan: { start: vStart, end: i },
    });
  }

  return { rawName, attrs, selfClosing: false, end: n, truncated };
}

/** Split `class="a  b"` into tokens with their source spans. */
function splitClasses(src: string, valueSpan: UxmlSpan): { classes: string[]; spans: UxmlSpan[] } {
  const classes: string[] = [];
  const spans: UxmlSpan[] = [];
  let i = valueSpan.start;
  while (i < valueSpan.end) {
    while (i < valueSpan.end && isSpace(src[i])) i++;
    if (i >= valueSpan.end) break;
    const tokenStart = i;
    while (i < valueSpan.end && !isSpace(src[i])) i++;
    classes.push(decodeXmlEntities(src.slice(tokenStart, i)));
    spans.push({ start: tokenStart, end: i });
  }
  return { classes, spans };
}

/** `Style` and `Template` are document metadata, not elements in the visual tree. */
function isMetadataElement(localName: string): boolean {
  return localName === 'Style' || localName === 'Template';
}

/**
 * Parse UXML source. Never throws; a malformed document yields whatever tree
 * could be recovered plus a diagnostic per problem.
 */
export function parseUxml(source: string): UxmlDocument {
  const diagnostics: UxmlDiagnostic[] = [];
  const styleRefs: UxmlStyleRef[] = [];
  const templates: UxmlTemplateRef[] = [];
  const instances: UxmlInstanceRef[] = [];
  const namespaces: Record<string, string> = {};
  const byId = new Map<string, UxmlNode>();

  let root: UxmlNode | null = null;
  const stack: UxmlNode[] = [];
  /** Next child index per open node, so ids are a stable index chain. */
  const childCount: number[] = [];

  const n = source.length;
  let i = 0;

  while (i < n) {
    const lt = source.indexOf('<', i);
    if (lt === -1) break;
    i = lt;

    if (source.startsWith('<?', i)) {
      const e = source.indexOf('?>', i + 2);
      i = e === -1 ? n : e + 2;
      continue;
    }
    if (source.startsWith('<!--', i)) {
      const e = source.indexOf('-->', i + 4);
      i = e === -1 ? n : e + 3;
      continue;
    }
    if (source.startsWith('<!', i)) {
      const e = source.indexOf('>', i + 2);
      i = e === -1 ? n : e + 1;
      continue;
    }

    // Closing tag
    if (source.startsWith('</', i)) {
      const gt = source.indexOf('>', i + 2);
      const end = gt === -1 ? n : gt + 1;
      const rawName = source.slice(i + 2, gt === -1 ? n : gt).trim();
      // Innermost matching open tag. A manual reverse scan rather than
      // `findLastIndex`, which needs lib es2023 and this project targets lower.
      let depth = -1;
      for (let d = stack.length - 1; d >= 0; d--) {
        if (stack[d].rawName === rawName) { depth = d; break; }
      }
      if (depth === -1) {
        diagnostics.push({
          code: 'unexpected-close',
          message: `Closing tag </${rawName}> has no matching open tag.`,
          span: { start: i, end },
        });
      } else {
        // Close everything above the match too — those were left open.
        for (let d = stack.length - 1; d > depth; d--) {
          const orphan = stack[d];
          diagnostics.push({
            code: 'unclosed-tag',
            message: `<${orphan.rawName}> is never closed.`,
            span: orphan.openTagSpan,
          });
          orphan.span = { start: orphan.span.start, end: i };
        }
        const closing = stack[depth];
        closing.span = { start: closing.span.start, end };
        stack.length = depth;
        childCount.length = depth;
      }
      i = end;
      continue;
    }

    // Open tag
    const tag = scanOpenTag(source, i);
    if (tag.rawName === '') {
      // A bare `<` that starts nothing. Step past it.
      i = i + 1;
      continue;
    }
    if (tag.truncated) {
      diagnostics.push({
        code: 'bad-attr',
        message: `<${tag.rawName}> is incomplete.`,
        span: { start: i, end: tag.end },
      });
    }

    const colon = tag.rawName.indexOf(':');
    const ns = colon === -1 ? null : tag.rawName.slice(0, colon);
    const localName = colon === -1 ? tag.rawName : tag.rawName.slice(colon + 1);

    for (const attr of tag.attrs) {
      if (attr.name === 'xmlns') namespaces[''] = attr.value;
      else if (attr.name.startsWith('xmlns:')) namespaces[attr.name.slice(6)] = attr.value;
    }

    const parent = stack[stack.length - 1] ?? null;
    const openTagSpan: UxmlSpan = { start: i, end: tag.end };

    if (isMetadataElement(localName)) {
      if (localName === 'Style') {
        const src = tag.attrs.find((a) => a.name === 'src');
        const path = tag.attrs.find((a) => a.name === 'path');
        const chosen = src ?? path;
        if (chosen) {
          styleRefs.push({
            raw: source.slice(chosen.valueSpan.start, chosen.valueSpan.end),
            kind: src ? 'src' : 'path',
            ownerNodeId: parent ? parent.id : null,
            span: chosen.valueSpan,
          });
        }
      } else {
        const nameAttr = tag.attrs.find((a) => a.name === 'name');
        const srcAttr = tag.attrs.find((a) => a.name === 'src');
        if (nameAttr) {
          templates.push({
            name: nameAttr.value,
            raw: srcAttr ? source.slice(srcAttr.valueSpan.start, srcAttr.valueSpan.end) : '',
            span: openTagSpan,
          });
        }
      }
      // Metadata elements are self-closing in practice; if one is not, skipping
      // it here would unbalance the stack, so consume its close explicitly.
      if (!tag.selfClosing) {
        const closeTag = `</${tag.rawName}>`;
        const closeAt = source.indexOf(closeTag, tag.end);
        i = closeAt === -1 ? tag.end : closeAt + closeTag.length;
      } else {
        i = tag.end;
      }
      continue;
    }

    const index = parent ? childCount[stack.length - 1]++ : 0;
    const id = parent ? `${parent.id}.${index}` : '0';

    const nameAttr = tag.attrs.find((a) => a.name === 'name');
    const classAttr = tag.attrs.find((a) => a.name === 'class');
    const textAttr = tag.attrs.find((a) => a.name === 'text');
    const styleAttr = tag.attrs.find((a) => a.name === 'style');
    const { classes, spans } = classAttr
      ? splitClasses(source, classAttr.valueSpan)
      : { classes: [], spans: [] };

    const node: UxmlNode = {
      id,
      rawName: tag.rawName,
      ns,
      localName,
      attrs: tag.attrs,
      name: nameAttr ? nameAttr.value : null,
      classes,
      classSpans: spans,
      text: textAttr ? textAttr.value : null,
      inlineStyle: styleAttr ? styleAttr.value : null,
      children: [],
      parentId: parent ? parent.id : null,
      span: { start: i, end: tag.end },
      openTagSpan,
    };

    byId.set(id, node);
    if (parent) parent.children.push(node);
    else if (root === null) root = node;

    if (localName === 'Instance') {
      const templateAttr = tag.attrs.find((a) => a.name === 'template');
      instances.push({
        nodeId: id,
        templateName: templateAttr ? templateAttr.value : '',
        span: openTagSpan,
      });
    }

    if (!tag.selfClosing) {
      stack.push(node);
      childCount.push(0);
    }
    i = tag.end;
  }

  // Anything still open at EOF was never closed.
  for (let d = stack.length - 1; d >= 0; d--) {
    const orphan = stack[d];
    diagnostics.push({
      code: 'unclosed-tag',
      message: `<${orphan.rawName}> is never closed.`,
      span: orphan.openTagSpan,
    });
    orphan.span = { start: orphan.span.start, end: n };
  }

  if (root === null && source.trim() !== '') {
    diagnostics.push({
      code: 'no-root',
      message: 'No UXML element found in this file.',
      span: { start: 0, end: Math.min(n, 40) },
    });
  }

  return { root, byId, styleRefs, templates, instances, namespaces, diagnostics, source };
}
