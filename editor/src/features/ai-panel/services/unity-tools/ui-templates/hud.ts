/**
 * `hud` — health/ammo/objective, safe-area padding, corner anchoring.
 *
 * Structural shape mirrors `fixtures/uitoolkit/HUD.uxml` (root container, a
 * top bar with hp/ammo panels, a pause button; `hud-*` element names) — that
 * fixture exists to exercise `asset-checks.ts`'s findings (it deliberately
 * carries a `box-shadow` and an undeclared class), so this template is not a
 * byte-for-byte copy of it, just the same screen shape, vetted clean.
 *
 * The root is `position: absolute` covering the panel (an overlay, per
 * `DESIGN_RULES`) with `picking-mode="Ignore"` so empty HUD space never
 * blocks clicks into the game view underneath; `padding: var(--space-24)`
 * on every edge is the safe-area margin. `justify-content: space-between`
 * with exactly two children (the top bar, the objective banner) pins one to
 * each end — no `margin-top: auto` (an unreliable value in USS) needed for
 * the bottom anchor.
 */

import {
  buildControllerSkeleton,
  controllerFields,
  elementName,
  px,
  type ScreenTemplate,
  type TemplateContext,
} from './shared';

export function buildHudTemplate(ctx: TemplateContext): ScreenTemplate {
  const p = ctx.prefix;
  const n = {
    root: elementName(p, 'root'),
    topbar: elementName(p, 'topbar'),
    health: elementName(p, 'health'),
    hpLabel: elementName(p, 'hp-label'),
    hpBar: elementName(p, 'hp-bar'),
    hpValue: elementName(p, 'hp-value'),
    ammo: elementName(p, 'ammo'),
    ammoLabel: elementName(p, 'ammo-label'),
    ammoValue: elementName(p, 'ammo-value'),
    pauseButton: elementName(p, 'pause-button'),
    objective: elementName(p, 'objective'),
    objectiveText: elementName(p, 'objective-text'),
  };

  const uxml = `<ui:UXML xmlns:ui="UnityEngine.UIElements" xmlns:uie="UnityEditor.UIElements" editor-extension-mode="False">
    <Style src="{{THEME_SRC}}" />
    <Style src="{{USS_SRC}}" />
    <ui:VisualElement name="${n.root}" class="hud-root" picking-mode="Ignore">
        <ui:VisualElement name="${n.topbar}" class="hud-topbar">
            <ui:VisualElement name="${n.health}" class="hud-panel">
                <ui:Label name="${n.hpLabel}" text="HP" class="hud-label" />
                <ui:ProgressBar name="${n.hpBar}" low-value="0" high-value="100" value="100" class="hud-bar" />
                <ui:Label name="${n.hpValue}" text="100" class="hud-value" />
            </ui:VisualElement>
            <ui:VisualElement name="${n.ammo}" class="hud-panel hud-panel--ammo">
                <ui:Label name="${n.ammoLabel}" text="AMMO" class="hud-label" />
                <ui:Label name="${n.ammoValue}" text="30 / 90" class="hud-value hud-value--big" />
            </ui:VisualElement>
            <ui:Button name="${n.pauseButton}" text="II" class="hud-button hud-button--ghost" />
        </ui:VisualElement>
        <ui:VisualElement name="${n.objective}" class="hud-objective">
            <ui:Label name="${n.objectiveText}" text="Reach the extraction point." class="hud-objective-text" />
        </ui:VisualElement>
    </ui:VisualElement>
</ui:UXML>
`;

  const v = ctx.palette;
  const uss = `.hud-root {
    position: absolute;
    left: 0;
    top: 0;
    right: 0;
    bottom: 0;
    padding: ${v.space24};
    flex-direction: column;
    justify-content: space-between;
}

.hud-topbar {
    flex-direction: row;
    justify-content: space-between;
    align-items: flex-start;
}

.hud-panel {
    flex-direction: column;
    background-color: ${v.surface};
    border-radius: ${v.radius};
    padding: ${v.space12} ${v.space16};
    min-width: ${px(160, ctx)};
}

.hud-panel--ammo {
    align-items: flex-end;
}

.hud-label {
    color: ${v.textMuted};
    font-size: ${v.fontSize12};
    -unity-font-style: bold;
    -unity-text-align: middle-left;
}

.hud-bar {
    height: ${px(8, ctx)};
    width: ${px(140, ctx)};
    margin-top: ${v.space4};
}

.hud-value {
    color: ${v.text};
    font-size: ${v.fontSize20};
    -unity-text-align: middle-left;
    margin-top: ${v.space4};
}

.hud-value--big {
    font-size: ${v.fontSize24};
}

.hud-button {
    width: ${px(40, ctx)};
    height: ${px(40, ctx)};
    border-radius: ${v.radius};
    border-width: 2px;
    border-color: rgba(0, 0, 0, 0);
    background-color: rgba(0, 0, 0, 0);
    color: ${v.text};
    font-size: ${v.fontSize16};
    -unity-text-align: middle-center;
    transition-property: background-color, scale;
    transition-duration: 120ms;
}

.hud-button:hover {
    background-color: ${v.surface};
    scale: 1.05 1.05;
}

.hud-button:active {
    scale: 0.95 0.95;
}

.hud-button:focus {
    border-color: ${v.accent};
}

.hud-button--ghost {
    color: ${v.textMuted};
}

.hud-objective {
    align-self: flex-start;
    background-color: ${v.surface};
    border-radius: ${v.radius};
    padding: ${v.space8} ${v.space16};
}

.hud-objective-text {
    color: ${v.text};
    font-size: ${v.fontSize14};
    -unity-text-align: middle-left;
}
`;

  const fields = controllerFields(ctx, [
    { csType: 'ProgressBar', suffix: 'hp-bar' },
    { csType: 'Label', suffix: 'hp-value' },
    { csType: 'Label', suffix: 'ammo-value' },
    { csType: 'Button', suffix: 'pause-button' },
    { csType: 'Label', suffix: 'objective-text' },
  ]);

  return {
    uxml,
    uss,
    elementNames: Object.values(n),
    controllerSkeleton: buildControllerSkeleton(ctx, fields),
  };
}
