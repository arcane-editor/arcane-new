import { describe, it, expect } from 'bun:test';
import { USS_PROPERTIES, USS_PSEUDO } from './uss';
import { USS_PROPERTY_REGISTRY, isUssProperty } from '../../../utils/uss-properties';

/**
 * Completions and diagnostics must never disagree about what a USS property is.
 *
 * They did: this module's property list was written for completions and was
 * missing six real properties, so using it as a diagnostic allowlist would have
 * flagged valid USS. Both now read one registry, and this pins that they stay
 * the same object rather than two lists that drift.
 */
describe('USS completion data', () => {
  it('is the shared registry, not a second list', () => {
    expect(USS_PROPERTIES).toBe(USS_PROPERTY_REGISTRY);
  });

  it('offers no completion the diagnostic would then flag as invalid', () => {
    const rejected = USS_PROPERTIES.filter((p) => !isUssProperty(p));
    expect(rejected).toEqual([]);
  });

  it('lists every pseudo-class the renderer has to translate', () => {
    // `:checked`/`:selected` have no DOM equivalent and `:root` matches nothing
    // inside a shadow root, so each of these needs a rewrite rule. If one is
    // added here without one, the preview silently drops the style.
    for (const p of [':hover', ':active', ':focus', ':checked', ':selected', ':disabled', ':root']) {
      expect(USS_PSEUDO).toContain(p);
    }
  });
});
