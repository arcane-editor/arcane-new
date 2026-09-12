import { describe, it, expect } from 'bun:test';
import { cascadeFor, targetFor, selectorMatches, propertyEntries, parseInlineStyle } from './cascade';
import { buildRenderPlanFromText } from './render-plan';
import { parseUxml } from '../../../utils/uxml-model';
import { parseUss, compileSelector } from '../../../utils/uss-model';

const UXML = `<ui:UXML xmlns:ui="UnityEngine.UIElements">
  <ui:VisualElement name="root" class="screen">
    <ui:VisualElement name="menu-card" class="card">
      <ui:Button name="play-button" class="btn btn--primary" />
      <ui:Label name="wordmark" class="wordmark" />
    </ui:VisualElement>
  </ui:VisualElement>
</ui:UXML>`;

const USS = `
.btn { font-size: 18px; color: rgb(226,224,218); }
.btn--primary { background-color: rgb(212,176,98); font-size: 22px; }
Button { font-size: 12px; }
#play-button { border-width: 2px; }
.card > Button { margin: 4px; }
.screen Button { padding: 3px; }
.btn:hover { color: rgb(255,255,255); }
.card { width: 420px; box-shadow: 0 2px 8px rgba(0,0,0,.4); }
.nope Button { opacity: 0.5; }
`;

const plan = buildRenderPlanFromText(parseUxml(UXML), [{ path: 'Theme.uss', content: USS }]);
const sheets = [parseUss(USS, 'Theme.uss')];

function idOf(name: string): string {
  let found = '';
  (function walk(n: any) {
    if (!n) return;
    if (n.name === name) found = n.id;
    n.children.forEach(walk);
  })(plan.root);
  return found;
}

const play = targetFor(plan.root, idOf('play-button'))!;
const rules = cascadeFor(play, sheets);
const sel = (s: string) => rules.find((r) => r.selector === s);

describe('targetFor', () => {
  it('carries the ancestor chain, nearest first', () => {
    expect(play.tag).toBe('Button');
    // The <ui:UXML> document element is an ancestor too, and carries no name.
    expect(play.ancestors.map((a) => a.name)).toEqual(['menu-card', 'root', null]);
  });

  it('drops the renderer’s synthetic classes but keeps Unity’s generated ones', () => {
    // `u-t-*` and `u-el` are how the renderer makes type selectors work — no
    // USS ever targets them. `unity-button` is different: Unity's own Button
    // adds it and stylesheets really do target `.unity-button`, so dropping it
    // would under-report the cascade.
    expect(play.classes).toEqual(['unity-button', 'unity-text-element', 'btn', 'btn--primary']);
  });
});

describe('selectorMatches', () => {
  const m = (s: string) => selectorMatches(compileSelector(s, 0), play);

  it('matches class, id and universal', () => {
    expect(m('.btn')).toBe(true);
    expect(m('#play-button')).toBe(true);
    expect(m('*')).toBe(true);
  });

  it('matches a type through the inheritance chain', () => {
    // The reason `VisualElement { }` styles everything in UI Toolkit.
    expect(m('Button')).toBe(true);
    expect(m('TextElement')).toBe(true);
    expect(m('VisualElement')).toBe(true);
    expect(m('Label')).toBe(false);
  });

  it('honours the child combinator', () => {
    expect(m('.card > Button')).toBe(true);
    expect(m('.screen > Button')).toBe(false); // .screen is a grandparent
  });

  it('honours descendant', () => {
    expect(m('.screen Button')).toBe(true);
    expect(m('.nope Button')).toBe(false);
  });

  it('rejects a class the element does not carry', () => {
    expect(m('.btn--ghost')).toBe(false);
  });
});

describe('cascadeFor', () => {
  it('lists every matching rule and no others', () => {
    const found = rules.map((r) => r.selector).sort();
    expect(found).toEqual([
      '#play-button', '.btn', '.btn--primary', '.btn:hover',
      '.card > Button', '.screen Button', 'Button',
    ].sort());
  });

  it('orders most specific first', () => {
    expect(rules[0].selector).toBe('#play-button');
    expect(rules[rules.length - 1].selector).toBe('Button');
  });

  it('resolves the winner when two rules set the same property', () => {
    // `.btn--primary` and `.btn` are both (0,1,0); the later one wins, and
    // `Button` (0,0,1) loses to both.
    const primary = sel('.btn--primary')!.declarations.find((d) => d.property === 'font-size')!;
    const base = sel('.btn')!.declarations.find((d) => d.property === 'font-size')!;
    const type = sel('Button')!.declarations.find((d) => d.property === 'font-size')!;
    expect(primary.winning).toBe(true);
    expect(base.winning).toBe(false);
    expect(type.winning).toBe(false);
  });

  it('leaves an uncontested property winning', () => {
    expect(sel('.btn')!.declarations.find((d) => d.property === 'color')!.winning).toBe(true);
  });

  it('lists a :hover rule but never lets it win', () => {
    // It is not in effect right now, so striking out the base colour with it
    // would misreport what the element currently looks like.
    const hover = sel('.btn:hover')!;
    expect(hover.conditional).toBe(true);
    expect(hover.declarations.every((d) => !d.winning)).toBe(true);
  });

  it('reports a property Unity drops, and never counts it as a winner', () => {
    const card = targetFor(plan.root, idOf('menu-card'))!;
    const shadow = cascadeFor(card, sheets)
      .flatMap((r) => r.declarations)
      .find((d) => d.property === 'box-shadow')!;
    expect(shadow.dropped).toContain('box-shadow');
    expect(shadow.winning).toBe(false);
  });

  it('points at the stylesheet and line for each rule', () => {
    const btn = sel('.btn')!;
    expect(btn.sheet).toBe('Theme.uss');
    expect(USS.split('\n')[btn.line - 1]).toContain('.btn {');
  });

  it('returns nothing for an element no rule matches', () => {
    const root = targetFor(plan.root, idOf('root'))!;
    const only = cascadeFor(root, [parseUss('.nothing { color: red; }', 'x.uss')]);
    expect(only).toEqual([]);
  });
});

