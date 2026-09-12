import { describe, it, expect } from 'bun:test';
import { UXML_ELEMENTS, UXML_ATTRIBUTES } from './uxml';
import {
  UXML_CONTROLS,
  UXML_METADATA_ELEMENTS,
  attributesFor,
  isKnownUxmlElement,
} from '../../../utils/uxml-controls';

/**
 * Completions and diagnostics must never disagree about what a UXML tag is.
 *
 * They did. This module kept a second, hand-written list: it carried
 * `ui:VisualTreeAsset`, which is not a tag at all, and omitted `ui:Scroller`
 * and `ui:PopupField`, which are. Harmless while it only fed a completion
 * dropdown; wrong the moment `asset-checks.ts` started refusing writes over
 * unknown element names. Both now derive from `UXML_CONTROLS`.
 */
describe('UXML completion data', () => {
  it('offers no element the element check would then reject', () => {
    const rejected = UXML_ELEMENTS.filter((e) => !isKnownUxmlElement(e.replace(/^ui:/, '')));
    expect(rejected).toEqual([]);
  });

  it('offers every control in the table, plus the two metadata tags', () => {
    const offered = new Set(UXML_ELEMENTS.map((e) => e.replace(/^ui:/, '')));
    for (const control of UXML_CONTROLS) expect(offered.has(control.typeName)).toBe(true);
    for (const meta of UXML_METADATA_ELEMENTS) expect(offered.has(meta)).toBe(true);
  });

  it('prefixes every element with the `ui:` namespace authored UXML uses', () => {
    expect(UXML_ELEMENTS.every((e) => e.startsWith('ui:'))).toBe(true);
  });

  it('offers no attribute that no control accepts', () => {
    // The completion list is the union across controls, so every entry has to
    // be reachable from at least one of them — otherwise it is a name that was
    // invented here and would be flagged wherever it was actually used.
    const everyElement = [...UXML_CONTROLS.map((c) => c.typeName), ...UXML_METADATA_ELEMENTS];
    const orphans = UXML_ATTRIBUTES.filter(
      (attr) => !everyElement.some((name) => attributesFor(name)?.has(attr)),
    );
    expect(orphans).toEqual([]);
  });

  it('still offers the everyday attributes, so the refactor did not thin the list out', () => {
    for (const attr of ['name', 'class', 'style', 'text', 'value', 'label', 'tooltip', 'src', 'template']) {
      expect(UXML_ATTRIBUTES).toContain(attr);
    }
  });
});
