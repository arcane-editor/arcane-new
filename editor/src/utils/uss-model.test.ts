import { describe, it, expect } from 'bun:test';
import { parseUss, compileSelector, translateDeclaration } from './uss-model';

const SHEET = `/* header comment { not a rule } */
.card {
  width: 420px;
  background-color: rgba(12, 10, 18, 0.62);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
}

.btn, .btn--primary {
  font-size: 18px;
  -unity-text-align: middle-center;
}

Button:hover { color: rgb(255, 0, 0); }

:root { --accent: rgb(212, 176, 98); }
`;

describe('parseUss', () => {
  it('reads rules, selectors and declarations', () => {
    const sheet = parseUss(SHEET, 'Theme.uss');
    // .card | .btn,.btn--primary | Button:hover | :root
    expect(sheet.rules).toHaveLength(4);
    expect(sheet.rules[0].selectors.map((s) => s.source)).toEqual(['.card']);
    expect(sheet.rules[1].selectors.map((s) => s.source)).toEqual(['.btn', '.btn--primary']);
    expect(sheet.rules[0].declarations.map((d) => d.property))
      .toEqual(['width', 'background-color', 'box-shadow']);
  });

  it('keeps values intact, commas and all', () => {
    const sheet = parseUss(SHEET, 'Theme.uss');
    expect(sheet.rules[0].declarations[1].value).toBe('rgba(12, 10, 18, 0.62)');
  });

  it('gives every declaration a property span that lands on the property token', () => {
    const sheet = parseUss(SHEET, 'Theme.uss');
    const boxShadow = sheet.rules[0].declarations[2];
    expect(SHEET.slice(boxShadow.propertySpan.start, boxShadow.propertySpan.end)).toBe('box-shadow');
  });

  it('gives every selector a span that lands on the selector text', () => {
    const sheet = parseUss(SHEET, 'Theme.uss');
    const sel = sheet.rules[0].selectors[0];
    expect(SHEET.slice(sel.span.start, sel.span.end)).toBe('.card');
  });

  it('ignores braces inside comments', () => {
    // The header comment contains `{ not a rule }`. A parser that strips
    // comments by deleting text would also shift every offset after it.
    expect(parseUss(SHEET, 'x.uss').rules[0].selectors[0].source).toBe('.card');
  });

  it('captures @import, the only at-rule in the real corpus', () => {
    const sheet = parseUss('@import url("unity-theme://default");\n.a { color: red; }', 'x.uss');
    expect(sheet.imports.map((im) => im.url)).toEqual(['unity-theme://default']);
    expect(sheet.rules).toHaveLength(1);
  });

  it('keeps custom properties as declarations', () => {
    const sheet = parseUss(SHEET, 'x.uss');
    const root = sheet.rules[3];
    expect(root.declarations[0].property).toBe('--accent');
  });

  it('never throws on a half-typed rule', () => {
    expect(() => parseUss('.a { color:', 'x.uss')).not.toThrow();
    expect(() => parseUss('.a {', 'x.uss')).not.toThrow();
    expect(() => parseUss('}}{{', 'x.uss')).not.toThrow();
  });
});

describe('compileSelector', () => {
  const css = (s: string) => compileSelector(s, 0).css;

  it('rewrites a type selector to a materialised type class', () => {
    // USS type selectors match the C# INHERITANCE CHAIN, so `VisualElement {}`
    // matches every element in the document. The renderer puts the whole chain
    // on each node as `u-t-*` classes, which lets the browser reproduce Unity's
    // semantics with no matcher code at all.
    expect(css('Button')).toBe('.u-t-Button');
    expect(css('VisualElement')).toBe('.u-t-VisualElement');
  });

  it('rewrites :root to :host — :root matches NOTHING inside a shadow root', () => {
    // Every custom-property definition in the corpus lives in a `:root` block.
    // Without this they silently never apply, and because custom properties
    // inherit THROUGH the shadow boundary, `var(--border)` would then resolve
    // to the IDE's own token and render something plausible and wrong.
    expect(css(':root')).toBe(':host');
  });

  it('rewrites Unity state pseudo-classes that have no DOM equivalent', () => {
    expect(css(':checked')).toBe('.u-s-checked');
    expect(css(':selected')).toBe('.u-s-selected');
    expect(css(':disabled')).toBe('.u-s-disabled');
    expect(css(':inactive')).toBe('.u-s-inactive');
  });

  it('passes through the pseudo-classes the browser already implements', () => {
    expect(css(':hover')).toBe(':hover');
    expect(css(':active')).toBe(':active');
    expect(css(':focus')).toBe(':focus');
  });

  it('leaves classes, names and the universal selector alone', () => {
    expect(css('.btn')).toBe('.btn');
    expect(css('#play-button')).toBe('#play-button');
    expect(css('*')).toBe('*');
  });

  it('handles descendant and child combinators', () => {
    expect(css('.card Button')).toBe('.card .u-t-Button');
    expect(css('.card > Button')).toBe('.card > .u-t-Button');
  });

  it('handles a real compound selector from Unity own USS', () => {
    expect(css('.custom-foldout-arrow > Toggle > VisualElement:checked #unity-checkmark'))
      .toBe('.custom-foldout-arrow > .u-t-Toggle > .u-t-VisualElement.u-s-checked #unity-checkmark');
  });

  it('computes CSS-style specificity', () => {
    expect(compileSelector('#a', 0).specificity).toEqual([1, 0, 0]);
    expect(compileSelector('.a.b', 0).specificity).toEqual([0, 2, 0]);
    // A type selector becomes a class in the output but keeps TYPE specificity,
    // so Unity's cascade order is preserved rather than the rewrite's.
    expect(compileSelector('Button', 0).specificity).toEqual([0, 0, 1]);
    expect(compileSelector('Button:hover', 0).specificity).toEqual([0, 1, 1]);
  });

  it('exposes structural parts for a DOM-free matcher', () => {
    const sel = compileSelector('.card > Button:hover', 0);
    expect(sel.parts).toHaveLength(2);
    expect(sel.parts[0].simples).toEqual([{ kind: 'class', name: 'card' }]);
    expect(sel.parts[1].simples).toEqual([
      { kind: 'type', name: 'Button' },
      { kind: 'pseudo', name: 'hover' },
    ]);
    expect(sel.combinators).toEqual(['child']);
  });
});

