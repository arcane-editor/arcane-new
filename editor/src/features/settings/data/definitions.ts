/**
 * The settings catalogue — every user-facing preference, its control type, and
 * the copy shown beside it.
 *
 * Data, not UI: kept out of the components so the modal shell, the section
 * renderer and the search filter can each consume it without any of them
 * owning it. `category` drives the modal's left-hand nav, so adding a new
 * category here is enough to make it appear.
 */

import type { SettingsSchema } from '../../../types';

/** An option whose stored value is not fit to show a human. */
export interface LabelledOption {
  value: string | number;
  label: string;
}

export type SettingOption = string | number | LabelledOption;

export interface SettingDefinition {
  key: keyof SettingsSchema;
  category: string;
  label: string;
  description: string;
  /**
   * `select` renders a plain dropdown whose option values ARE its labels, so
   * it is only correct for short values. `font` renders each option in the
   * font it names; `range` renders a slider beside a number input.
   */
  type: 'boolean' | 'select' | 'number' | 'font' | 'range';
  options?: SettingOption[];
  min?: number;
  max?: number;
  /** `range` only: slider granularity. */
  step?: number;
  /** `range` only: unit shown beside the value (e.g. 'px', 'ms'). */
  unit?: string;
}

/** Narrow an option to its stored value. */
export function optionValue(opt: SettingOption): string | number {
  return typeof opt === 'object' ? opt.value : opt;
}

/** Narrow an option to what a human should read. */
export function optionLabel(opt: SettingOption): string {
  return typeof opt === 'object' ? opt.label : String(opt);
}

