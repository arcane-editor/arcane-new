import { describe, it, expect } from 'bun:test';
import { parseUxml, parseStyleRef, offsetToPosition, type UxmlNode } from './uxml-model';

/** Depth-first walk, for assertions that do not care about the tree shape. */
function flatten(node: UxmlNode | null): UxmlNode[] {
  if (!node) return [];
  return [node, ...node.children.flatMap(flatten)];
}

function named(src: string, name: string): UxmlNode | undefined {
  return flatten(parseUxml(src).root).find((n) => n.name === name);
}

const PREFIXED = `<ui:UXML xmlns:ui="UnityEngine.UIElements">
  <Style src="project://database/Assets/UI/Theme.uss?fileID=7433441132597879392&amp;guid=dace8eeb2c0d4c8f9f0a1b2c3d4e5f60&amp;type=3#Theme" />
  <ui:VisualElement name="root" class="screen dark">
    <ui:Label name="wordmark" text="EMBERFALL" class="wordmark" />
    <ui:VisualElement name="menu-card" class="card">
      <ui:Button name="play-button" text="Continue" class="btn btn--primary" />
      <ui:Button name="quit-btn" text="Quit" class="btn btn--ghost" />
    </ui:VisualElement>
  </ui:VisualElement>
</ui:UXML>`;

// The other namespace style that appears in real files: a default xmlns with
// unprefixed children. A parser that only strips a `ui:` prefix reads every
// element here as an unknown custom control.
const DEFAULT_NS = `<UXML xmlns="UnityEngine.UIElements">
  <VisualElement name="root">
    <Button name="go" text="Go" />
  </VisualElement>
</UXML>`;

describe('parseUxml — structure', () => {
  it('reads the tree, names and classes', () => {
    const doc = parseUxml(PREFIXED);
    const nodes = flatten(doc.root);
    // The <ui:UXML> document element is itself a node, and carries no name.
    expect(nodes.map((n) => n.name)).toEqual([
      null, 'root', 'wordmark', 'menu-card', 'play-button', 'quit-btn',
    ]);
    expect(named(PREFIXED, 'play-button')!.classes).toEqual(['btn', 'btn--primary']);
    expect(named(PREFIXED, 'root')!.classes).toEqual(['screen', 'dark']);
  });

  it('splits the namespace prefix off the local name', () => {
    const btn = named(PREFIXED, 'play-button')!;
    expect(btn.rawName).toBe('ui:Button');
    expect(btn.ns).toBe('ui');
    expect(btn.localName).toBe('Button');
  });

  it('handles a default xmlns with unprefixed children', () => {
    const btn = named(DEFAULT_NS, 'go')!;
    expect(btn.ns).toBe(null);
    expect(btn.localName).toBe('Button');
    expect(parseUxml(DEFAULT_NS).namespaces['']).toBe('UnityEngine.UIElements');
  });

  it('gives every node a stable index-chain id and a parent link', () => {
    const doc = parseUxml(PREFIXED);
    const card = flatten(doc.root).find((n) => n.name === 'menu-card')!;
    const play = flatten(doc.root).find((n) => n.name === 'play-button')!;
    expect(play.parentId).toBe(card.id);
    expect(doc.byId.get(play.id)).toBe(play);
    // Re-parsing identical source must produce identical ids, or selection
    // cannot survive a keystroke.
    expect(flatten(parseUxml(PREFIXED).root).map((n) => n.id))
      .toEqual(flatten(doc.root).map((n) => n.id));
  });

  it('reads text and inline style attributes', () => {
    const src = `<ui:UXML><ui:Label name="a" text="Hi" style="color: red; width: 40px;" /></ui:UXML>`;
    const a = named(src, 'a')!;
    expect(a.text).toBe('Hi');
    expect(a.inlineStyle).toBe('color: red; width: 40px;');
  });

  it('skips comments and the xml declaration', () => {
    const src = `<?xml version="1.0" encoding="utf-8"?>
<ui:UXML><!-- a note --><ui:Label name="a" /></ui:UXML>`;
    expect(flatten(parseUxml(src).root).map((n) => n.name)).toEqual([null, 'a']);
  });
});

