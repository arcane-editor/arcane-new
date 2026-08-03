import { useState } from 'react';
import { Search, RotateCcw, X } from 'lucide-react';
import { useSettingsStore, DEFAULT_SETTINGS } from '../../../stores/settings';
import type { SettingsSchema } from '../../../types';

interface SettingDefinition {
  key: keyof SettingsSchema;
  category: string;
  label: string;
  description: string;
  type: 'boolean' | 'select' | 'number';
  options?: (string | number)[];
  min?: number;
  max?: number;
}

const SETTING_DEFINITIONS: SettingDefinition[] = [
  { key: 'editor.fontSize', type: 'number', min: 10, max: 30, category: 'Editor', label: 'Font Size', description: 'Controls the font size in pixels.' },
  { key: 'editor.tabSize', type: 'select', options: [2, 4, 8], category: 'Editor', label: 'Tab Size', description: 'The number of spaces a tab is equal to.' },
  { key: 'editor.wordWrap', type: 'select', options: ['off', 'on', 'wordWrapColumn'], category: 'Editor', label: 'Word Wrap', description: 'Controls how lines should wrap.' },
  { key: 'editor.minimap', type: 'boolean', category: 'Editor', label: 'Minimap', description: 'Controls whether the minimap is shown.' },
  { key: 'editor.lineNumbers', type: 'select', options: ['on', 'off', 'relative'], category: 'Editor', label: 'Line Numbers', description: 'Controls the display of line numbers.' },
  { key: 'editor.cursorBlinking', type: 'select', options: ['blink', 'smooth', 'phase', 'expand', 'solid'], category: 'Editor', label: 'Cursor Blinking', description: 'Controls the cursor animation style.' },
  { key: 'editor.bracketPairColorization', type: 'boolean', category: 'Editor', label: 'Bracket Pair Colorization', description: 'Controls whether bracket pair colorization is enabled.' },
  { key: 'editor.renderWhitespace', type: 'select', options: ['none', 'boundary', 'selection', 'all'], category: 'Editor', label: 'Render Whitespace', description: 'Controls how whitespace characters are rendered.' },
  { key: 'editor.autoSave', type: 'select', options: ['off', 'afterDelay', 'onFocusChange'], category: 'Editor', label: 'Auto Save', description: 'Controls auto save of editors.' },
  { key: 'editor.autoSaveDelay', type: 'number', min: 100, max: 10000, category: 'Editor', label: 'Auto Save Delay', description: 'Controls the delay in ms after which an editor is saved automatically.' },
  { key: 'editor.betterComments', type: 'boolean', category: 'Editor', label: 'Better Comments', description: 'Highlight tagged comments (// !, // ?, // *, // //, // TODO:, // FIXME:, // HACK:, // NOTE:) with distinct colors.' },
  { key: 'explorer.autoReveal', type: 'boolean', category: 'Editor', label: 'Auto Reveal Active File', description: 'Automatically expand and select the active file in the Explorer when you switch tabs (manual "Reveal Active File in Explorer" always works regardless of this setting).' },
  { key: 'terminal.fontSize', type: 'number', min: 8, max: 30, category: 'Terminal', label: 'Font Size', description: 'Controls the font size of the terminal.' },
  { key: 'terminal.fontFamily', type: 'select', options: [
      'ui-monospace, SFMono-Regular, Menlo, Monaco, \'Cascadia Mono\', \'Courier New\', monospace',
      'Menlo, Monaco, monospace',
      'Monaco, monospace',
      "'Courier New', monospace",
    ], category: 'Terminal', label: 'Font Family', description: 'Controls the font family of the terminal. System fonts only — web fonts cause cell-measurement issues in xterm.' },
  { key: 'terminal.cursorBlink', type: 'boolean', category: 'Terminal', label: 'Cursor Blink', description: 'Controls whether the terminal cursor blinks.' },
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
  { key: 'unity.asmdef.diagnostics', type: 'boolean', category: 'Unity', label: 'Assembly Definition Diagnostics', description: 'Report missing or circular assembly definition references.' },
  { key: 'unity.bridge.enabled', type: 'boolean', category: 'Unity', label: 'Unity Bridge', description: 'Enable live IPC connection to the Unity Editor process.' },
  { key: 'unity.bridge.refreshOnSave', type: 'boolean', category: 'Unity', label: 'Bridge: Refresh on Save', description: 'Trigger an asset refresh in the Unity Editor whenever a file is saved.' },
  { key: 'unity.telemetry.enabled', type: 'boolean', category: 'Unity', label: 'Play-Mode Telemetry', description: 'Show a live FPS / memory / GC strip in the status bar while the Unity Editor is in Play Mode.' },
  { key: 'unity.hierarchyPanel.enabled', type: 'boolean', category: 'Unity', label: 'Hierarchy Panel', description: 'Show a live scene hierarchy panel mirroring the Unity Editor hierarchy.' },
  { key: 'unity.assetViewer.structuredDefault', type: 'boolean', category: 'Unity', label: 'Asset Viewer: Structured Default', description: 'Open Unity asset files in the structured viewer by default instead of raw text.' },
  { key: 'unity.sceneDiff.enabled', type: 'boolean', category: 'Unity', label: 'Semantic Scene Diff', description: 'Semantic scene/prefab diffs — show Unity file changes as objects and properties instead of raw YAML.' },
  { key: 'unity.codeLens.assetUsages', type: 'boolean', category: 'Unity', label: 'CodeLens: Asset Usages', description: 'Show an inline CodeLens count of scene/prefab references above each MonoBehaviour.' },
  { key: 'unity.templates.enabled', type: 'boolean', category: 'Unity', label: 'Script Templates', description: 'Enable Unity-specific new-file templates (MonoBehaviour, ScriptableObject, etc.).' },
  { key: 'unity.docs.versionMatchedHover', type: 'boolean', category: 'Unity', label: 'Version-Matched Docs Hover', description: 'Show hover documentation matched to the Unity version used by the open project.' },
  { key: 'unity.explorer.assetsFirst', type: 'boolean', category: 'Unity', label: 'Explorer: Assets First', description: 'Pin the Assets folder to the top of the file explorer.' },
  { key: 'unity.explorer.hideMeta', type: 'boolean', category: 'Unity', label: 'Explorer: Hide .meta Files', description: 'Hide .meta files in the file explorer (they are still tracked by git).' },
  { key: 'unity.git.metaPairingChecks', type: 'boolean', category: 'Unity', label: 'Git: Meta Pairing Checks', description: 'Warn in source control when an asset and its .meta file are not staged together.' },
  { key: 'unity.git.yamlMergeIntegration', type: 'boolean', category: 'Unity', label: 'Git: YAML Merge Integration', description: 'Use UnityYAMLMerge as the merge driver for Unity scene and prefab files.' },
  { key: 'unity.testRunner.enabled', type: 'boolean', category: 'Unity', label: 'Test Runner', description: 'Enable the Unity Test Runner panel for running EditMode and PlayMode tests.' },
  { key: 'unity.debugger.enabled', type: 'boolean', category: 'Unity', label: 'Debugger', description: 'Enable the Unity Mono debugger (DAP) integration for breakpoints and step-through.' },
  { key: 'unity.shader.completions', type: 'boolean', category: 'Unity', label: 'Shader Completions', description: 'Provide ShaderLab/HLSL keyword completions and #include navigation.' },
  { key: 'unity.packages.manifestIntelligence', type: 'boolean', category: 'Unity', label: 'Packages: Manifest Intelligence', description: 'Enable completions and validation in Packages/manifest.json.' },
  { key: 'unity.index.enabled', type: 'boolean', category: 'Unity', label: 'Project Index', description: 'Build and maintain a background index of Unity assets for fast cross-file lookups.' },
];

