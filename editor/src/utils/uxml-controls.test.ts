import { describe, it, expect } from 'bun:test';
import {
  typeChainFor,
  generatedUssClasses,
  isBuiltinControl,
  isBuiltinPartName,
  UXML_CONTROLS,
} from './uxml-controls';

describe('typeChainFor', () => {
  it('ends every chain at VisualElement, which is what makes VisualElement {} match everything', () => {
    for (const control of UXML_CONTROLS) {
      expect(control.typeChain[control.typeChain.length - 1]).toBe('VisualElement');
    }
  });

  it('puts the most-derived type first', () => {
    expect(typeChainFor('Button')[0]).toBe('Button');
    expect(typeChainFor('Button')).toContain('TextElement');
    expect(typeChainFor('Button')).toContain('VisualElement');
  });

  it('models the field hierarchy that Unity own USS targets', () => {
    // `.unity-base-field` appears 63 times in Unity's stylesheets; a Toggle that
    // does not know it is a BaseField renders unstyled.
    expect(typeChainFor('Toggle')).toContain('BaseField');
    expect(typeChainFor('TextField')).toContain('BaseField');
    expect(typeChainFor('Slider')).toContain('BaseField');
  });

  it('gives a custom control the honest floor rather than guessing', () => {
    // We cannot see a third-party control's C#, so we claim only what is
    // certainly true: everything in a visual tree derives from VisualElement.
    expect(typeChainFor('ResizableElement')).toEqual(['ResizableElement', 'VisualElement']);
    expect(isBuiltinControl('ResizableElement')).toBe(false);
  });

  it('does not duplicate VisualElement when asked for it directly', () => {
    expect(typeChainFor('VisualElement')).toEqual(['VisualElement']);
  });
});

describe('generatedUssClasses', () => {
  it('returns the classes Unity constructor adds, which authored UXML never lists', () => {
    expect(generatedUssClasses('Button')).toContain('unity-button');
    expect(generatedUssClasses('Toggle')).toContain('unity-base-field');
  });

  it('returns nothing for an unknown control rather than inventing a class', () => {
    expect(generatedUssClasses('ResizableElement')).toEqual([]);
  });
});

/**
 * The false-positive floor for the query check.
 *
 * Measured over 12,898 real C# files: 208 distinct literal names are queried,
 * 21 exist in no `.uxml`, and every one of those 21 is a name a built-in
 * control gives itself in C#. Without this rung the checker flags valid code
 * about 10% of the time.
 */
describe('isBuiltinPartName', () => {
  it('suppresses the exact names the corpus proved were false positives', () => {
    expect(isBuiltinPartName('unity-content-container')).toBe(true);
    expect(isBuiltinPartName('unity-checkmark')).toBe(true);
    expect(isBuiltinPartName('unity-drag-container')).toBe(true);
  });

  it('suppresses the whole unity- prefix, which Unity reserves', () => {
    expect(isBuiltinPartName('unity-something-not-yet-invented')).toBe(true);
  });

  it('does not suppress an ordinary authored name', () => {
    expect(isBuiltinPartName('play-button')).toBe(false);
    expect(isBuiltinPartName('menu-card')).toBe(false);
    // Close to the prefix but not it — must still be checked.
    expect(isBuiltinPartName('unityish-thing')).toBe(false);
  });
});
