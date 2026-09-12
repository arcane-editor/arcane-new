// Pure name-helper logic, tested directly. `fieldNameFor` in particular pins
// a real bug found during self-review: a bare "does the camelCased name
// already end with the type's own name" check produced
// `qualityDropdownDropdownField` for `DropdownField` and would have produced
// `hpBarProgressBar` for `ProgressBar` — both technically de-duped nothing,
// because the element's kebab suffix ("dropdown", "bar") reads as the type
// without ever spelling out the C# type name itself.

import { describe, it, expect } from 'bun:test';
import { kebabPrefix, fieldNameFor } from './shared';

describe('kebabPrefix', () => {
  it('converts PascalCase to kebab-case', () => {
    expect(kebabPrefix('MainMenu')).toBe('main-menu');
    expect(kebabPrefix('Dialog')).toBe('dialog');
    expect(kebabPrefix('Settings')).toBe('settings');
    expect(kebabPrefix('Inventory')).toBe('inventory');
  });

  it('lowercases an all-caps acronym without inserting hyphens (matches fixtures/uitoolkit/HUD.uxml\'s hud-* naming)', () => {
    expect(kebabPrefix('HUD')).toBe('hud');
  });

  it('handles a mixed acronym+word boundary', () => {
    expect(kebabPrefix('HUDOverlay')).toBe('hud-overlay');
  });
});

describe('fieldNameFor — de-duping the C# type suffix', () => {
  it('drops the type suffix when the element name already ends with it verbatim', () => {
    expect(fieldNameFor('main-menu-play-button', 'main-menu', 'Button')).toBe('playButton');
  });

  it('recognises "dropdown" as already implying DropdownField, instead of doubling the suffix', () => {
    expect(fieldNameFor('settings-quality-dropdown', 'settings', 'DropdownField')).toBe('qualityDropdown');
  });

  it('recognises "bar" as already implying ProgressBar', () => {
    expect(fieldNameFor('hud-hp-bar', 'hud', 'ProgressBar')).toBe('hpBar');
  });

  it('recognises "value"/"text" as already implying Label', () => {
    expect(fieldNameFor('hud-hp-value', 'hud', 'Label')).toBe('hpValue');
    expect(fieldNameFor('hud-objective-text', 'hud', 'Label')).toBe('objectiveText');
  });

  it('appends the type when nothing in the name implies it', () => {
    expect(fieldNameFor('inventory-detail-description', 'inventory', 'Label')).toBe('detailDescriptionLabel');
  });

  it('never appends VisualElement — plain containers stay unsuffixed', () => {
    expect(fieldNameFor('hud-topbar', 'hud', 'VisualElement')).toBe('topbar');
  });

  it('strips only a matching prefix, camelCasing the rest', () => {
    expect(fieldNameFor('dialog-confirm-button', 'dialog', 'Button')).toBe('confirmButton');
  });
});
