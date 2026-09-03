import { describe, it, expect } from 'bun:test';
import {
  USS_PROPERTY_REGISTRY,
  USS_PROPERTY_GROUP_ORDER,
  ussPropertyGroup,
  CSS_ONLY_PROPERTIES,
  USS_DEFAULTS,
  isUssProperty,
  ussPropertyRemedy,
} from './uss-properties';

/**
 * The registry is an ALLOWLIST for a diagnostic, which makes its completeness a
 * correctness property rather than a convenience. The list this replaces
 * (`features/uitoolkit/data/uss.ts`) was written for completions and is missing
 * at least six real properties — used as an allowlist it would have flagged
 * valid USS on day one. Every name below was verified against Unity 6's USS
 * property reference; the cases named in the test titles are the ones the old
 * list got wrong.
 */
describe('USS_PROPERTY_REGISTRY', () => {
  it('contains the properties the completion list was missing', () => {
    for (const p of [
      'text-shadow',
      'background-size',
      'background-repeat',
      'background-position',
      'background-position-x',
      'background-position-y',
      'all',
      '-unity-text-outline',
      '-unity-text-outline-color',
      '-unity-text-outline-width',
      '-unity-slice-type',
      '-unity-editor-text-rendering-mode',
      '-unity-text-generator',
    ]) {
      expect(USS_PROPERTY_REGISTRY).toContain(p);
    }
  });

  it('contains the -unity- properties measured in the real corpus', () => {
    // Every `-unity-*` property observed across 193 real .uss files.
    for (const p of [
      '-unity-text-align',
      '-unity-font-style',
      '-unity-font',
      '-unity-font-definition',
      '-unity-background-scale-mode',
      '-unity-background-image-tint-color',
      '-unity-slice-left',
      '-unity-slice-top',
      '-unity-slice-right',
      '-unity-slice-bottom',
      '-unity-slice-scale',
      '-unity-overflow-clip-box',
      '-unity-paragraph-spacing',
    ]) {
      expect(USS_PROPERTY_REGISTRY).toContain(p);
    }
  });

  it('has no duplicates', () => {
    expect(new Set(USS_PROPERTY_REGISTRY).size).toBe(USS_PROPERTY_REGISTRY.length);
  });

  it('keeps every -unity- property observed in the 193-file corpus', () => {
    // These are editor-styling properties Unity serialises into its own USS.
    // They look wrong and are not; omitting them flags Unity's own files.
    for (const p of [
      '-unity-clipping',
      '-unity-content-offset',
      '-unity-extend',
      '-unity-font-color',
      '-unity-image-position',
      '-unity-name',
      '-unity-rich-text',
      '-unity-scaled-backgrounds',
      '-unity-stretch-height',
      '-unity-stretch-width',
      '-unity-text-auto-size',
      '-unity-word-wrap',
    ]) {
      expect(USS_PROPERTY_REGISTRY).toContain(p);
    }
  });
});

describe('isUssProperty', () => {
  it('accepts registry members', () => {
    expect(isUssProperty('flex-direction')).toBe(true);
    expect(isUssProperty('-unity-text-align')).toBe(true);
  });

  it('accepts any custom property — USS supports them and we cannot enumerate them', () => {
    expect(isUssProperty('--my-token')).toBe(true);
    expect(isUssProperty('--anything-at-all')).toBe(true);
  });

  it('is case-insensitive, as CSS identifiers are', () => {
    expect(isUssProperty('Flex-Direction')).toBe(true);
  });

  it('rejects properties Unity silently drops at import', () => {
    expect(isUssProperty('box-shadow')).toBe(false);
    expect(isUssProperty('grid-template-columns')).toBe(false);
    expect(isUssProperty('float')).toBe(false);
  });

  it('rejects nonsense', () => {
    expect(isUssProperty('flex-dirction')).toBe(false);
  });
});

describe('CSS_ONLY_PROPERTIES', () => {
  it('explains what to do instead, not just that it is wrong', () => {
    // A diagnostic that only says "invalid" makes the reader search. These are
    // the properties people actually reach for, so each carries its remedy.
    const shadow = CSS_ONLY_PROPERTIES.get('box-shadow');
    expect(shadow).toBeTruthy();
    expect(shadow!.length).toBeGreaterThan(20);
  });

  it('covers the CSS properties most likely to be typed into a .uss file', () => {
    for (const p of [
      'box-shadow',
      'z-index',
      'float',
      'gap',
      'grid-template-columns',
      'text-transform',
      'font-family',
      'font-weight',
      'line-height',
      'text-decoration',
      'box-sizing',
      'outline',
      'filter',
      'animation',
      'transform',
      'content',
      'pointer-events',
      'user-select',
      'aspect-ratio',
    ]) {
      expect(CSS_ONLY_PROPERTIES.has(p)).toBe(true);
    }
  });

  it('never overlaps the registry — a property cannot be both valid and invalid', () => {
    const registry = new Set(USS_PROPERTY_REGISTRY);
    for (const key of CSS_ONLY_PROPERTIES.keys()) {
      expect(registry.has(key)).toBe(false);
    }
  });

  it('is reachable through ussPropertyRemedy, which also handles unknown names', () => {
    expect(ussPropertyRemedy('box-shadow')).toContain('9-slice');
    expect(ussPropertyRemedy('flex-dirction')).toBe(null);
  });
});

