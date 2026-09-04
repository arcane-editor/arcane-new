import { describe, it, expect } from 'bun:test';
import {
  renderLayoutTree,
  DEFAULT_MAX_NODES,
  DEFAULT_MAX_DEPTH,
  type LayoutNode,
  type LayoutProbeResult,
} from './layout-tree-text';

/** A `LayoutNode` with sane defaults, shaped like a node `HUD.uxml` would probe to. */
function node(over: Partial<LayoutNode>): LayoutNode {
  return {
    id: '0',
    parentId: null,
    name: null,
    kind: 'VisualElement',
    classes: [],
    depth: 0,
    box: { x: 0, y: 0, w: 100, h: 20 },
    styles: {},
    text: null,
    overflowX: false,
    ...over,
  };
}

function result(nodes: LayoutNode[], truncated = false): LayoutProbeResult {
  return { nodes, truncated };
}

describe('renderLayoutTree', () => {
  it('says so plainly when there are no elements', () => {
    expect(renderLayoutTree(result([]))).toBe('(no elements)');
  });

  it('renders one line per node: name kind.classes [x,y w×h]', () => {
    const out = renderLayoutTree(
      result([
        node({
          id: '0',
          name: 'hud-root',
          kind: 'VisualElement',
          classes: ['hud'],
          depth: 0,
          box: { x: 0, y: 0, w: 800, h: 600 },
        }),
      ]),
    );
    expect(out).toBe('hud-root VisualElement.hud [0,0 800×600]');
  });

  it('joins multiple classes with dots', () => {
    const out = renderLayoutTree(
      result([node({ name: 'hp-label', kind: 'Label', classes: ['hud__label', 'hud__label--big'] })]),
    );
    expect(out).toBe('hp-label Label.hud__label.hud__label--big [0,0 100×20]');
  });

  it('shows #anon for an unnamed element, and no class suffix when there are no classes', () => {
    const out = renderLayoutTree(result([node({ name: null, kind: 'VisualElement', classes: [] })]));
    expect(out).toBe('#anon VisualElement [0,0 100×20]');
  });

  it('indents children by depth, two spaces per level', () => {
    const out = renderLayoutTree(
      result([
        node({ id: '0', name: 'root', depth: 0 }),
        node({ id: '0.0', parentId: '0', name: 'child', depth: 1 }),
        node({ id: '0.0.0', parentId: '0.0', name: 'grandchild', depth: 2 }),
      ]),
    );
    expect(out).toBe(
      ['root VisualElement [0,0 100×20]', '  child VisualElement [0,0 100×20]', '    grandchild VisualElement [0,0 100×20]'].join(
        '\n',
      ),
    );
  });

  it('appends a quoted text excerpt when the node carries text', () => {
    const out = renderLayoutTree(result([node({ name: 'hp-label', text: 'HP' })]));
    expect(out).toBe('hp-label VisualElement [0,0 100×20] "HP"');
  });

  it('does not append a text excerpt for whitespace-only text', () => {
    const out = renderLayoutTree(result([node({ name: 'x', text: '   ' })]));
    expect(out).not.toContain('"');
  });

  it('truncates a text excerpt beyond 40 characters with an ellipsis', () => {
    const long = 'x'.repeat(60);
    const out = renderLayoutTree(result([node({ name: 'label', text: long })]));
    const match = /"([^"]*)"/.exec(out);
    expect(match).not.toBeNull();
    const excerpt = match![1];
    expect(excerpt.length).toBe(40);
    expect(excerpt.endsWith('…')).toBe(true);
    expect(excerpt.slice(0, 39)).toBe('x'.repeat(39));
  });

  it('omits the style suffix by default', () => {
    const out = renderLayoutTree(
      result([node({ name: 'root', styles: { display: 'flex', flexDirection: 'column' } })]),
    );
    expect(out).not.toContain('{');
  });

  it('renders key styles in kebab-case when includeStyles is set', () => {
    const out = renderLayoutTree(
      result([
        node({
          name: 'root',
          styles: {
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'flex-start',
            alignItems: 'stretch',
            flexGrow: '1',
            position: 'relative',
          },
        }),
      ]),
      { includeStyles: true },
    );
    expect(out).toContain(
      '{display:flex; flex-direction:column; justify-content:flex-start; align-items:stretch; flex-grow:1; position:relative}',
    );
  });

  it('omits falsy style values from the style suffix', () => {
    const out = renderLayoutTree(result([node({ name: 'root', styles: { display: 'flex' } })]), {
      includeStyles: true,
    });
    expect(out).toBe('root VisualElement [0,0 100×20] {display:flex}');
  });

  it('does not show non-tree style keys (e.g. color, backgroundColor) even with includeStyles', () => {
    const out = renderLayoutTree(
      result([node({ name: 'root', styles: { color: 'rgb(0,0,0)', backgroundColor: 'rgb(1,1,1)' } })]),
      { includeStyles: true },
    );
    expect(out).not.toContain('color');
  });

  it('respects maxDepth — deeper nodes are dropped, and are not counted as "more"', () => {
    const out = renderLayoutTree(
      result([
        node({ id: '0', name: 'root', depth: 0 }),
        node({ id: '0.0', parentId: '0', name: 'child', depth: 1 }),
        node({ id: '0.0.0', parentId: '0.0', name: 'grandchild', depth: 2 }),
      ]),
      { maxDepth: 1 },
    );
    expect(out).toContain('root');
    expect(out).toContain('child');
    expect(out).not.toContain('grandchild');
    expect(out).not.toContain('more node');
  });

  it('defaults maxDepth to DEFAULT_MAX_DEPTH', () => {
    expect(DEFAULT_MAX_DEPTH).toBe(6);
    const deep: LayoutNode[] = [];
    for (let d = 0; d <= 7; d++) {
      deep.push(node({ id: String(d), parentId: d === 0 ? null : String(d - 1), name: `n${d}`, depth: d }));
    }
    const out = renderLayoutTree(result(deep));
    expect(out).toContain('n6');
    expect(out).not.toContain('n7');
  });

  it('caps output at 6000 characters with a "… (N more nodes)" trailer', () => {
    const many: LayoutNode[] = [];
    for (let i = 0; i < 300; i++) {
      many.push(node({ id: String(i), name: `node-${String(i).padStart(3, '0')}`, depth: 0 }));
    }
    const out = renderLayoutTree(result(many));
    expect(out.length).toBeLessThan(6200);
    expect(out).toContain('node-000');
    expect(out).not.toContain('node-299');
    const trailer = /… \((\d+) more nodes?\)$/.exec(out);
    expect(trailer).not.toBeNull();
    expect(Number(trailer![1])).toBeGreaterThan(0);
  });

  it('always renders at least one line, even an oversized first one', () => {
    const huge = node({ name: 'x'.repeat(7000) });
    const out = renderLayoutTree(result([huge]));
    expect(out).toContain('x'.repeat(7000));
  });

  it('exports DEFAULT_MAX_NODES for the tool to reuse in its truncation note', () => {
    expect(DEFAULT_MAX_NODES).toBe(400);
  });
});
