import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { SettingsSchema } from '../types';

const DEFAULT_SETTINGS: SettingsSchema = {
  'editor.fontSize': 14,
  'editor.tabSize': 2,
  'editor.wordWrap': 'off',
  'editor.minimap': true,
  'editor.lineNumbers': 'on',
  'editor.cursorBlinking': 'blink',
  'editor.bracketPairColorization': true,
  'editor.renderWhitespace': 'none',
  'editor.autoSave': 'off',
  'editor.autoSaveDelay': 1000,
  'editor.betterComments': true,
  'terminal.fontSize': 13,
  'terminal.fontFamily': "ui-monospace, SFMono-Regular, Menlo, Monaco, 'Cascadia Mono', 'Courier New', monospace",
  'terminal.cursorBlink': true,
  'graphify.autoRebuildOnSave': false,
  'graphify.rebuildOnCommit': false,
  'graphify.suppressFirstOpenToast': false,
  'ai.checkpoints.enabled': true,
  'ai.escalation.enabled': true,
  'ai.edits.applyMode': 'auto',
  'ai.edits.alwaysApproveUnityAssets': true,
  'ai.inlineSuggestions.enabled': true,
  'ui.coachMarks.enabled': true,
  'unity.analyzers.enabled': true,
  'unity.compileGate.enabled': true,
  'unity.lspGate.enabled': true,
  'unity.verifiedPass.enabled': true,
  'unity.nearMissDiagnostics.enabled': true,
  'unity.rename.formerlySerializedAs': true,
  'unity.serializationDiagnostics.enabled': true,
  'unity.asmdef.diagnostics': true,
  'unity.bridge.enabled': true,
  'unity.bridge.refreshOnSave': true,
  'unity.telemetry.enabled': false,
  'unity.hierarchyPanel.enabled': true,
  'unity.assetViewer.structuredDefault': true,
  'unity.sceneDiff.enabled': true,
  'unity.codeLens.assetUsages': true,
  'unity.templates.enabled': true,
  'unity.docs.versionMatchedHover': true,
  'unity.explorer.assetsFirst': false,
  'unity.explorer.hideMeta': true,
  'explorer.autoReveal': true,
  'project.rootBanner.dismissed': [],
  'unity.git.metaPairingChecks': true,
  'unity.git.yamlMergeIntegration': true,
  'unity.testRunner.enabled': true,
  'unity.debugger.enabled': true,
  'unity.shader.completions': true,
  'unity.packages.manifestIntelligence': true,
  'unity.index.enabled': true,
  'search.contextLines': 2,
  'search.seedQueryFromCursor': 'selection',
  'search.useSmartcase': true,
};

interface SettingsState {
  settings: SettingsSchema;
  isLoaded: boolean;
  loadSettings: () => Promise<void>;
  getSetting: <K extends keyof SettingsSchema>(key: K) => SettingsSchema[K];
  setSetting: <K extends keyof SettingsSchema>(key: K, value: SettingsSchema[K]) => void;
  resetSetting: <K extends keyof SettingsSchema>(key: K) => void;
  resetAllSettings: () => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: { ...DEFAULT_SETTINGS },
  isLoaded: false,

  loadSettings: async () => {
    try {
      const stored = await invoke<Record<string, unknown>>('read_settings');
      const merged = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
      for (const [key, value] of Object.entries(stored)) {
        if (key in DEFAULT_SETTINGS) merged[key] = value;
      }
      // Migration: any stored value referencing a font that's a webfont
      // (Geist Mono Variable) or commonly missing on macOS (Cascadia Code,
      // Source Code Pro, JetBrains Mono) makes xterm measure the wrong cell
      // width and renders the prompt as "c o n t e n t". Force-reset to the
      // system default in those cases.
      const storedFont = (merged['terminal.fontFamily'] as string) ?? '';
      const looksProblematic =
        storedFont === '' ||
        /Geist/i.test(storedFont) ||
        /Cascadia Code\b/i.test(storedFont) ||
        /Source Code Pro/i.test(storedFont) ||
        /JetBrains Mono/i.test(storedFont) ||
        /Fira Code/i.test(storedFont);
      if (looksProblematic) {
        merged['terminal.fontFamily'] = DEFAULT_SETTINGS['terminal.fontFamily'];
        invoke('write_settings', { settings: merged }).catch(() => {});
      }
      set({ settings: merged as unknown as SettingsSchema, isLoaded: true });
    } catch {
      set({ isLoaded: true });
    }
  },

  getSetting: (key) => get().settings[key],

  setSetting: (key, value) => {
    const next = { ...get().settings, [key]: value };
    set({ settings: next });
    invoke('write_settings', { settings: next }).catch(console.warn);
  },

  resetSetting: (key) => {
    const next = { ...get().settings, [key]: DEFAULT_SETTINGS[key] };
    set({ settings: next });
    invoke('write_settings', { settings: next }).catch(() => {});
  },

  resetAllSettings: () => {
    set({ settings: { ...DEFAULT_SETTINGS } });
    invoke('write_settings', { settings: DEFAULT_SETTINGS }).catch(() => {});
  },
}));

export { DEFAULT_SETTINGS };