describe('parseUxml — offsets', () => {
  it('spans the name attribute VALUE, inside the quotes', () => {
    const play = named(PREFIXED, 'play-button')!;
    const attr = play.attrs.find((a) => a.name === 'name')!;
    expect(PREFIXED.slice(attr.valueSpan.start, attr.valueSpan.end)).toBe('play-button');
    expect(PREFIXED.slice(attr.nameSpan.start, attr.nameSpan.end)).toBe('name');
  });

  it('spans each class token separately, so a squiggle lands on one class', () => {
    const quit = named(PREFIXED, 'quit-btn')!;
    // `btn--ghost` is the undeclared one; the diagnostic must underline only it.
    expect(quit.classSpans).toHaveLength(2);
    expect(PREFIXED.slice(quit.classSpans[1].start, quit.classSpans[1].end)).toBe('btn--ghost');
    expect(PREFIXED.slice(quit.classSpans[0].start, quit.classSpans[0].end)).toBe('btn');
  });

  it('spans the open tag separately from the whole element', () => {
    const doc = parseUxml(PREFIXED);
    const card = flatten(doc.root).find((n) => n.name === 'menu-card')!;
    expect(PREFIXED.slice(card.openTagSpan.start, card.openTagSpan.end)).toStartWith('<ui:VisualElement');
    expect(PREFIXED.slice(card.openTagSpan.start, card.openTagSpan.end)).toEndWith('>');
    expect(PREFIXED.slice(card.span.start, card.span.end)).toEndWith('</ui:VisualElement>');
  });

  it('converts an offset to a 1-based line and column', () => {
    expect(offsetToPosition('abc\ndef', 0)).toEqual({ line: 1, column: 1 });
    expect(offsetToPosition('abc\ndef', 4)).toEqual({ line: 2, column: 1 });
    expect(offsetToPosition('abc\ndef', 6)).toEqual({ line: 2, column: 3 });
  });

  it('handles CRLF without drifting the column', () => {
    expect(offsetToPosition('abc\r\ndef', 5)).toEqual({ line: 2, column: 1 });
  });
});

describe('parseUxml — stylesheets and templates', () => {
  it('records <Style> with the element it attaches to', () => {
    const doc = parseUxml(PREFIXED);
    expect(doc.styleRefs).toHaveLength(1);
    expect(doc.styleRefs[0].ownerNodeId).toBe(doc.root!.id);
  });

  it('records a NESTED <Style> against its own owner, not the root', () => {
    // 3 of 13 <Style> elements in Unity's own corpus are nested. Scoping every
    // sheet to the root applies styles Unity would not apply.
    const src = `<ui:UXML>
  <ui:VisualElement name="root">
    <ui:Foldout name="fold">
      <Style src="Nested.uss" />
    </ui:Foldout>
  </ui:VisualElement>
</ui:UXML>`;
    const doc = parseUxml(src);
    const fold = flatten(doc.root).find((n) => n.name === 'fold')!;
    expect(doc.styleRefs[0].ownerNodeId).toBe(fold.id);
  });

  it('records templates and instances', () => {
    const src = `<ui:UXML>
  <ui:Template name="Row" src="Row.uxml" />
  <ui:VisualElement name="root">
    <ui:Instance template="Row" name="r1" />
  </ui:VisualElement>
</ui:UXML>`;
    const doc = parseUxml(src);
    expect(doc.templates.map((t) => t.name)).toEqual(['Row']);
    expect(doc.instances.map((i) => i.templateName)).toEqual(['Row']);
  });
});

