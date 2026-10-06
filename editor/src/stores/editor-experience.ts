import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { EditorPreferences, EditorProfile, ImportCategory, ImportPreview, ImportSource, RiderKeymap, ApplyEditorPreferencesRequest, KeyBinding } from '../types/editor-experience';
import { publishPreferences, subscribePreferences } from '../utils/preferences-events';
import { isMac } from '../utils/platform';
import { localFontAvailable } from '../utils/local-font';
import { buildApplyProfileRequest } from '../features/editor-experience';

interface ExperienceStore {
  preferences: EditorPreferences | null;
  error: string | null;
  refresh: () => Promise<void>;
  discover: (editor: 'rider' | 'vscode', customPath?: string) => Promise<ImportSource[]>;
  preview: (source: ImportSource) => Promise<ImportPreview>;
  applyProfile: (profile: EditorProfile, keymap: RiderKeymap, preview: ImportPreview | null, categories: ImportCategory[]) => Promise<void>;
  dismissSetup: () => Promise<void>;
  restore: () => Promise<void>;
  setUserBinding: (commandId: string, binding: KeyBinding | null) => Promise<void>;
}

async function apply(request: ApplyEditorPreferencesRequest): Promise<void> {
  try {
    publishPreferences(await invoke<EditorPreferences>('apply_editor_preferences', { request }));
    useEditorExperienceStore.setState({ error: null });
  } catch (error) {
    useEditorExperienceStore.setState({ error: String(error) });
    throw error;
  }
}

function current(): EditorPreferences {
  const preferences = useEditorExperienceStore.getState().preferences;
  if (!preferences) throw new Error('Preferences could not be loaded. Retry before changing your editor experience.');
  return preferences;
}

export const useEditorExperienceStore = create<ExperienceStore>((set) => ({
  preferences: null,
  error: null,
  refresh: async () => {
    try {
      publishPreferences(await invoke<EditorPreferences>('read_editor_preferences'));
      set({ error: null });
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },
  discover: (editor, customPath) => invoke<ImportSource[]>('discover_editor_sources', { editor, customPath: customPath ?? null }),
  preview: async (source) => {
    const preview = await invoke<ImportPreview>('preview_editor_import', { source });
    if (typeof document !== 'undefined') await document.fonts.ready;
    for (const key of ['editor.fontFamily', 'terminal.fontFamily']) {
      const family = preview.settings[key];
      if (typeof family === 'string' && localFontAvailable(family) === false) {
        preview.report.push({ category: 'appearance', label: key, status: 'approximated', detail: 'The first font in this stack is not available locally. UnityIDE will use the next installed font or system monospace.' });
      }
    }
    return preview;
  },
  applyProfile: async (profile, keymap, preview, categories) => {
    await apply(buildApplyProfileRequest(current(), profile, keymap, preview, categories, isMac()));
  },
  dismissSetup: async () => {
    const preferences = current();
    await apply({ expectedRevision: preferences.revision, profile: preferences.experience.profile,
      keymap: preferences.experience.keymap, settingsPatch: {}, setupStatus: 'dismissed' });
  },
  restore: async () => {
    const preferences = current();
    publishPreferences(await invoke<EditorPreferences>('restore_editor_preferences', { expectedRevision: preferences.revision }));
  },
  setUserBinding: async (commandId, binding) => {
    const preferences = current();
    await apply({ expectedRevision: preferences.revision, profile: preferences.experience.profile,
      keymap: preferences.experience.keymap, settingsPatch: {}, setupStatus: 'complete',
      userBindings: preferences.experience.userBindings.filter((item) => item.commandId !== commandId).concat(binding ? [binding] : []),
    });
  },
}));

subscribePreferences((preferences) => {
  useEditorExperienceStore.setState({ preferences, error: null });
});