describe('parseInlineStyle', () => {
  it('splits declarations and trims both halves', () => {
    expect(parseInlineStyle('flex-grow: 1; color: rgb(1,2,3)')).toEqual([
      { property: 'flex-grow', value: '1' },
      { property: 'color', value: 'rgb(1,2,3)' },
    ]);
  });

  it('does not split on a semicolon inside a quoted url', () => {
    // The CSV-comma bug: `;` is only a separator at depth zero, outside quotes.
    expect(parseInlineStyle('background-image: url("a;b.png"); color: red')).toEqual([
      { property: 'background-image', value: 'url("a;b.png")' },
      { property: 'color', value: 'red' },
    ]);
  });

  it('ignores empty and malformed chunks', () => {
    expect(parseInlineStyle(';; color: red ;;')).toEqual([{ property: 'color', value: 'red' }]);
    expect(parseInlineStyle('color')).toEqual([]);
    expect(parseInlineStyle(null)).toEqual([]);
  });
});

describe('propertyEntries', () => {
  const entries = propertyEntries(null, rules);
  const entry = (name: string) => entries.find((e) => e.property === name)!;

  it('gives one entry per property, no duplicates', () => {
    expect(new Set(entries.map((e) => e.property)).size).toBe(entries.length);
  });

  it('orders by group, then alphabetically inside it', () => {
    // Layout before Appearance before Text, so the properties that decide
    // where a thing sits are not sorted twelve rows away from each other.
    expect(entries.map((e) => e.group)).toEqual([...entries.map((e) => e.group)].sort(
      (a, b) => ['Layout', 'Appearance', 'Text', 'Motion'].indexOf(a)
        - ['Layout', 'Appearance', 'Text', 'Motion'].indexOf(b),
    ));
    expect(entry('margin').group).toBe('Layout');
    expect(entry('background-color').group).toBe('Appearance');
    expect(entry('font-size').group).toBe('Text');
  });

  it('resolves the value and names where it came from', () => {
    const size = entry('font-size');
    expect(size.value).toBe('22px');
    expect(size.origin.selector).toBe('.btn--primary');
    expect(size.origin.sheet).toBe('Theme.uss');
  });

  it('keeps every losing source on the same entry, strongest first', () => {
    // The whole point of folding the two lists together: `.btn` and `Button`
    // both set font-size and both hang off the one row that shows 22px.
    const size = entry('font-size');
    expect(size.sources.map((s) => [s.selector, s.state])).toEqual([
      ['.btn--primary', 'winner'],
      ['.btn', 'overridden'],
      ['Button', 'overridden'],
    ]);
  });

  it('marks a :hover source as state-only rather than overridden', () => {
    // It did not lose the cascade; it is simply not in effect right now, and
    // conflating the two would misreport why the colour is what it is.
    const states = entry('color').sources.map((s) => s.state);
    expect(states).toContain('winner');
    expect(states).toContain('state');
    expect(states).not.toContain('overridden');
  });

  it('lets an inline style beat every selector, id included', () => {
    const inline = propertyEntries('font-size: 40px; border-width: 9px', rules);
    const size = inline.find((e) => e.property === 'font-size')!;
    expect(size.value).toBe('40px');
    expect(size.origin.selector).toBe('style=""');
    expect(size.origin.sheet).toBe(null);
    // `#play-button` is (1,0,0) and still loses — inline is above the cascade.
    expect(inline.find((e) => e.property === 'border-width')!.origin.selector).toBe('style=""');
  });

  it('reports a dropped property with no value rather than hiding it', () => {
    // "Unity ignored the box-shadow you wrote" is the single most useful thing
    // this panel can say about that element, so it must not be filtered out.
    const card = targetFor(plan.root, idOf('menu-card'))!;
    const shadow = propertyEntries(null, cascadeFor(card, sheets))
      .find((e) => e.property === 'box-shadow')!;
    expect(shadow.value).toBe(null);
    expect(shadow.origin.state).toBe('dropped');
    expect(shadow.origin.note).toContain('box-shadow');
  });
});
