import { describe, expect, it } from 'bun:test';
import { parseUss } from '../../../utils/uss-model';
import { parseUxml } from '../../../utils/uxml-model';
import { buildRenderPlan } from './render-plan';
import { formatStyleCoverage, styleCoverage } from './style-coverage';

function planFor(uxml: string, ussSources: string[] = []) {
  const doc = parseUxml(uxml);
  const sheets = ussSources.map((src, i) => parseUss(src, `/p/sheet${i}.uss`));
  return { plan: buildRenderPlan(doc, sheets), sheets };
}

const MENU = `<ui:UXML xmlns:ui="UnityEngine.UIElements">
  <ui:VisualElement name="root" class="menu">
    <ui:Label name="title" class="menu__title" text="Emberfall" />
    <ui:Button name="play" class="menu__btn menu__btn--primary" text="Continue" />
  </ui:VisualElement>
</ui:UXML>`;

describe('styleCoverage', () => {
  it('reports every element as unstyled when the document reaches no stylesheet', () => {
    const { plan, sheets } = planFor(MENU);
    const c = styleCoverage(plan.root, sheets);

    expect(c.sheetsReachable).toBe(0);
    expect(c.total).toBe(3);
    expect(c.unstyled).toHaveLength(3);
    expect(c.undeclaredClasses).toEqual([
      'menu',
      'menu__btn',
      'menu__btn--primary',
      'menu__title',
    ]);
  });

  it('counts an element styled only when something actually paints it', () => {
    // `.menu` sets layout and nothing else: laid out, never painted.
    const { plan, sheets } = planFor(MENU, [
      `.menu { flex-direction: column; padding: 16px; }
       .menu__title { color: rgb(237, 230, 216); font-size: 32px; }
       .menu__btn { background-color: rgb(40, 34, 30); }
       .menu__btn--primary { border-top-left-radius: 4px; }`,
    ]);
    const c = styleCoverage(plan.root, sheets);

    expect(c.unstyled).toHaveLength(0);
    expect(c.unpainted.map((n) => n.name)).toEqual(['root']);
    expect(c.undeclaredClasses).toEqual([]);
  });

  it('does not count a rule that only applies on :hover as styling the resting element', () => {
    const { plan, sheets } = planFor(MENU, ['.menu__btn:hover { background-color: red; }']);
    const c = styleCoverage(plan.root, sheets);

    expect(c.unstyled.map((n) => n.name)).toContain('play');
  });

  it('does not count a declaration Unity drops at import', () => {
    // box-shadow is the canonical one: it reads like styling and paints nothing.
    const { plan, sheets } = planFor(MENU, ['.menu__btn { box-shadow: 0 2px 6px black; }']);
    const c = styleCoverage(plan.root, sheets);

    const play = c.unpainted.find((n) => n.name === 'play');
    expect(play).toBeDefined();
    expect(play?.paint).toBe(0);
  });

  it('counts an inline style as paint', () => {
    const { plan, sheets } = planFor(
      `<ui:UXML xmlns:ui="UnityEngine.UIElements">
         <ui:VisualElement name="root" style="background-color: rgb(10,10,10);" />
       </ui:UXML>`,
      ['.nothing { color: red; }'],
    );
    const c = styleCoverage(plan.root, sheets);

    expect(c.unstyled).toHaveLength(0);
    expect(c.unpainted).toHaveLength(0);
  });

  it('never reports a control’s Unity-generated classes as undeclared', () => {
    const { plan, sheets } = planFor(
      '<ui:UXML xmlns:ui="UnityEngine.UIElements"><ui:Button name="go" /></ui:UXML>',
    );
    const c = styleCoverage(plan.root, sheets);

    // `unity-button` et al are stamped by the renderer, not written by a human.
    expect(c.undeclaredClasses).toEqual([]);
  });

  it('matches a descendant selector through the ancestor chain', () => {
    const { plan, sheets } = planFor(MENU, ['.menu .menu__title { color: white; }']);
    const c = styleCoverage(plan.root, sheets);

    expect(c.unstyled.map((n) => n.name)).not.toContain('title');
  });
});

describe('formatStyleCoverage', () => {
  it('says nothing at all about a fully painted document', () => {
    const { plan, sheets } = planFor(MENU, [
      `.menu { background-color: black; }
       .menu__title { color: white; }
       .menu__btn { background-color: grey; }
       .menu__btn--primary { border-left-color: gold; }`,
    ]);
    expect(formatStyleCoverage('MainMenu.uxml', styleCoverage(plan.root, sheets))).toBeNull();
  });

  it('leads with the no-stylesheet case, which subsumes the others', () => {
    const { plan, sheets } = planFor(MENU);
    const text = formatStyleCoverage('MainMenu.uxml', styleCoverage(plan.root, sheets)) ?? '';

    expect(text).toContain('references no stylesheet');
    expect(text).toContain('<Style src>');
    // Not also "3 of 3 elements matched no rule" — one diagnosis, not two.
    expect(text).not.toContain('matched no rule');
  });

  it('names the classes that style nothing', () => {
    const { plan, sheets } = planFor(MENU, ['.something-else { color: red; }']);
    const text = formatStyleCoverage('MainMenu.uxml', styleCoverage(plan.root, sheets)) ?? '';

    expect(text).toContain('menu__btn--primary');
    expect(text).toContain('style nothing');
  });
});