export const SETTING_DEFINITIONS: SettingDefinition[] = [
  { key: 'editor.fontSize', type: 'range', min: 10, max: 30, step: 1, unit: 'px', category: 'Editor', label: 'Font Size', description: 'Controls the font size in pixels.' },
  { key: 'editor.tabSize', type: 'select', options: [2, 4, 8], category: 'Editor', label: 'Tab Size', description: 'The number of spaces a tab is equal to.' },
  { key: 'editor.wordWrap', type: 'select', options: ['off', 'on', 'wordWrapColumn'], category: 'Editor', label: 'Word Wrap', description: 'Controls how lines should wrap.' },
  { key: 'editor.minimap', type: 'boolean', category: 'Editor', label: 'Minimap', description: 'Controls whether the minimap is shown.' },
  { key: 'editor.lineNumbers', type: 'select', options: ['on', 'off', 'relative'], category: 'Editor', label: 'Line Numbers', description: 'Controls the display of line numbers.' },
  { key: 'editor.cursorBlinking', type: 'select', options: ['blink', 'smooth', 'phase', 'expand', 'solid'], category: 'Editor', label: 'Cursor Blinking', description: 'Controls the cursor animation style.' },
  { key: 'editor.bracketPairColorization', type: 'boolean', category: 'Editor', label: 'Bracket Pair Colorization', description: 'Controls whether bracket pair colorization is enabled.' },
  { key: 'editor.renderWhitespace', type: 'select', options: ['none', 'boundary', 'selection', 'all'], category: 'Editor', label: 'Render Whitespace', description: 'Controls how whitespace characters are rendered.' },
  { key: 'editor.autoSave', type: 'select', options: ['off', 'afterDelay', 'onFocusChange'], category: 'Editor', label: 'Auto Save', description: 'Controls auto save of editors.' },
  { key: 'editor.autoSaveDelay', type: 'range', min: 100, max: 10000, step: 100, unit: 'ms', category: 'Editor', label: 'Auto Save Delay', description: 'Controls the delay after which an editor is saved automatically.' },
  { key: 'editor.betterComments', type: 'boolean', category: 'Editor', label: 'Better Comments', description: 'Highlight tagged comments (// !, // ?, // *, // //, // TODO:, // FIXME:, // HACK:, // NOTE:) with distinct colors.' },
  { key: 'explorer.autoReveal', type: 'boolean', category: 'Editor', label: 'Auto Reveal Active File', description: 'Automatically expand and select the active file in the Explorer when you switch tabs (manual "Reveal Active File in Explorer" always works regardless of this setting).' },
  { key: 'terminal.fontSize', type: 'range', min: 8, max: 30, step: 1, unit: 'px', category: 'Terminal', label: 'Font Size', description: 'Controls the font size of the terminal.' },
  { key: 'terminal.fontFamily', type: 'font', options: [
      { value: 'ui-monospace, SFMono-Regular, Menlo, Monaco, \'Cascadia Mono\', \'Courier New\', monospace', label: 'System Monospace' },
      { value: 'Menlo, Monaco, monospace', label: 'Menlo' },
      { value: 'Monaco, monospace', label: 'Monaco' },
      { value: "'Cascadia Mono', 'Cascadia Code', monospace", label: 'Cascadia Mono' },
      { value: "'Consolas', monospace", label: 'Consolas' },
      { value: "'JetBrains Mono', monospace", label: 'JetBrains Mono' },
      { value: "'Courier New', monospace", label: 'Courier New' },
    ], category: 'Terminal', label: 'Font Family', description: 'System fonts only — web fonts break xterm\'s cell measurement. Each option is previewed in its own face; one not installed on your machine falls back to the next in its stack.' },
  { key: 'terminal.cursorBlink', type: 'boolean', category: 'Terminal', label: 'Cursor Blink', description: 'Controls whether the terminal cursor blinks.' },
  { key: 'ui.coachMarks.enabled', type: 'boolean', category: 'Editor', label: 'Contextual Tips', description: 'Show a one-time hint the first time a capability becomes relevant — when Unity connects, when you open your first C# file. Each appears at most once.' },
  { key: 'ai.inlineSuggestions.enabled', type: 'boolean', category: 'AI', label: 'Inline suggestions (Tab)', description: 'Ghost-text code suggestions as you type. Accept with Tab.' },
  { key: 'ai.checkpoints.enabled', type: 'boolean', category: 'AI', label: 'Checkpoints', description: 'Snapshot files before the AI writes to them, so you can restore a turn (and everything after it) from the chat timeline.' },
  { key: 'ai.escalation.enabled', type: 'boolean', category: 'AI', label: 'Repair-Triggered Escalation', description: 'When the agent needs 2+ compile/analyzer repairs in a single send, escalate to a stronger model for the rest of that send.' },
  { key: 'ai.edits.applyMode', type: 'select', options: ['approve', 'auto'], category: 'AI', label: 'Apply Mode', description: 'Auto (default): edits apply immediately and enter Accept/Reject review in the chat (checkpoints back "Reject" with a restore to the pre-image). Approve (legacy): review a diff and click Apply before any AI file edit reaches disk — "Apply all this session" makes an approved plan effectively one-click for the rest of the conversation. Either way, Unity serialized assets always pre-prompt (see below).' },
  { key: 'ai.edits.alwaysApproveUnityAssets', type: 'boolean', category: 'AI', label: 'Always Approve Unity Serialized Assets', description: 'Even in Auto apply mode (or after "Apply all this session"), always prompt before writing to serialized Unity assets (.unity, .prefab, .asset, .mat, .controller, .anim) — we never silently touch scene/prefab data.' },
  { key: 'unity.analyzers.enabled', type: 'boolean', category: 'Unity', label: 'Analyzers', description: 'Enable Unity-aware static analyzers (incorrect API usage, lifecycle ordering, etc.).' },
  { key: 'unity.compileGate.enabled', type: 'boolean', category: 'Unity', label: 'AI Compile Verification', description: 'After the AI writes C#, recompile via the Unity bridge and feed real compiler errors back so it self-corrects (requires a connected Unity Editor).' },
  { key: 'unity.lspGate.enabled', type: 'boolean', category: 'Unity', label: 'AI Language Server Verification', description: 'After the AI writes C#, check the language server for diagnostic errors and feed them back so it self-corrects — works even without a connected Unity Editor.' },
  { key: 'unity.verifiedPass.enabled', type: 'boolean', category: 'Unity', label: 'AI Verified-Pass Closing Check', description: 'After an agent send finishes, re-check everything it touched (analyzers, a live compile, GUID integrity) and show a compact Verified card summarizing the result.' },
  { key: 'unity.nearMissDiagnostics.enabled', type: 'boolean', category: 'Unity', label: 'Near-Miss Diagnostics', description: 'Warn when a method looks like a Unity message but has a wrong signature.' },
  { key: 'unity.rename.formerlySerializedAs', type: 'boolean', category: 'Unity', label: 'FormerlySerializedAs on Rename', description: 'Automatically insert [FormerlySerializedAs] when a serialized field is renamed.' },
  { key: 'unity.serializationDiagnostics.enabled', type: 'boolean', category: 'Unity', label: 'Serialization Diagnostics', description: 'Highlight fields with unsupported serialization types or conflicting attributes.' },
  { key: 'unity.inputDiagnostics.enabled', type: 'boolean', category: 'Unity', label: 'Input System Diagnostics', description: "Validate C# against the project's .inputactions assets: unknown action names, ReadValue type mismatches, binding conflicts, leaked callbacks, and legacy Input calls that throw under the New Input System." },
  { key: 'unity.uiDiagnostics.enabled', type: 'boolean', category: 'Unity', label: 'UI Toolkit Diagnostics', description: "Validate C# and UXML against the project's .uxml and .uss assets: Q<T>() names that match no element, classes no stylesheet declares, and properties Unity drops at import." },
  { key: 'unity.asmdef.diagnostics', type: 'boolean', category: 'Unity', label: 'Assembly Definition Diagnostics', description: 'Report missing or circular assembly definition references.' },
  { key: 'unity.bridge.enabled', type: 'boolean', category: 'Unity', label: 'Unity Bridge', description: 'Enable live IPC connection to the Unity Editor process.' },
  { key: 'unity.bridge.refreshOnSave', type: 'boolean', category: 'Unity', label: 'Bridge: Refresh on Save', description: 'Trigger an asset refresh in the Unity Editor whenever a file is saved.' },
  { key: 'unity.telemetry.enabled', type: 'boolean', category: 'Unity', label: 'Play-Mode Telemetry', description: 'Show a live FPS / memory / GC strip in the status bar while the Unity Editor is in Play Mode.' },
  { key: 'unity.hierarchyPanel.enabled', type: 'boolean', category: 'Unity', label: 'Hierarchy Panel', description: 'Show a live scene hierarchy panel mirroring the Unity Editor hierarchy.' },
  { key: 'unity.assetViewer.structuredDefault', type: 'boolean', category: 'Unity', label: 'Asset Viewer: Structured Default', description: 'Open Unity asset files in the structured viewer by default instead of raw text.' },
  { key: 'unity.scriptableObjects.inspector', type: 'boolean', category: 'Unity', label: 'ScriptableObject Instances In Inspector', description: 'When a ScriptableObject script is open, list its asset instances in the Inspector panel instead of the plain usage list.' },
  { key: 'unity.codeLens.scriptableObjectInstances', type: 'boolean', category: 'Unity', label: 'CodeLens: ScriptableObject Instances', description: 'Show how many .asset instances exist above a ScriptableObject class declaration.' },
  { key: 'unity.sceneDiff.enabled', type: 'boolean', category: 'Unity', label: 'Semantic Scene Diff', description: 'Semantic scene/prefab diffs — show Unity file changes as objects and properties instead of raw YAML.' },
  { key: 'unity.codeLens.assetUsages', type: 'boolean', category: 'Unity', label: 'CodeLens: Asset Usages', description: 'Show an inline CodeLens count of scene/prefab references above each MonoBehaviour.' },
  { key: 'unity.templates.enabled', type: 'boolean', category: 'Unity', label: 'Script Templates', description: 'Enable Unity-specific new-file templates (MonoBehaviour, ScriptableObject, etc.).' },
  { key: 'unity.docs.versionMatchedHover', type: 'boolean', category: 'Unity', label: 'Version-Matched Docs Hover', description: 'Show hover documentation matched to the Unity version used by the open project.' },
  { key: 'unity.explorer.assetsFirst', type: 'boolean', category: 'Unity', label: 'Explorer: Assets First', description: 'Pin the Assets folder to the top of the file explorer.' },
  { key: 'unity.explorer.hideMeta', type: 'boolean', category: 'Unity', label: 'Explorer: Hide .meta Files', description: 'Hide .meta files in the file explorer (they are still tracked by git).' },
  { key: 'unity.git.metaPairingChecks', type: 'boolean', category: 'Unity', label: 'Git: Meta Pairing Checks', description: 'Warn in source control when an asset and its .meta file are not staged together.' },
  { key: 'unity.git.yamlMergeIntegration', type: 'boolean', category: 'Unity', label: 'Git: YAML Merge Integration', description: 'Use UnityYAMLMerge as the merge driver for Unity scene and prefab files.' },
  { key: 'unity.testRunner.enabled', type: 'boolean', category: 'Unity', label: 'Test Runner', description: 'Enable the Unity Test Runner panel for running EditMode and PlayMode tests.' },
  { key: 'unity.inputHub.enabled', type: 'boolean', category: 'Unity', label: 'Input Hub', description: 'Show the Input Actions panel. Only appears in projects that run the New Input System.' },
  { key: 'unity.debugger.enabled', type: 'boolean', category: 'Unity', label: 'Debugger', description: 'Enable the Unity Mono debugger (DAP) integration for breakpoints and step-through.' },
  { key: 'unity.shader.completions', type: 'boolean', category: 'Unity', label: 'Shader Completions', description: 'Provide ShaderLab/HLSL keyword completions and #include navigation.' },
  { key: 'unity.packages.manifestIntelligence', type: 'boolean', category: 'Unity', label: 'Packages: Manifest Intelligence', description: 'Enable completions and validation in Packages/manifest.json.' },
  { key: 'unity.index.enabled', type: 'boolean', category: 'Unity', label: 'Project Index', description: 'Build and maintain a background index of Unity assets for fast cross-file lookups.' },
  { key: 'updates.autoInstall', type: 'boolean', category: 'Updates', label: 'Automatic Updates', description: 'Download and install new versions of UnityIDE in the background. Updates take effect when you restart.' },
];
