/**
 * `settings` — sections (audio/video), sliders/toggles/dropdowns as real UI
 * Toolkit field controls, an apply/back footer.
 *
 * Sections rather than a tab strip that switches panels: swapping panel
 * visibility is C# behaviour this recipe does not write (the controller
 * skeleton only binds fields), and a tab strip whose tabs do not yet do
 * anything would be a worse starting point than one scrollable panel that
 * already works.
 */

import {
  buildControllerSkeleton,
  controllerFields,
  elementName,
  px,
  type ScreenTemplate,
  type TemplateContext,
} from './shared';

export function buildSettingsTemplate(ctx: TemplateContext): ScreenTemplate {
  const p = ctx.prefix;
  const n = {
    root: elementName(p, 'root'),
    panel: elementName(p, 'panel'),
    header: elementName(p, 'header'),
    scroll: elementName(p, 'scroll'),
    audioHeading: elementName(p, 'audio-heading'),
    volumeRow: elementName(p, 'volume-row'),
    volumeLabel: elementName(p, 'volume-label'),
    volumeSlider: elementName(p, 'volume-slider'),
    muteRow: elementName(p, 'mute-row'),
    muteLabel: elementName(p, 'mute-label'),
    muteToggle: elementName(p, 'mute-toggle'),
    videoHeading: elementName(p, 'video-heading'),
    fullscreenRow: elementName(p, 'fullscreen-row'),
    fullscreenLabel: elementName(p, 'fullscreen-label'),
    fullscreenToggle: elementName(p, 'fullscreen-toggle'),
    qualityRow: elementName(p, 'quality-row'),
    qualityLabel: elementName(p, 'quality-label'),
    qualityDropdown: elementName(p, 'quality-dropdown'),
    footer: elementName(p, 'footer'),
    backButton: elementName(p, 'back-button'),
    applyButton: elementName(p, 'apply-button'),
  };

  const uxml = `<ui:UXML xmlns:ui="UnityEngine.UIElements" xmlns:uie="UnityEditor.UIElements" editor-extension-mode="False">
    <Style src="{{THEME_SRC}}" />
    <Style src="{{USS_SRC}}" />
    <ui:VisualElement name="${n.root}" class="settings-root">
        <ui:VisualElement name="${n.panel}" class="settings-panel">
            <ui:Label name="${n.header}" text="Settings" class="settings-header" />
            <ui:ScrollView name="${n.scroll}" class="settings-scroll">
                <ui:Label name="${n.audioHeading}" text="Audio" class="settings-section-label" />
                <ui:VisualElement name="${n.volumeRow}" class="settings-row">
                    <ui:Label name="${n.volumeLabel}" text="Master volume" class="settings-row-label" />
                    <ui:Slider name="${n.volumeSlider}" low-value="0" high-value="100" value="80" class="settings-slider" />
                </ui:VisualElement>
                <ui:VisualElement name="${n.muteRow}" class="settings-row">
                    <ui:Label name="${n.muteLabel}" text="Mute" class="settings-row-label" />
                    <ui:Toggle name="${n.muteToggle}" class="settings-toggle" />
                </ui:VisualElement>
                <ui:Label name="${n.videoHeading}" text="Video" class="settings-section-label" />
                <ui:VisualElement name="${n.fullscreenRow}" class="settings-row">
                    <ui:Label name="${n.fullscreenLabel}" text="Fullscreen" class="settings-row-label" />
                    <ui:Toggle name="${n.fullscreenToggle}" value="true" class="settings-toggle" />
                </ui:VisualElement>
                <ui:VisualElement name="${n.qualityRow}" class="settings-row">
                    <ui:Label name="${n.qualityLabel}" text="Quality" class="settings-row-label" />
                    <ui:DropdownField name="${n.qualityDropdown}" choices="Low,Medium,High" index="1" class="settings-dropdown" />
                </ui:VisualElement>
            </ui:ScrollView>
            <ui:VisualElement name="${n.footer}" class="settings-footer">
                <ui:Button name="${n.backButton}" text="Back" class="settings-button" />
                <ui:Button name="${n.applyButton}" text="Apply" class="settings-button settings-button--primary" />
            </ui:VisualElement>
        </ui:VisualElement>
    </ui:VisualElement>
</ui:UXML>
`;

  const v = ctx.palette;
  const uss = `.settings-root {
    flex-grow: 1;
    justify-content: center;
    align-items: center;
    background-color: ${v.bg};
    padding: ${v.space32};
}

.settings-panel {
    width: ${px(640, ctx)};
    max-height: ${px(720, ctx)};
    background-color: ${v.surface};
    border-radius: ${v.radius};
    padding: ${v.space24};
    flex-direction: column;
}

.settings-header {
    font-size: ${v.fontSize24};
    -unity-font-style: bold;
    -unity-text-align: middle-left;
    color: ${v.text};
    margin-bottom: ${v.space16};
}

.settings-scroll {
    flex-grow: 1;
}

.settings-section-label {
    font-size: ${v.fontSize14};
    -unity-font-style: bold;
    -unity-text-align: middle-left;
    color: ${v.textMuted};
    margin-top: ${v.space16};
    margin-bottom: ${v.space8};
}

.settings-row {
    flex-direction: row;
    justify-content: space-between;
    align-items: center;
    margin-bottom: ${v.space12};
}

.settings-row-label {
    color: ${v.text};
    font-size: ${v.fontSize14};
    -unity-text-align: middle-left;
}

.settings-slider {
    width: ${px(240, ctx)};
}

.settings-dropdown {
    width: ${px(160, ctx)};
}

.settings-slider,
.settings-toggle,
.settings-dropdown {
    border-width: 2px;
    border-color: rgba(0, 0, 0, 0);
    border-radius: ${v.radius};
}

.settings-slider:focus,
.settings-toggle:focus,
.settings-dropdown:focus {
    border-color: ${v.accent};
}

.settings-footer {
    flex-direction: row;
    justify-content: flex-end;
    margin-top: ${v.space24};
}

.settings-button {
    min-width: ${px(120, ctx)};
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

.settings-button:hover {
    scale: 1.02 1.02;
}

.settings-button:active {
    scale: 0.97 0.97;
}

.settings-button:focus {
    border-color: ${v.accent};
}

.settings-button--primary {
    background-color: ${v.accent};
}

.settings-button--primary:hover {
    opacity: 0.9;
}
`;

  const fields = controllerFields(ctx, [
    { csType: 'Slider', suffix: 'volume-slider' },
    { csType: 'Toggle', suffix: 'mute-toggle' },
    { csType: 'Toggle', suffix: 'fullscreen-toggle' },
    { csType: 'DropdownField', suffix: 'quality-dropdown' },
    { csType: 'Button', suffix: 'back-button' },
    { csType: 'Button', suffix: 'apply-button' },
  ]);

  return {
    uxml,
    uss,
    elementNames: Object.values(n),
    controllerSkeleton: buildControllerSkeleton(ctx, fields),
  };
}
