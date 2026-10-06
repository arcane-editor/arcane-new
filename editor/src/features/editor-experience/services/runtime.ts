import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listenScoped } from '../../../utils/tauri-listener';
import { loadRecentProjects, loadState } from '../../../utils/persistence';
import { publishPreferences } from '../../../utils/preferences-events';
import { useEditorExperienceStore } from '../../../stores/editor-experience';
import { useCommandsStore } from '../../../stores/commands';
import { resolveThemeId } from '../../theme';
import { isMac } from '../../../utils/platform';
import type { EditorPreferences, BindingContext } from '../../../types/editor-experience';
import { resolveKeybindings } from './keybindings';
import { loadPreferencesWithMigrations } from './load-preferences';
import { nativeMenuBindingsForContext } from '../../../utils/editor-keybindings';

let initialized: Promise<void> | null = null;
let menuQueue = Promise.resolve();
let storeObserversInstalled = false;
let preferencesUnlisten: (() => void) | null = null;
let focusUnlisten: (() => void) | null = null;

function syncKeybindings(): void {
  const preferences = useEditorExperienceStore.getState().preferences;
  if (!preferences) return;
  const commands = useCommandsStore.getState();
  const bindings = resolveKeybindings(commands.getBaseCommands(), preferences.experience, isMac());
  commands.setResolvedKeybindings(bindings);
  syncNativeMenu(bindings);
}

function syncNativeMenu(bindings = useCommandsStore.getState().resolvedBindings): void {
  if (isMac()) {
    menuQueue = menuQueue.catch(() => {}).then(async () => {
      if (!(await getCurrentWindow().isFocused())) return;
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const context: BindingContext = active?.closest('.terminal-xterm') ? 'terminal' : active?.closest('.monaco-editor') ? 'editor'
        : active?.closest('input,textarea,select,[contenteditable="true"]') ? 'input' : 'global';
      const suppressAppShortcuts = !!active?.closest('.find-widget') || !!document.querySelector('.experience-startup,.experience-overlay');
      await invoke('update_menu_keybindings', { bindings: nativeMenuBindingsForContext(bindings, { context, suppressAppShortcuts }, isMac()) });
    }).catch((error) => console.warn('[Editor experience] Native shortcuts could not be synchronized:', error));
  }
}

/** Runs once in each webview, before either app surface mounts. */
export function initializeEditorExperience(): Promise<void> {
  initialized ??= (async () => {
    if (!storeObserversInstalled) {
      useCommandsStore.subscribe((state, previous) => {
        if (state.baseCommands !== previous.baseCommands) syncKeybindings();
      });
      useEditorExperienceStore.subscribe((state, previous) => {
        if (state.preferences?.experience !== previous.preferences?.experience) syncKeybindings();
      });
      storeObserversInstalled = true;
      document.addEventListener('focusin', () => syncNativeMenu());
      document.addEventListener('focusout', () => queueMicrotask(() => syncNativeMenu()));
    }
    preferencesUnlisten ??= await listenScoped<EditorPreferences>('editor-preferences-changed', (event) => publishPreferences(event.payload));
    // Menus are app-wide; refresh from the focused window as its context changes.
    focusUnlisten ??= await getCurrentWindow().onFocusChanged(({ payload }) => {
      if (payload) syncKeybindings();
    });

    let legacyThemeId: string | null = null;
    try {
      const stored = localStorage.getItem('editor-theme-id-v2');
      legacyThemeId = stored ? resolveThemeId(stored) : null;
    } catch { /* preferences can still load without webview storage */ }
    const legacyEstablished = legacyThemeId !== null || loadRecentProjects().length > 0 || !!loadState()?.workspacePath;
    // Preserve the existing one-time settings migrations and seed new defaults
    // only after Rust captured fresh-versus-upgrade state. A revision guard
    // prevents a delayed second window from overwriting the first window's import.
    const preferences = await loadPreferencesWithMigrations(
      () => invoke<EditorPreferences>('read_editor_preferences', { legacyThemeId, legacyEstablished }),
      (patch, expectedRevision) => invoke<EditorPreferences>('patch_editor_settings', { patch, expectedRevision }),
    );
    publishPreferences(preferences);
  })().catch((error) => {
    initialized = null;
    useEditorExperienceStore.setState({ error: String(error) });
    throw error;
  });
  return initialized;
}
