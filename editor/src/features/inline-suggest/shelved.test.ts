import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '../..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * Ghost-text AI suggestions are shelved, not deleted.
 *
 * The feature module, its services and their tests stay on disk so turning it
 * back on is a matter of restoring the four wiring points below — but nothing
 * user-facing may reach it in the meantime. A half-removed feature is the bad
 * outcome here: a status-bar item that toggles a provider nobody registered,
 * or a settings row and a palette command for a thing that cannot happen.
 *
 * The setting KEY deliberately survives in `stores/settings.ts` and
 * `types/index.ts`. It is persisted per user, and dropping it from the schema
 * would discard whatever they had chosen before it was shelved.
 */
describe('inline suggestions are shelved', () => {
  it('registers no provider, and leaves Monaco nothing to render', () => {
    const panel = read('features/editor/components/EditorPanel.tsx');
    expect(panel).not.toMatch(/registerInlineSuggestProvider/);
    expect(panel).toMatch(/inlineSuggest:\s*\{\s*enabled:\s*false\s*\}/);
  });

  it('shows no status-bar indicator for it', () => {
    const statusBar = read('features/app-shell/components/StatusBar.tsx');
    expect(statusBar).not.toMatch(/InlineSuggestStatusItem/);
  });

  it('offers no palette command that would toggle a dead provider', () => {
    expect(read('App.tsx')).not.toMatch(/ai\.toggleInlineSuggestions/);
  });

  it('offers no settings row for it', () => {
    expect(read('features/settings/data/definitions.ts')).not.toMatch(
      /ai\.inlineSuggestions\.enabled/,
    );
  });

  it('keeps the persisted setting key, so a user choice survives the shelving', () => {
    expect(read('stores/settings.ts')).toMatch(/ai\.inlineSuggestions\.enabled/);
    expect(read('types/index.ts')).toMatch(/ai\.inlineSuggestions\.enabled/);
  });

  it('keeps the module itself intact for the restore', () => {
    expect(read('features/inline-suggest/index.ts')).toMatch(/registerInlineSuggestProvider/);
  });
});
