/**
 * `inventory` — a fixed grid of slots (`flex-wrap`, no `gap` — USS has none,
 * see `checkUss`'s remedy table; spacing is margin on each slot), a
 * `--selected` modifier, and a detail pane.
 *
 * `SLOT_COUNT` slots is a plain fixed-size inventory (common for an
 * ability/quick-item bar or a small stash), not a pooled/virtualized list —
 * the simpler, more usable starting point for a scaffold. Binding them is
 * therefore a loop over `Q<VisualElement>($"{prefix}-slot-{i}")`, not one
 * field per slot, which is why this template writes its own controller
 * skeleton instead of `shared.ts`'s per-field `buildControllerSkeleton`.
 */

import { elementName, fieldNameFor, px, type ScreenTemplate, type TemplateContext } from './shared';

const SLOT_COUNT = 12;

export function buildInventoryTemplate(ctx: TemplateContext): ScreenTemplate {
  const p = ctx.prefix;
  const slotNames = Array.from({ length: SLOT_COUNT }, (_, i) => elementName(p, `slot-${i}`));
  const n = {
    root: elementName(p, 'root'),
    grid: elementName(p, 'grid'),
    detail: elementName(p, 'detail'),
    detailName: elementName(p, 'detail-name'),
    detailDescription: elementName(p, 'detail-description'),
    detailUseButton: elementName(p, 'detail-use-button'),
  };

  const slotUxml = slotNames
    .map(
      (name, i) =>
        `                <ui:VisualElement name="${name}" class="inventory-slot${i === 0 ? ' inventory-slot--selected' : ''}" />`,
    )
    .join('\n');

  const uxml = `<ui:UXML xmlns:ui="UnityEngine.UIElements" xmlns:uie="UnityEditor.UIElements" editor-extension-mode="False">
    <Style src="{{THEME_SRC}}" />
    <Style src="{{USS_SRC}}" />
    <ui:VisualElement name="${n.root}" class="inventory-root">
        <ui:VisualElement name="${n.grid}" class="inventory-grid">
${slotUxml}
        </ui:VisualElement>
        <ui:VisualElement name="${n.detail}" class="inventory-detail">
            <ui:Label name="${n.detailName}" text="Item name" class="inventory-detail-name" />
            <ui:Label name="${n.detailDescription}" text="Item description goes here." class="inventory-detail-description" />
            <ui:Button name="${n.detailUseButton}" text="Use" class="inventory-detail-use-button" />
        </ui:VisualElement>
    </ui:VisualElement>
</ui:UXML>
`;

  const v = ctx.palette;
  const uss = `.inventory-root {
    flex-grow: 1;
    flex-direction: row;
    padding: ${v.space24};
    background-color: ${v.bg};
}

.inventory-grid {
    flex-direction: row;
    flex-wrap: wrap;
    align-content: flex-start;
    width: ${px(448, ctx)};
}

.inventory-slot {
    width: ${px(96, ctx)};
    height: ${px(96, ctx)};
    margin: ${v.space4};
    align-items: center;
    justify-content: center;
    background-color: ${v.surface};
    border-radius: ${v.radius};
    border-width: 2px;
    border-color: rgba(0, 0, 0, 0);
    transition-property: border-color, scale;
    transition-duration: 120ms;
}

.inventory-slot:hover {
    border-color: ${v.accent};
    scale: 1.03 1.03;
}

.inventory-slot:active {
    scale: 0.97 0.97;
}

.inventory-slot--selected {
    border-color: ${v.accent};
}

.inventory-detail {
    width: ${px(320, ctx)};
    margin-left: ${v.space24};
    flex-direction: column;
    background-color: ${v.surface};
    border-radius: ${v.radius};
    padding: ${v.space16};
}

.inventory-detail-name {
    font-size: ${v.fontSize20};
    -unity-font-style: bold;
    -unity-text-align: middle-left;
    color: ${v.text};
    margin-bottom: ${v.space8};
}

.inventory-detail-description {
    font-size: ${v.fontSize14};
    color: ${v.textMuted};
    white-space: normal;
    -unity-text-align: middle-left;
    margin-bottom: ${v.space16};
}

.inventory-detail-use-button {
    height: ${px(40, ctx)};
    border-radius: ${v.radius};
    border-width: 2px;
    border-color: rgba(0, 0, 0, 0);
    background-color: ${v.accent};
    color: ${v.bg};
    font-size: ${v.fontSize14};
    -unity-text-align: middle-center;
    transition-property: opacity, scale;
    transition-duration: 120ms;
}

.inventory-detail-use-button:hover {
    opacity: 0.9;
    scale: 1.02 1.02;
}

.inventory-detail-use-button:active {
    scale: 0.97 0.97;
}

.inventory-detail-use-button:focus {
    border-color: ${v.text};
}
`;

  const detailNameField = fieldNameFor(n.detailName, p, 'Label');
  const detailDescriptionField = fieldNameFor(n.detailDescription, p, 'Label');
  const detailUseButtonField = fieldNameFor(n.detailUseButton, p, 'Button');

  const controllerSkeleton = [
    'using UnityEngine;',
    'using UnityEngine.UIElements;',
    'using System.Collections.Generic;',
    '',
    `public class ${ctx.name}Controller : MonoBehaviour`,
    '{',
    '    [SerializeField] private UIDocument document;',
    '',
    `    private const int SlotCount = ${SLOT_COUNT};`,
    '    private readonly List<VisualElement> slots = new List<VisualElement>();',
    `    private Label ${detailNameField};`,
    `    private Label ${detailDescriptionField};`,
    `    private Button ${detailUseButtonField};`,
    '',
    '    private void OnEnable()',
    '    {',
    '        VisualElement root = document.rootVisualElement;',
    '        for (int i = 0; i < SlotCount; i++)',
    '        {',
    `            slots.Add(root.Q<VisualElement>($"${p}-slot-{i}"));`,
    '        }',
    `        ${detailNameField} = root.Q<Label>("${n.detailName}");`,
    `        ${detailDescriptionField} = root.Q<Label>("${n.detailDescription}");`,
    `        ${detailUseButtonField} = root.Q<Button>("${n.detailUseButton}");`,
    '    }',
    '}',
    '',
  ].join('\n');

  return {
    uxml,
    uss,
    elementNames: [n.root, n.grid, ...slotNames, n.detail, n.detailName, n.detailDescription, n.detailUseButton],
    controllerSkeleton,
  };
}
