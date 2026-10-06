import { create } from 'zustand';
import { getTheme, getAllThemes, DEFAULT_THEME_ID, resolveThemeId, applyTheme, applyCssVariables } from '../features/theme';
import type { ThemeDefinition } from '../features/theme';
import { invoke } from '@tauri-apps/api/core';
import type { EditorPreferences } from '../types/editor-experience';
import { publishPreferences, subscribePreferences } from '../utils/preferences-events';

const STORAGE_KEY = 'editor-theme-id-v2';

function loadPersistedThemeId(): string {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return DEFAULT_THEME_ID;
    // Map a pre-rename id forward before the registry lookup. Skipping this
    // makes an old id simply unknown, and the fallthrough below would then
    // switch a light-theme user to dark with no explanation.
    const resolved = resolveThemeId(stored);
    if (getTheme(resolved)) {
      if (resolved !== stored) persistThemeId(resolved);
      return resolved;
    }
  } catch { /* ignore */ }
  return DEFAULT_THEME_ID;
}

function persistThemeId(id: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch { /* ignore */ }
}

interface ThemeState {
  activeThemeId: string;
  setTheme: (id: string) => void;
  previewTheme: (id: string) => void;
  revertPreview: () => void;
  getActiveTheme: () => ThemeDefinition;
  getAvailableThemes: () => ThemeDefinition[];
}

let confirmedThemeId: string = loadPersistedThemeId();

export const useThemeStore = create<ThemeState>((set, get) => ({
  activeThemeId: confirmedThemeId,

  setTheme: (id: string) => {
    const theme = getTheme(id);
    if (!theme) return;
    confirmedThemeId = id;
    persistThemeId(id);
    set({ activeThemeId: id });
    applyTheme(theme);
    invoke<EditorPreferences>('patch_editor_theme', { themeId: id }).then(publishPreferences).catch(console.warn);
  },

  previewTheme: (id: string) => {
    const theme = getTheme(id);
    if (!theme) return;
    set({ activeThemeId: id });
    applyTheme(theme);
  },

  revertPreview: () => {
    const theme = getTheme(confirmedThemeId);
    if (!theme) return;
    set({ activeThemeId: confirmedThemeId });
    applyTheme(theme);
  },

  getActiveTheme: () => {
    return getTheme(get().activeThemeId) ?? getTheme(DEFAULT_THEME_ID)!;
  },

  getAvailableThemes: () => {
    return getAllThemes();
  },
}));

subscribePreferences((preferences) => {
  const id = resolveThemeId(preferences.themeId);
  const theme = getTheme(id);
  if (!theme || id === confirmedThemeId) return;
  confirmedThemeId = id;
  persistThemeId(id);
  useThemeStore.setState({ activeThemeId: id });
  applyTheme(theme);
});

// Eagerly apply CSS variables at module scope to prevent FOUC
const initialTheme = getTheme(loadPersistedThemeId());
if (initialTheme) {
  applyCssVariables(initialTheme);
}
