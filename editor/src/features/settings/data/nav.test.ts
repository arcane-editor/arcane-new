import { describe, expect, it } from 'bun:test';
import { ACCOUNT_SECTION, categoriesOf, filterSettings, isKnownSection } from './nav';
import { SETTING_DEFINITIONS } from './definitions';

describe('categoriesOf', () => {
  it('lists each category once, in first-appearance order', () => {
    const cats = categoriesOf(SETTING_DEFINITIONS);
    expect(cats).toEqual([...new Set(SETTING_DEFINITIONS.map((d) => d.category))]);
    expect(cats.length).toBe(new Set(cats).size);
  });

  it('covers every definition, so no setting is unreachable from the nav', () => {
    const cats = new Set(categoriesOf(SETTING_DEFINITIONS));
    const orphans = SETTING_DEFINITIONS.filter((d) => !cats.has(d.category));
    expect(orphans).toEqual([]);
  });

  it('returns nothing for an empty catalogue', () => {
    expect(categoriesOf([])).toEqual([]);
  });
});

describe('filterSettings', () => {
  it('returns everything for an empty or whitespace query', () => {
    expect(filterSettings(SETTING_DEFINITIONS, '')).toHaveLength(SETTING_DEFINITIONS.length);
    expect(filterSettings(SETTING_DEFINITIONS, '   ')).toHaveLength(SETTING_DEFINITIONS.length);
  });

  it('matches on label, description and key', () => {
    expect(filterSettings(SETTING_DEFINITIONS, 'Minimap').map((d) => d.key)).toContain(
      'editor.minimap',
    );
    // Description-only term.
    expect(filterSettings(SETTING_DEFINITIONS, 'ghost-text').map((d) => d.key)).toContain(
      'ai.inlineSuggestions.enabled',
    );
    // Dotted key.
    expect(filterSettings(SETTING_DEFINITIONS, 'terminal.font').map((d) => d.key)).toContain(
      'terminal.fontSize',
    );
  });

  it('is case-insensitive', () => {
    expect(filterSettings(SETTING_DEFINITIONS, 'MINIMAP')).toEqual(
      filterSettings(SETTING_DEFINITIONS, 'minimap'),
    );
  });

  it('matches the category name too, so "unity" finds Unity settings', () => {
    const hits = filterSettings(SETTING_DEFINITIONS, 'unity');
    expect(hits.length).toBeGreaterThan(10);
  });

  it('returns nothing for a query that matches nothing', () => {
    expect(filterSettings(SETTING_DEFINITIONS, 'zzzz-no-such-setting')).toEqual([]);
  });
});

describe('isKnownSection', () => {
  const cats = categoriesOf(SETTING_DEFINITIONS);

  it('accepts the account section and every real category', () => {
    expect(isKnownSection(ACCOUNT_SECTION, cats)).toBe(true);
    for (const c of cats) expect(isKnownSection(c, cats)).toBe(true);
  });

  it('rejects a section that names nothing, so the pane cannot render blank', () => {
    // Section ids reach the modal from the store default and from
    // `openSettings(section)` callers, neither of which is checked at the
    // call site.
    expect(isKnownSection('Telepathy', cats)).toBe(false);
    expect(isKnownSection('', cats)).toBe(false);
  });
});
