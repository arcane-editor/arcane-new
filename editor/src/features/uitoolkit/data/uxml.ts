// UXML (UI Toolkit markup) reuses Monaco's `xml` language for highlighting; we
// contribute UI Toolkit element + attribute completions scoped to `.uxml` files.
// Element names use the conventional `ui:` namespace prefix used in authored UXML.
//
// Neither list is maintained here any more. Both used to be hand-written, and
// they had already drifted from `utils/uxml-controls.ts` — the elements list
// carried `ui:VisualTreeAsset`, which is not a tag, and omitted `ui:Scroller`
// and `ui:PopupField`, which are. That is harmless for completions and fatal
// once a diagnostic reads the same knowledge, so both now derive from the
// control table and a property added for one purpose is known to the other.
// `uxml-registry-parity.test.ts` pins that, the same way `uss.ts` is pinned.

import { knownUxmlElementNames, allKnownAttributeNames } from '../../../utils/uxml-controls';

/**
 * Element names offered as completions in `.uxml` files, `ui:`-prefixed.
 *
 * Derived from `UXML_CONTROLS` — see the note above before adding anything here.
 */
export const UXML_ELEMENTS: readonly string[] = knownUxmlElementNames().map((n) => `ui:${n}`);

/**
 * Attribute names offered as completions.
 *
 * The union across every control, because a completion list cannot know which
 * element the caret sits in. `attributesFor(typeName)` is the per-element
 * subset, and is what any CHECK must use.
 */
export const UXML_ATTRIBUTES: readonly string[] = allKnownAttributeNames();
