import type {
  ApplyEditorPreferencesRequest, EditorPreferences, EditorProfile,
  ImportCategory, ImportPreview, RiderKeymap,
} from '../../../types/editor-experience';
import { getPresetKeybindingReport } from './keymaps';
import { profileDefaults, selectedPreferencePatch } from './profile-defaults';

/** Build one atomic change while retaining every unselected preference category. */
export function buildApplyProfileRequest(
  preferences: EditorPreferences,
  profile: EditorProfile,
  keymap: RiderKeymap,
  preview: ImportPreview | null,
  categories: ImportCategory[],
  mac: boolean,
): ApplyEditorPreferencesRequest {
  const defaults = profileDefaults(profile, mac);
  const shortcuts = categories.includes('shortcuts');
  return {
    expectedRevision: preferences.revision,
    profile,
    shortcutProfile: shortcuts ? profile : preferences.experience.shortcutProfile ?? preferences.experience.profile,
    keymap: shortcuts ? keymap : preferences.experience.keymap,
    themeId: categories.includes('appearance') ? preview?.themeId ?? defaults.themeId : undefined,
    settingsPatch: selectedPreferencePatch(defaults.settings, preview?.settings ?? {}, categories),
    importedBindings: shortcuts ? preview?.keybindings ?? [] : preferences.experience.importedBindings,
    userBindings: preferences.experience.userBindings,
    setupStatus: 'complete',
    report: [
      ...(preview?.report ?? []).filter((item) => categories.includes(item.category)),
      ...(shortcuts ? getPresetKeybindingReport(profile, keymap, mac) : []),
    ],
    sourceLabel: preview?.source.label,
  };
}