interface SettingRowProps {
  definition: SettingDefinition;
}

function SettingRow({ definition }: SettingRowProps) {
  const { settings, setSetting, resetSetting } = useSettingsStore();
  const currentValue = settings[definition.key];
  const defaultValue = DEFAULT_SETTINGS[definition.key];
  const isModified = currentValue !== defaultValue;

  function handleChange(newValue: unknown) {
    setSetting(definition.key, newValue as SettingsSchema[typeof definition.key]);
  }

  function renderControl() {
    if (definition.type === 'boolean') {
      return (
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={currentValue as boolean}
            onChange={(e) => handleChange(e.target.checked)}
          />
          <span className="settings-toggle-slider" />
        </label>
      );
    }

    if (definition.type === 'select') {
      return (
        <select
          className="settings-control-select"
          value={String(currentValue)}
          onChange={(e) => {
            const raw = e.target.value;
            const parsed = definition.options?.find((o) => String(o) === raw);
            handleChange(parsed !== undefined ? parsed : raw);
          }}
        >
          {definition.options?.map((opt) => (
            <option key={String(opt)} value={String(opt)}>
              {String(opt)}
            </option>
          ))}
        </select>
      );
    }

    if (definition.type === 'number') {
      return (
        <input
          type="number"
          className="settings-control-number"
          value={currentValue as number}
          min={definition.min}
          max={definition.max}
          onChange={(e) => handleChange(Number(e.target.value))}
        />
      );
    }

    return null;
  }

  return (
    <div className={`settings-row ${isModified ? 'settings-row-modified' : ''}`}>
      <div className="settings-row-label">{definition.label}</div>
      <div className="settings-row-description">{definition.description}</div>
      <div className="settings-row-control">
        {renderControl()}
        {isModified && (
          <button
            className="settings-reset-btn"
            title="Reset to default"
            onClick={() => resetSetting(definition.key)}
          >
            <RotateCcw size={13} />
          </button>
        )}
      </div>
    </div>
  );
}

interface SettingsPanelProps {
  onClose: () => void;
}

export default function SettingsPanel({ onClose }: SettingsPanelProps) {
  const [search, setSearch] = useState('');

  const filtered = search.trim()
    ? SETTING_DEFINITIONS.filter(
        (d) =>
          d.label.toLowerCase().includes(search.toLowerCase()) ||
          d.description.toLowerCase().includes(search.toLowerCase()) ||
          d.key.toLowerCase().includes(search.toLowerCase())
      )
    : SETTING_DEFINITIONS;

  const categories = Array.from(new Set(filtered.map((d) => d.category)));

  return (
    <div className="settings-panel">
      <div className="settings-header">
        <span className="settings-header-title">Settings</span>
        <button onClick={onClose} title="Close" className="settings-header-close">
          <X size={16} />
        </button>
      </div>

      <div className="settings-search">
        <Search size={14} className="settings-search-icon" />
        <input
          type="text"
          placeholder="Search settings"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="settings-search-input"
          autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
        />
      </div>

      <div className="settings-content">
        {categories.length === 0 ? (
          <div className="settings-empty">No settings match your search.</div>
        ) : (
          categories.map((category) => (
            <div key={category} className="settings-category">
              <div className="settings-category-title">{category}</div>
              {filtered
                .filter((d) => d.category === category)
                .map((definition) => (
                  <SettingRow key={definition.key} definition={definition} />
                ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
