import type { EditorPreferences } from '../../../types/editor-experience';
import { mergeStoredSettings } from '../../../stores/settings';

/** Retry against the latest native snapshot when another window applies setup. */
export async function loadPreferencesWithMigrations(
  read: () => Promise<EditorPreferences>,
  patch: (settings: Record<string, unknown>, expectedRevision: number) => Promise<EditorPreferences>,
): Promise<EditorPreferences> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const preferences = await read();
    const merged = mergeStoredSettings(preferences.settings);
    const settings = Object.fromEntries(Object.entries(merged).filter(([key, value]) => preferences.settings[key] !== value));
    if (!Object.keys(settings).length) return preferences;
    try { return await patch(settings, preferences.revision); }
    catch (error) {
      if (attempt === 2 || !String(error).includes('Preferences changed in another window')) throw error;
    }
  }
  throw new Error('Preferences changed in another window. Retry setup.');
}
