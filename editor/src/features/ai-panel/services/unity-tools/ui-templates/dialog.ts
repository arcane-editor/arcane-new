/**
 * `dialog` — a modal overlay, title/body/two buttons, a focus trap declared
 * with `focusable="true"`.
 *
 * `dialog-root` is deliberately picking-mode-default (not `Ignore`, unlike
 * `hud.ts`'s root): a modal scrim exists specifically to swallow clicks
 * outside the panel. `dialog-panel` and both buttons declare
 * `focusable="true"`, and the controller skeleton calls `.Focus()` on the
 * confirm button in `OnEnable` — the actual trap (keeping Tab from leaving
 * the dialog) is Unity's own default focus-ring navigation once something
 * inside the panel holds focus; nothing outside it is reachable by keyboard
 * until the dialog closes.
 */

import {
  buildControllerSkeleton,
  controllerFields,
  elementName,
  fieldNameFor,
  px,
  type ScreenTemplate,
  type TemplateContext,
} from './shared';

export function buildDialogTemplate(ctx: TemplateContext): ScreenTemplate {
  const p = ctx.prefix;
  const n = {
    root: elementName(p, 'root'),
    panel: elementName(p, 'panel'),
    title: elementName(p, 'title'),
    body: elementName(p, 'body'),
    footer: elementName(p, 'footer'),
    cancelButton: elementName(p, 'cancel-button'),
    confirmButton: elementName(p, 'confirm-button'),
  };

  const uxml = `<ui:UXML xmlns:ui="UnityEngine.UIElements" xmlns:uie="UnityEditor.UIElements" editor-extension-mode="False">
    <Style src="{{THEME_SRC}}" />
    <Style src="{{USS_SRC}}" />
    <ui:VisualElement name="${n.root}" class="dialog-root">
        <ui:VisualElement name="${n.panel}" class="dialog-panel" focusable="true">
            <ui:Label name="${n.title}" text="Confirm" class="dialog-title" />
            <ui:Label name="${n.body}" text="Are you sure? This cannot be undone." class="dialog-body" />
            <ui:VisualElement name="${n.footer}" class="dialog-footer">
                <ui:Button name="${n.cancelButton}" text="Cancel" focusable="true" class="dialog-button" />
                <ui:Button name="${n.confirmButton}" text="Confirm" focusable="true" class="dialog-button dialog-button--danger" />
            </ui:VisualElement>
        </ui:VisualElement>
    </ui:VisualElement>
</ui:UXML>
`;

  const v = ctx.palette;
  const uss = `.dialog-root {
    position: absolute;
    left: 0;
    top: 0;
    right: 0;
    bottom: 0;
    background-color: rgba(0, 0, 0, 0.6);
    justify-content: center;
    align-items: center;
}

.dialog-panel {
    width: ${px(480, ctx)};
    background-color: ${v.surface};
    border-radius: ${v.radius};
    padding: ${v.space24};
}

.dialog-title {
    font-size: ${v.fontSize20};
    -unity-font-style: bold;
    -unity-text-align: middle-left;
    color: ${v.text};
    margin-bottom: ${v.space12};
}

.dialog-body {
    font-size: ${v.fontSize14};
    color: ${v.textMuted};
    white-space: normal;
    -unity-text-align: middle-left;
    margin-bottom: ${v.space24};
}

.dialog-footer {
    flex-direction: row;
    justify-content: flex-end;
}

.dialog-button {
    min-width: ${px(100, ctx)};
    height: ${px(40, ctx)};
    margin-left: ${v.space12};
    border-radius: ${v.radius};
    border-width: 2px;
    border-color: rgba(0, 0, 0, 0);
    background-color: ${v.surface};
    color: ${v.text};
    font-size: ${v.fontSize14};
    -unity-text-align: middle-center;
    transition-property: background-color, scale, opacity;
    transition-duration: 120ms;
}

.dialog-button:hover {
    scale: 1.02 1.02;
}

.dialog-button:active {
    scale: 0.97 0.97;
}

.dialog-button:focus {
    border-color: ${v.accent};
}

.dialog-button--danger {
    background-color: ${v.danger};
}

.dialog-button--danger:hover {
    opacity: 0.9;
}
`;

  const fields = controllerFields(ctx, [
    { csType: 'Button', suffix: 'cancel-button' },
    { csType: 'Button', suffix: 'confirm-button' },
  ]);
  const confirmField = fieldNameFor(n.confirmButton, ctx.prefix, 'Button');

  return {
    uxml,
    uss,
    elementNames: Object.values(n),
    controllerSkeleton: buildControllerSkeleton(ctx, fields, [
      '// Focus trap: keep keyboard focus inside the dialog while it is open.',
      `${confirmField}.Focus();`,
    ]),
  };
}
