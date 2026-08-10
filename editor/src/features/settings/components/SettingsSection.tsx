import { RotateCcw } from 'lucide-react';
import { useSettingsStore, DEFAULT_SETTINGS } from '../../../stores/settings';
import type { SettingsSchema } from '../../../types';
import { optionLabel, optionValue, type SettingDefinition } from '../data/definitions';
import FontPicker from './FontPicker';
import TerminalPreview from './TerminalPreview';

function SettingRow({ definition }: { definition: SettingDefinition }) {
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
            const parsed = definition.options
              ?.map(optionValue)
              .find((o) => String(o) === raw);
            handleChange(parsed !== undefined ? parsed : raw);
          }}
        >
          {definition.options?.map((opt) => (
            <option key={String(optionValue(opt))} value={String(optionValue(opt))}>
              {optionLabel(opt)}
            </option>
          ))}
        </select>
      );
    }

    if (definition.type === 'font') {
      return (
        <FontPicker
          options={definition.options ?? []}
          value={String(currentValue)}
          onChange={handleChange}
        />
      );
    }

    if (definition.type === 'range') {
      const min = definition.min ?? 0;
      const max = definition.max ?? 100;
      return (
        <div className="settings-range">
          <input
            type="range"
            className="settings-range-slider"
            min={min}
            max={max}
            step={definition.step ?? 1}
            value={Number(currentValue)}
            aria-label={definition.label}
            onChange={(e) => handleChange(Number(e.target.value))}
          />
          <input
            type="number"
            className="settings-control-number settings-range-number"
            min={min}
            max={max}
            step={definition.step ?? 1}
            value={Number(currentValue)}
            onChange={(e) => {
              // Clamp: the number input accepts anything typed, and an
              // out-of-range font size reaches xterm and breaks cell metrics.
              const n = Number(e.target.value);
              if (Number.isFinite(n)) handleChange(Math.min(max, Math.max(min, n)));
            }}
          />
          {definition.unit && <span className="settings-range-unit">{definition.unit}</span>}
        </div>
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
      <div className="settings-row-text">
        <div className="settings-row-label">{definition.label}</div>
        <div className="settings-row-description">{definition.description}</div>
      </div>
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

interface SettingsSectionProps {
  title: string;
  definitions: SettingDefinition[];
  /** When true, each row is labelled with its category (used by search results). */
  showCategory?: boolean;
}

/** One pane of settings rows, headed by its category name. */
export function SettingsSection({ title, definitions, showCategory }: SettingsSectionProps) {
  if (definitions.length === 0) {
    return <div className="settings-empty">No settings match your search.</div>;
  }

  return (
    <div className="settings-section">
      <h2 className="settings-section-title">{title}</h2>
      {title === 'Terminal' && <TerminalPreview />}
      {showCategory ? (
        // Search results span categories, so rows are grouped under their own
        // headings rather than presented as one undifferentiated list.
        [...new Set(definitions.map((d) => d.category))].map((cat) => (
          <div key={cat} className="settings-section-group">
            <div className="settings-section-group-title">{cat}</div>
            {definitions
              .filter((d) => d.category === cat)
              .map((d) => (
                <SettingRow key={d.key} definition={d} />
              ))}
          </div>
        ))
      ) : (
        definitions.map((d) => <SettingRow key={d.key} definition={d} />)
      )}
    </div>
  );
}

export default SettingsSection;
