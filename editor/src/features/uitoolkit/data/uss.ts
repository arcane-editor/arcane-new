// USS data for Monaco: the property list for completions, and the pseudo-class
// list for state selectors.
//
// The property list is NOT maintained here any more. It used to be a
// hand-written completion convenience, and by the time a diagnostic needed to
// read it, it was missing `text-shadow`, `background-size`, `background-repeat`,
// `all`, `-unity-text-outline` and `-unity-slice-type`, among others. That is
// harmless for completions and fatal for an allowlist, so both now read one
// registry in `utils/uss-properties.ts` and a property added for one purpose is
// automatically known to the other. `uss-registry-parity.test.ts` pins that.

import { USS_PROPERTY_REGISTRY } from '../../../utils/uss-properties';

/**
 * Property names offered as completions in `.uss` files.
 *
 * Re-exported from the shared registry — see the note above before adding
 * anything here.
 */
export const USS_PROPERTIES: readonly string[] = USS_PROPERTY_REGISTRY;

/**
 * USS pseudo-classes (state selectors).
 *
 * Kept local: these are selector syntax rather than properties, nothing
 * validates against them, and the renderer needs its own mapping for them
 * anyway (`:checked` and `:selected` have no DOM equivalent, and `:root` has to
 * become `:host` inside a shadow root).
 */
export const USS_PSEUDO: string[] = [
  ':hover', ':active', ':focus', ':selected', ':disabled', ':enabled',
  ':checked', ':root', ':inactive',
];