describe('translateDeclaration', () => {
  const t = (property: string, value: string) =>
    translateDeclaration({ property, value, important: false, span: { start: 0, end: 0 }, propertySpan: { start: 0, end: 0 } });

  it('passes through the 67 properties that are byte-identical CSS', () => {
    expect(t('width', '420px').css).toEqual(['width: 420px']);
    expect(t('background-color', 'rgba(1, 2, 3, 0.5)').css).toEqual(['background-color: rgba(1, 2, 3, 0.5)']);
  });

  it('passes custom properties and var() straight through', () => {
    expect(t('--accent', 'rgb(1,2,3)').css).toEqual(['--accent: rgb(1,2,3)']);
    expect(t('color', 'var(--accent)').css).toEqual(['color: var(--accent)']);
  });

  it('splits -unity-text-align across both axes', () => {
    // The most-used -unity-* property in the corpus (200 uses). It encodes
    // vertical AND horizontal, and the vertical half only works because every
    // element is already display:flex.
    expect(t('-unity-text-align', 'middle-center').css).toEqual([
      'text-align: center',
      'align-items: center',
    ]);
    expect(t('-unity-text-align', 'upper-left').css).toEqual([
      'text-align: left',
      'align-items: flex-start',
    ]);
    expect(t('-unity-text-align', 'lower-right').css).toEqual([
      'text-align: right',
      'align-items: flex-end',
    ]);
  });

  it('accepts the capitalised values Unity actually writes', () => {
    expect(t('-unity-text-align', 'MiddleCenter').css).toEqual([
      'text-align: center',
      'align-items: center',
    ]);
  });

  it('maps -unity-font-style onto weight and style', () => {
    expect(t('-unity-font-style', 'bold').css).toEqual(['font-weight: 700', 'font-style: normal']);
    expect(t('-unity-font-style', 'italic').css).toEqual(['font-weight: 400', 'font-style: italic']);
    expect(t('-unity-font-style', 'bold-and-italic').css).toEqual(['font-weight: 700', 'font-style: italic']);
    expect(t('-unity-font-style', 'normal').css).toEqual(['font-weight: 400', 'font-style: normal']);
  });

  it('maps -unity-background-scale-mode onto object-fit semantics', () => {
    expect(t('-unity-background-scale-mode', 'scale-to-fit').css).toEqual(['background-size: contain']);
    expect(t('-unity-background-scale-mode', 'scale-and-crop').css).toEqual(['background-size: cover']);
    expect(t('-unity-background-scale-mode', 'stretch-to-fill').css).toEqual(['background-size: 100% 100%']);
  });

  it('drops a CSS-only property and says what to use instead', () => {
    const r = t('box-shadow', '0 2px 8px rgba(0,0,0,.4)');
    expect(r.css).toEqual([]);
    expect(r.unsupported).toContain('9-slice');
  });

  it('drops a -unity- property with no CSS equivalent, and explains', () => {
    const r = t('-unity-background-image-tint-color', 'rgb(1,2,3)');
    expect(r.css).toEqual([]);
    expect(r.unsupported).toBeTruthy();
  });

  it('drops a cursor value CSS does not have rather than emitting invalid CSS', () => {
    // An unmapped keyword makes the WHOLE declaration invalid in CSS, so the
    // browser would discard it anyway — dropping it deliberately means we can
    // report it instead of silently losing it.
    expect(t('cursor', 'slide-arrow').css).toEqual([]);
    expect(t('cursor', 'resize-vertical').css).toEqual(['cursor: ns-resize']);
    expect(t('cursor', 'pointer').css).toEqual(['cursor: pointer']);
  });

  it('drops white-space: wrap, which is invalid in USS and CSS alike', () => {
    // One real occurrence in Unity's own stylesheets. Reporting it is the
    // differentiating behaviour — Unity itself says nothing.
    const r = t('white-space', 'wrap');
    expect(r.css).toEqual([]);
    expect(r.unsupported).toBeTruthy();
  });

  it('keeps translate/rotate/scale, which are native CSS now', () => {
    expect(t('translate', '10px 20px').css).toEqual(['translate: 10px 20px']);
    expect(t('rotate', '45deg').css).toEqual(['rotate: 45deg']);
  });
});