describe('parseStyleRef', () => {
  it('decodes &amp; before parsing the query — every guid-carrying src is escaped', () => {
    // This is the failure that makes guid resolution silently never fire: the
    // raw attribute contains `&amp;guid=`, so a naive URLSearchParams finds
    // nothing and every stylesheet falls back to a path that may have moved.
    const raw = 'project://database/Assets/UI/Theme.uss?fileID=7433441132597879392&amp;guid=dace8eeb2c0d4c8f9f0a1b2c3d4e5f60&amp;type=3#Theme';
    const ref = parseStyleRef(raw);
    expect(ref.guid).toBe('dace8eeb2c0d4c8f9f0a1b2c3d4e5f60');
    expect(ref.path).toBe('Assets/UI/Theme.uss');
    expect(ref.fragment).toBe('Theme');
  });

  it('decodes percent-escapes in the path', () => {
    const ref = parseStyleRef('project://database/Assets/Core%20RP%20Library/Styles.uss');
    expect(ref.path).toBe('Assets/Core RP Library/Styles.uss');
    expect(ref.guid).toBe(null);
  });

  it('reads a bare project:// uri with no query', () => {
    const ref = parseStyleRef('project://database/Packages/com.unity.render-pipelines.core/Editor/HelpButton.uss');
    expect(ref.path).toBe('Packages/com.unity.render-pipelines.core/Editor/HelpButton.uss');
  });

  it('reads a plain relative src', () => {
    const ref = parseStyleRef('Theme.uss');
    expect(ref.kind).toBe('relative');
    expect(ref.path).toBe('Theme.uss');
  });

  it('surfaces the guid from a real <Style> element end to end', () => {
    const doc = parseUxml(PREFIXED);
    expect(parseStyleRef(doc.styleRefs[0].raw).guid)
      .toBe('dace8eeb2c0d4c8f9f0a1b2c3d4e5f60');
  });
});

describe('parseUxml — recovery', () => {
  // The parser reads the LIVE Monaco buffer, so it sees malformed XML on nearly
  // every keystroke. Throwing would flash the fallback view constantly; the
  // contract is a usable tree plus diagnostics, always.
  it('never throws on a tag truncated mid-attribute', () => {
    const doc = parseUxml('<ui:UXML><ui:Button name="pl');
    expect(doc.diagnostics.length).toBeGreaterThan(0);
    expect(() => flatten(doc.root)).not.toThrow();
  });

  it('auto-closes an unclosed tag and says so', () => {
    const doc = parseUxml('<ui:UXML><ui:VisualElement name="root">');
    expect(named('<ui:UXML><ui:VisualElement name="root">', 'root')).toBeTruthy();
    expect(doc.diagnostics.map((d) => d.code)).toContain('unclosed-tag');
  });

  it('skips a stray closing tag rather than unwinding the tree', () => {
    const src = '<ui:UXML><ui:Label name="a" /></ui:Nope><ui:Label name="b" /></ui:UXML>';
    const doc = parseUxml(src);
    expect(flatten(doc.root).map((n) => n.name)).toEqual([null, 'a', 'b']);
    expect(doc.diagnostics.map((d) => d.code)).toContain('unexpected-close');
  });

  it('returns an empty document for empty input without throwing', () => {
    const doc = parseUxml('');
    expect(doc.root).toBe(null);
    expect(doc.styleRefs).toEqual([]);
  });

  it('decodes the five named entities in attribute values', () => {
    const src = `<ui:UXML><ui:Label name="a" text="&lt;b&gt; &amp; &quot;x&quot; &apos;y&apos;" /></ui:UXML>`;
    expect(named(src, 'a')!.text).toBe(`<b> & "x" 'y'`);
  });

  it('decodes numeric entities', () => {
    const src = `<ui:UXML><ui:Label name="a" text="&#65;&#x42;" /></ui:UXML>`;
    expect(named(src, 'a')!.text).toBe('AB');
  });

  it('accepts single-quoted attribute values', () => {
    const src = `<ui:UXML><ui:Label name='a' class='x y' /></ui:UXML>`;
    expect(named(src, 'a')!.classes).toEqual(['x', 'y']);
  });
});
