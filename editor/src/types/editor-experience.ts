export type EditorProfile = 'unityide' | 'rider' | 'vscode';
export type RiderKeymap = 'intellij' | 'visual-studio' | 'visual-studio-2022' | 'resharper' | 'vscode';
export type BindingContext = 'global' | 'editor' | 'terminal' | 'input';

/** Exact modifiers; each stroke is e.g. `ctrl+k`, never an OS-ambiguous alias. */
export interface KeyBinding {
  commandId: string;
  strokes: string[];
  context?: BindingContext;
  removed?: boolean;
}

export type ImportCategory = 'appearance' | 'editor' | 'shortcuts';
export interface ImportReportItem {
  category: ImportCategory;
  label: string;
  status: 'imported' | 'approximated' | 'unsupported' | 'conflicting';
  detail: string;
}

export interface ImportSource {
  id: string;
  editor: 'rider' | 'vscode';
  label: string;
  path: string;
  recommended: boolean;
  version?: string;
  profilePath?: string;
  settingsPath?: string;
  keybindingsPath?: string;
}

export interface ImportPreview {
  source: ImportSource;
  settings: Record<string, unknown>;
  themeId?: string;
  keymap?: RiderKeymap;
  keybindings: KeyBinding[];
  report: ImportReportItem[];
}

export interface EditorExperienceState {
  profile: EditorProfile;
  /** Can differ from the appearance profile when shortcuts were not selected. */
  shortcutProfile?: EditorProfile;
  keymap: RiderKeymap;
  setupStatus: 'fresh' | 'invited' | 'complete' | 'dismissed';
  importedBindings: KeyBinding[];
  userBindings: KeyBinding[];
  lastReport: ImportReportItem[];
  sourceLabel?: string;
}

export interface EditorPreferences {
  schemaVersion: number;
  revision: number;
  settings: Record<string, unknown>;
  themeId: string;
  experience: EditorExperienceState;
  canRestore: boolean;
}

export interface ApplyEditorPreferencesRequest {
  expectedRevision: number;
  profile: EditorProfile;
  shortcutProfile?: EditorProfile;
  keymap: RiderKeymap;
  themeId?: string;
  settingsPatch: Record<string, unknown>;
  importedBindings?: KeyBinding[];
  userBindings?: KeyBinding[];
  setupStatus: EditorExperienceState['setupStatus'];
  report?: ImportReportItem[];
  sourceLabel?: string;
}
