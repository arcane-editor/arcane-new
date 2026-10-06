import { expect, it } from 'bun:test';
import type { EditorPreferences } from '../../../types/editor-experience';
import { DEFAULT_SETTINGS } from '../../../stores/settings';
import { loadPreferencesWithMigrations } from './load-preferences';

it('recomputes startup defaults after a concurrent import and retains imported typography', async () => {
  let reads = 0;
  const patches: Array<{ settings: Record<string, unknown>; revision: number }> = [];
  const imported = { revision: 2, settings: { ...DEFAULT_SETTINGS, 'editor.fontFamily': 'Studio Mono', 'editor.fontSize': 20 } } as unknown as EditorPreferences;
  const result = await loadPreferencesWithMigrations(
    async () => ++reads === 1 ? { revision: 0, settings: {} } as EditorPreferences : imported,
    async (settings, revision) => { patches.push({ settings, revision }); throw new Error('Preferences changed in another window. Review the latest settings and try again.'); },
  );
  expect(reads).toBe(2);
  expect(patches).toHaveLength(1);
  expect(patches[0].revision).toBe(0);
  expect(result.settings['editor.fontFamily']).toBe('Studio Mono');
  expect(result.settings['editor.fontSize']).toBe(20);
});

it('propagates unreadable or unwritable preferences rather than replacing them with defaults', async () => {
  await expect(loadPreferencesWithMigrations(async () => { throw new Error('Unreadable preferences'); }, async () => { throw new Error('Must not write'); })).rejects.toThrow('Unreadable preferences');
  await expect(loadPreferencesWithMigrations(async () => ({ revision: 0, settings: {} } as EditorPreferences), async () => { throw new Error('Disk full'); })).rejects.toThrow('Disk full');
});
