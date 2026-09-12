import { describe, it, expect } from 'bun:test';
import { detectUiStack } from './ui-stack';

describe('detectUiStack', () => {
  it('is "none" when nothing points at either stack', () => {
    expect(detectUiStack({ uxmlCount: 0, panelSettingsCount: 0, canvasScenes: 0 })).toBe('none');
  });

  it('is "uitoolkit" from .uxml documents alone', () => {
    expect(detectUiStack({ uxmlCount: 3, panelSettingsCount: 0, canvasScenes: 0 })).toBe('uitoolkit');
  });

  it('is "uitoolkit" from a PanelSettings asset alone, even with zero .uxml', () => {
    // A PanelSettings created ahead of any document is still a real commitment
    // to UI Toolkit — the whole reason this signal exists separately.
    expect(detectUiStack({ uxmlCount: 0, panelSettingsCount: 1, canvasScenes: 0 })).toBe('uitoolkit');
  });

  it('is "ugui" from a Canvas in a scene/prefab alone', () => {
    expect(detectUiStack({ uxmlCount: 0, panelSettingsCount: 0, canvasScenes: 1 })).toBe('ugui');
  });

  it('is "both" when the project has evidence of each', () => {
    expect(detectUiStack({ uxmlCount: 2, panelSettingsCount: 1, canvasScenes: 5 })).toBe('both');
    expect(detectUiStack({ uxmlCount: 0, panelSettingsCount: 1, canvasScenes: 1 })).toBe('both');
  });
});
