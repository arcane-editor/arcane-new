import { describe, it, expect } from 'bun:test';
import { findElementUsages, describeUsage, type ElementUsage } from './uxml-usage';

const NAMES = ['play-button', 'quit-btn', 'volume-slider', 'menu-card', 'run-list'];

/** Stand-in for `CSharpScan.code`: comments blanked, offsets preserved. */
function blank(text: string): string {
  return text.replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

const find = (src: string) => findElementUsages('/p/Menu.cs', blank(src), src, NAMES);
const of = (us: ElementUsage[], name: string) => us.filter((u) => u.elementName === name);

describe('behaviour attached inline to the query', () => {
  // The common form: never touches a local, so binding locals alone misses it.
  it('finds a click handler chained onto the query', () => {
    const u = find('root.Q<Button>("play-button").clicked += ContinueRun;')[0];
    expect(u.kind).toBe('clicked');
    expect(u.event).toBe('clicked');
    expect(u.handler).toBe('ContinueRun');
  });

  it('finds a RegisterCallback and names the event type', () => {
    const u = find('root.Q("menu-card").RegisterCallback<PointerDownEvent>(OnPress);')[0];
    expect(u.kind).toBe('callback');
    expect(u.event).toBe('PointerDownEvent');
    expect(u.handler).toBe('OnPress');
  });

  it('finds a value-changed callback', () => {
    const u = find('root.Q<Slider>("volume-slider").RegisterValueChangedCallback(OnVolume);')[0];
    expect(u.kind).toBe('value-changed');
    expect(u.handler).toBe('OnVolume');
  });

  it('records a bare query as a lookup with no behaviour', () => {
    const u = find('var list = root.Q("run-list");').find((x) => x.kind === 'query')!;
    expect(u.handler).toBe(null);
  });
});

describe('behaviour reached through a local', () => {
  const SRC = `
    void OnEnable() {
      var play = root.Q<Button>("play-button");
      var quit = root.Q<Button>("quit-btn");
      play.clicked += ContinueRun;
      quit.clicked += Application.Quit;
      play.SetEnabled(false);
    }
    void ContinueRun() { }
  `;

  it('attributes the click to the element the local came from', () => {
    const clicks = find(SRC).filter((u) => u.kind === 'clicked');
    expect(clicks.map((c) => [c.elementName, c.handler])).toEqual([
      ['play-button', 'ContinueRun'],
      ['quit-btn', 'Application.Quit'],
    ]);
  });

  it('records mutations too — SetEnabled is a thing that happens to it', () => {
    const m = of(find(SRC), 'play-button').find((u) => u.kind === 'mutation')!;
    expect(m.event).toBe('SetEnabled');
  });

  it('finds the handler declaration line, for go-to-handler', () => {
    const click = find(SRC).find((u) => u.handler === 'ContinueRun')!;
    expect(click.handlerLine).not.toBe(null);
    expect(click.handlerLine!).toBeGreaterThan(0);
    expect(SRC.split('\n')[click.handlerLine! - 1]).toContain('void ContinueRun');
  });

  it('leaves handlerLine null when the handler is elsewhere', () => {
    const quit = find(SRC).find((u) => u.handler === 'Application.Quit')!;
    expect(quit.handlerLine).toBe(null);
  });
});

describe('what it must not report', () => {
  it('ignores an unknown element name', () => {
    expect(find('root.Q<Button>("not-in-any-uxml").clicked += Go;')).toEqual([]);
  });

  it('ignores a local that was never bound to an element', () => {
    expect(find('someButton.clicked += Go;')).toEqual([]);
  });

  it('ignores everything inside a comment', () => {
    expect(find('// root.Q<Button>("play-button").clicked += Ghost;')).toEqual([]);
  });

  it('returns nothing when there are no known names', () => {
    expect(findElementUsages('/p/X.cs', 'a', 'a', [])).toEqual([]);
  });
});

describe('location', () => {
  it('points at the element name literal', () => {
    const src = 'void A() {\n  root.Q<Button>("play-button").clicked += Go;\n}';
    const u = findElementUsages('/p/X.cs', blank(src), src, NAMES)[0];
    expect(u.line).toBe(2);
    expect(src.split('\n')[1].slice(u.column - 1)).toStartWith('play-button');
  });

  it('carries the source line for the inspector row', () => {
    const u = find('root.Q<Button>("play-button").clicked += ContinueRun;')[0];
    expect(u.snippet).toBe('root.Q<Button>("play-button").clicked += ContinueRun;');
  });
});

describe('describeUsage', () => {
  it('reads as a sentence about what happens', () => {
    const say = (src: string) => describeUsage(find(src)[0]);
    expect(say('root.Q<Button>("play-button").clicked += Go;')).toBe('on click → Go()');
    expect(say('root.Q("menu-card").RegisterCallback<ClickEvent>(Go);')).toBe('on ClickEvent → Go()');
    expect(say('root.Q<Slider>("volume-slider").RegisterValueChangedCallback(Go);'))
      .toBe('on value changed → Go()');
  });
});

describe('mutations chained onto the query', () => {
  it('records SetEnabled without needing a local', () => {
    const u = find('root.Q<Button>("quit-btn").SetEnabled(false);')[0];
    expect(u.kind).toBe('mutation');
    expect(u.event).toBe('SetEnabled');
  });

  it('records AddToClassList the same way', () => {
    expect(find('root.Q("menu-card").AddToClassList("open");')[0].kind).toBe('mutation');
  });
});
