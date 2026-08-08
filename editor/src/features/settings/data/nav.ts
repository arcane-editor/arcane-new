/**
 * Navigation and search for the settings modal.
 *
 * Pure functions over the catalogue, so the left-hand rail and the search
 * results are derived rather than maintained by hand — adding a setting with a
 * new `category` makes the nav entry appear on its own.
 */

import type { SettingDefinition } from './definitions';

/**
 * Section id for the account pane.
 *
 * Not a `category` on any setting: the account pane is not a list of
 * preferences, so it is a sibling of the categories rather than one of them.
 * Prefixed to keep it out of the namespace a future category could occupy.
 */
export const ACCOUNT_SECTION = '@account';

/** Distinct categories, in the order they first appear in the catalogue. */
export function categoriesOf(definitions: SettingDefinition[]): string[] {
  return [...new Set(definitions.map((d) => d.category))];
}

/**
 * Settings matching `query`, across label, description, key and category.
 *
 * Category is included so searching "unity" surfaces the whole group, which is
 * how people look for a setting they can only half-remember.
 */
export function filterSettings(
  definitions: SettingDefinition[],
  query: string,
): SettingDefinition[] {
  const q = query.trim().toLowerCase();
  if (!q) return definitions;

  return definitions.filter(
    (d) =>
      d.label.toLowerCase().includes(q) ||
      d.description.toLowerCase().includes(q) ||
      d.key.toLowerCase().includes(q) ||
      d.category.toLowerCase().includes(q),
  );
}

/**
 * Whether a section id corresponds to something renderable.
 *
 * The section is a free-form string — it comes from the ui store's default,
 * from `openSettings(section)` callers, and from nav clicks. Only nav clicks
 * are guaranteed to name a live category, so this is checked before use rather
 * than trusting the caller and rendering a blank pane.
 */
export function isKnownSection(section: string, categories: string[]): boolean {
  return section === ACCOUNT_SECTION || categories.includes(section);
}
