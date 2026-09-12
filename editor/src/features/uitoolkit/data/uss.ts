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
import { USS_PSEUDO_CLASSES } from '../../../utils/uss-model';

/**
 * Property names offered as completions in `.uss` files.
 *
 * Re-exported from the shared registry — see the note above before adding
 * anything here.
 */
export const USS_PROPERTIES: readonly string[] = USS_PROPERTY_REGISTRY;

/**
 * USS pseudo-classes (state selectors), colon-prefixed for completions.
 *
 * Derived from `uss-model.ts`'s `USS_PSEUDO_CLASSES` rather than listed here:
 * the renderer already has to know the exact set (`:checked` and `:selected`
 * have no DOM equivalent, `:root` becomes `:host` inside a shadow root, and
 * anything else is dropped), and `asset-checks.ts` now reports a pseudo-class
 * outside it. Three copies of one list is two too many.
 */
export const USS_PSEUDO: readonly string[] = [...USS_PSEUDO_CLASSES]
  .sort((a, b) => a.localeCompare(b))
  .map((name) => `:${name}`);
