/**
 * `main-menu` — title, a vertical button stack with hover/active/focus
 * states, version footer.
 *
 * A full screen, not an overlay, so the root follows `DESIGN_RULES`'s
 * "Screen root: flex-grow:1 + justify-content" rather than HUD's
 * `position:absolute` — see `hud.ts`'s header for the overlay case.
 */

import {
  buildControllerSkeleton,
  controllerFields,
  elementName,
  px,
  type ScreenTemplate,
  type TemplateContext,
} from './shared';

export function buildMainMenuTemplate(ctx: TemplateContext): ScreenTemplate {
  const p = ctx.prefix;
  const n = {
    root: elementName(p, 'root'),
    title: elementName(p, 'title'),
    buttons: elementName(p, 'buttons'),
    playButton: elementName(p, 'play-button'),
    continueButton: elementName(p, 'continue-button'),
    settingsButton: elementName(p, 'settings-button'),
    quitButton: elementName(p, 'quit-button'),
    version: elementName(p, 'version'),
  };

  const uxml = `<ui:UXML xmlns:ui="UnityEngine.UIElements" xmlns:uie="UnityEditor.UIElements" editor-extension-mode="False">
    <Style src="{{THEME_SRC}}" />
    <Style src="{{USS_SRC}}" />
    <ui:VisualElement name="${n.root}" class="main-menu-root">
        <ui:Label name="${n.title}" text="${ctx.name.toUpperCase()}" class="main-menu-title" />
        <ui:VisualElement name="${n.buttons}" class="main-menu-buttons">
            <ui:Button name="${n.playButton}" text="Play" class="main-menu-button main-menu-button--primary" />
            <ui:Button name="${n.continueButton}" text="Continue" class="main-menu-button" />
            <ui:Button name="${n.settingsButton}" text="Settings" class="main-menu-button" />
            <ui:Button name="${n.quitButton}" text="Quit" class="main-menu-button" />
        </ui:VisualElement>
        <ui:Label name="${n.version}" text="v0.1.0" class="main-menu-version" />
    </ui:VisualElement>
</ui:UXML>
`;

  const v = ctx.palette;
  const uss = `.main-menu-root {
    flex-grow: 1;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    background-color: ${v.bg};
    padding: ${v.space32};
}

.main-menu-title {
    color: ${v.text};
    font-size: ${v.fontSize32};
    -unity-font-style: bold;
    -unity-text-align: middle-center;
    margin-bottom: ${v.space32};
}

.main-menu-buttons {
    flex-direction: column;
    width: ${px(360, ctx)};
}

.main-menu-button {
    height: ${px(48, ctx)};
    margin-bottom: ${v.space12};
    border-radius: ${v.radius};
    border-width: 2px;
    border-color: rgba(0, 0, 0, 0);
    background-color: ${v.surface};
    color: ${v.text};
    font-size: ${v.fontSize16};
    -unity-text-align: middle-center;
    transition-property: background-color, scale, opacity;
    transition-duration: 120ms;
}

.main-menu-button:hover {
    background-color: ${v.accent};
    scale: 1.02 1.02;
}

.main-menu-button:active {
    scale: 0.97 0.97;
}

.main-menu-button:focus {
    border-color: ${v.accent};
}

.main-menu-button:disabled {
    opacity: 0.4;
}

.main-menu-button--primary {
    background-color: ${v.accent};
}

.main-menu-button--primary:hover {
    opacity: 0.9;
}

.main-menu-version {
    position: absolute;
    right: ${v.space16};
    bottom: ${v.space16};
    color: ${v.textMuted};
    font-size: ${v.fontSize12};
}
`;

  const fields = controllerFields(ctx, [
    { csType: 'Button', suffix: 'play-button' },
    { csType: 'Button', suffix: 'continue-button' },
    { csType: 'Button', suffix: 'settings-button' },
    { csType: 'Button', suffix: 'quit-button' },
  ]);

  return {
    uxml,
    uss,
    elementNames: Object.values(n),
    controllerSkeleton: buildControllerSkeleton(ctx, fields),
  };
}
