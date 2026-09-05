import { describe, it, expect } from 'bun:test';
import { buildRenderPlanFromText, ELEMENT_CLASS, type RenderNode } from './render-plan';
import { parseUxml } from '../../../utils/uxml-model';

const UXML = `<ui:UXML xmlns:ui="UnityEngine.UIElements">
  <Style src="MainMenu.uss" />
  <ui:VisualElement name="root" class="screen">
    <ui:Label name="wordmark" text="EMBERFALL" class="wordmark" />
    <ui:VisualElement name="menu-card" class="card">
      <ui:Button name="play-button" text="Continue" class="btn btn--primary" style="opacity: 0.9;" />
    </ui:VisualElement>
  </ui:VisualElement>
</ui:UXML>`;

const USS = `
:root { --accent: rgb(212, 176, 98); }
.card { width: 420px; box-shadow: 0 2px 8px rgba(0,0,0,.4); }
.btn { font-size: 18px; color: var(--accent); }
VisualElement { flex-grow: 1; }
.wordmark { -unity-text-align: middle-center; }
Button:hover { opacity: 1; }
`;

const plan = buildRenderPlanFromText(parseUxml(UXML), [{ path: 'MainMenu.uss', content: USS }]);

function find(node: RenderNode | null, name: string): RenderNode | undefined {
  if (!node) return undefined;
  if (node.name === name) return node;
  for (const c of node.children) {
    const hit = find(c, name);
    if (hit) return hit;
  }
  return undefined;
}

describe('render plan — the tree', () => {
  it('drops <Style>, which describes the document rather than appearing in it', () => {
    expect(plan.root!.children.map((c) => c.tag)).toEqual(['VisualElement']);
  });

  it('stamps the whole type chain, which is what makes VisualElement {} match', () => {
    // A USS type selector matches the C# INHERITANCE chain. Without the chain on
    // the node, `VisualElement { flex-grow: 1 }` would style nothing at all.
    const btn = find(plan.root, 'play-button')!;
    expect(btn.classes).toContain('u-t-Button');
    expect(btn.classes).toContain('u-t-TextElement');
    expect(btn.classes).toContain('u-t-VisualElement');
  });

  it('adds the classes the control generates for itself', () => {
    // `.unity-button` is never written in UXML; Unity's Button adds it.
    expect(find(plan.root, 'play-button')!.classes).toContain('unity-button');
  });

  it('keeps the authored classes', () => {
    const btn = find(plan.root, 'play-button')!;
    expect(btn.classes).toContain('btn');
    expect(btn.classes).toContain('btn--primary');
  });

  it('puts the defaults class on every node', () => {
    const all: RenderNode[] = [];
    (function walk(n: RenderNode) { all.push(n); n.children.forEach(walk); })(plan.root!);
    expect(all.every((n) => n.classes.includes(ELEMENT_CLASS))).toBe(true);
  });

  it('carries name, text, inline style and the source id', () => {
    const btn = find(plan.root, 'play-button')!;
    expect(btn.text).toBe('Continue');
    expect(btn.inlineStyle).toBe('opacity: 0.9;');
    expect(btn.id).toBeTruthy();
  });
});

describe('render plan — the CSS', () => {
  it('rewrites :root to :host, or every custom property silently fails', () => {
    // Inside a shadow root `:root` matches nothing. And because custom
    // properties inherit ACROSS the boundary, a missed `--accent` would fall
    // through to the IDE's own token and render something plausible and wrong.
    expect(plan.css).toContain(':host');
    expect(plan.css).toContain('--accent: rgb(212, 176, 98)');
    expect(plan.css).not.toMatch(/:root\s*\{[^}]*--accent/);
  });

  it('guards the shadow boundary with all:initial plus a restore', () => {
    const initialAt = plan.css.indexOf('all: initial');
    const restoreAt = plan.css.indexOf('font-family:');
    expect(initialAt).toBeGreaterThanOrEqual(0);
    // Order matters: the restore must come after, or the host inherits Times.
    expect(restoreAt).toBeGreaterThan(initialAt);
  });

  it('emits the Yoga defaults on the element class', () => {
    expect(plan.css).toContain('flex-direction: column');
    expect(plan.css).toContain('min-width: 0');
    expect(plan.css).toContain('position: relative');
    expect(plan.css).toContain('white-space: nowrap');
  });

  it('rewrites a type selector so it matches the stamped class', () => {
    expect(plan.css).toContain('.u-t-VisualElement');
  });

  it('keeps a native pseudo-class as-is', () => {
    expect(plan.css).toContain('.u-t-Button:hover');
  });

  it('expands -unity-text-align across both axes', () => {
    expect(plan.css).toContain('text-align: center');
    expect(plan.css).toContain('align-items: center');
  });

  it('drops a property USS does not have, and says so', () => {
    expect(plan.css).not.toContain('box-shadow');
    expect(plan.notes.some((n) => n.startsWith('box-shadow'))).toBe(true);
  });

  it('reports stylesheets it could not resolve rather than rendering a lie', () => {
    const unresolved = buildRenderPlanFromText(parseUxml(UXML), []);
    expect(unresolved.notes.some((n) => n.includes('could not be resolved'))).toBe(true);
  });

  it('survives a document with no root', () => {
    const empty = buildRenderPlanFromText(parseUxml(''), []);
    expect(empty.root).toBe(null);
    expect(empty.css).toContain('all: initial');
  });
});

describe('the panel root', () => {
  // Unity gives a UXML document a panel-sized `rootVisualElement` to live in:
  // an ordinary VisualElement, so a flex column that stretches its children.
  // Without that, `flex-grow: 1` on a screen root — which nearly every UXML
  // has — grows into nothing, `justify-content` gets no free space to hand
  // out, and the whole UI renders hugging the top of an otherwise empty
  // screen. That was the bug; these pin the shape of the fix.
  const css = buildRenderPlanFromText(
    parseUxml('<ui:UXML xmlns:ui="UnityEngine.UIElements"><ui:VisualElement name="root" class="screen" /></ui:UXML>'),
    [{ path: 'a.uss', content: '.screen { flex-grow: 1; justify-content: center; }' }],
  ).css;

  it('makes the host a flex column, like every VisualElement', () => {
    // The first `:host` block is the `all: initial` guard; the restore is next.
    const restore = css.indexOf(':host {', css.indexOf(':host {') + 1);
    const host = css.slice(restore, css.indexOf('}', restore));
    expect(host).toContain('display: flex');
    expect(host).toContain('flex-direction: column');
    expect(host).toContain('align-items: stretch');
  });

  it('lets the document element fill the host, standing in for rootVisualElement', () => {
    expect(css).toContain(':host > .u-el { flex-grow: 1; }');
  });
});