/**
 * The defaults reset is the single highest-leverage part of the renderer: only
 * 298 of 2,501 rules in the real corpus set `flex-direction`, so the other 88%
 * inherit USS's `column` where CSS would give them `row`. Each entry below is
 * pinned by an assertion because getting one wrong silently mislays every
 * preview, and two of them (`min-width`, `position`) also corrupt the overflow
 * diagnostic rather than merely the picture.
 */
describe('USS_DEFAULTS', () => {
  it('flips flex-direction to column — the 88% case', () => {
    expect(USS_DEFAULTS['flex-direction']).toBe('column');
  });

  it('zeroes min-width/min-height: CSS automatic minimum size has no Yoga equivalent', () => {
    // Without this CSS refuses to shrink a flex item below its content, so the
    // preview INVENTS overflow that Unity never produces — which corrupts the
    // overflow diagnostic, not just the render.
    expect(USS_DEFAULTS['min-width']).toBe('0');
    expect(USS_DEFAULTS['min-height']).toBe('0');
  });

  it('sets position: relative — in Yoga every element is a containing block', () => {
    // Reads like a no-op ("relative is the default") and is not: CSS defaults to
    // `static`, so `position: absolute` would resolve against the wrong ancestor.
    expect(USS_DEFAULTS['position']).toBe('relative');
  });

  it('sets box-sizing explicitly — App.css global does not cross the shadow boundary', () => {
    expect(USS_DEFAULTS['box-sizing']).toBe('border-box');
  });

  it('sets white-space: nowrap — Labels do not wrap in UI Toolkit', () => {
    expect(USS_DEFAULTS['white-space']).toBe('nowrap');
  });

  it('sets display: flex — USS has only flex and none', () => {
    expect(USS_DEFAULTS['display']).toBe('flex');
  });

  it('pins flex-shrink to a stated value', () => {
    // Yoga's raw default is 0; Unity's USS documentation states 1. This is a
    // 1-vs-0 difference that changes every constrained-width layout and biases
    // the overflow detector, so it is pinned here and carries a provenance
    // comment in the source. If it turns out wrong, this test fails loudly and
    // the fix is one line.
    expect(USS_DEFAULTS['flex-shrink']).toBe('1');
  });
});

describe('ussPropertyGroup', () => {
  it('files the flex family under Layout, together', () => {
    for (const p of ['flex-direction', 'align-items', 'justify-content', 'flex-grow']) {
      expect(ussPropertyGroup(p)).toBe('Layout');
    }
  });

  it('counts spacing and size as Layout, because that is what they decide', () => {
    for (const p of ['margin-bottom', 'padding', 'width', 'min-height', 'position', 'top']) {
      expect(ussPropertyGroup(p)).toBe('Layout');
    }
  });

  it('separates text from paint', () => {
    expect(ussPropertyGroup('color')).toBe('Text');
    expect(ussPropertyGroup('font-size')).toBe('Text');
    expect(ussPropertyGroup('-unity-text-align')).toBe('Text');
    expect(ussPropertyGroup('-unity-font-style')).toBe('Text');
    expect(ussPropertyGroup('background-color')).toBe('Appearance');
    expect(ussPropertyGroup('border-width')).toBe('Appearance');
    expect(ussPropertyGroup('opacity')).toBe('Appearance');
  });

  it('does not let a prefix steal a longer exact match', () => {
    // `overflow` is Layout and `text-overflow` is Text; a naive prefix scan
    // files both under whichever rule it happens to reach first.
    expect(ussPropertyGroup('overflow')).toBe('Layout');
    expect(ussPropertyGroup('text-overflow')).toBe('Text');
    expect(ussPropertyGroup('-unity-overflow-clip-box')).toBe('Appearance');
  });

  it('groups animation properties as Motion', () => {
    for (const p of ['transition-duration', 'translate', 'rotate', 'scale', 'transform-origin']) {
      expect(ussPropertyGroup(p)).toBe('Motion');
    }
  });

  it('files an unknown property rather than dropping it', () => {
    // A property the panel silently omitted would be worse than one filed
    // imprecisely — the author would never learn it was there.
    expect(ussPropertyGroup('box-shadow')).toBe('Appearance');
    expect(ussPropertyGroup('-unity-name')).toBe('Appearance');
    expect(ussPropertyGroup('MARGIN-TOP')).toBe('Layout');
  });

  it('assigns every registry property a group', () => {
    for (const p of USS_PROPERTY_REGISTRY) {
      expect(USS_PROPERTY_GROUP_ORDER).toContain(ussPropertyGroup(p));
    }
  });
});
