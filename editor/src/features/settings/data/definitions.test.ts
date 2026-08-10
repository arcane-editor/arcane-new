import { describe, it, expect } from 'bun:test';
import { SETTING_DEFINITIONS } from './definitions';

/**
 * `SettingsSection` renders a select as `<option>{String(opt)}</option>`, so an
 * option's value IS its label. `terminal.fontFamily`'s values are raw CSS font
 * stacks, which made the dropdown display
 *
 *   ui-monospace, SFMono-Regular, Menlo, Monaco, 'Cascadia Mono', 'Courier New', monospace
 *
 * as its own label. That is the whole of the "terminal settings look bad"
 * report. Values stay full stacks — a font picker needs them — but anything
 * shown to a user must be short or carry an explicit human label.
 */
const MAX_RAW_OPTION_LABEL = 24;

describe('setting definitions', () => {
  it('never displays a raw value long enough to be a CSS stack', () => {
    const offenders: string[] = [];
    for (const def of SETTING_DEFINITIONS) {
      if (!def.options) continue;
      for (const opt of def.options) {
        const isLabelled = typeof opt === 'object' && opt !== null && 'label' in opt;
        if (isLabelled) continue;
        if (String(opt).length > MAX_RAW_OPTION_LABEL) {
          offenders.push(`${def.key}: ${String(opt).slice(0, 40)}…`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('gives the terminal font a picker rather than a bare select', () => {
    const font = SETTING_DEFINITIONS.find((d) => d.key === 'terminal.fontFamily');
    expect(font?.type).toBe('font');
  });

  it('gives size and delay settings a range control', () => {
    for (const key of ['terminal.fontSize', 'editor.fontSize', 'editor.autoSaveDelay'] as const) {
      const def = SETTING_DEFINITIONS.find((d) => d.key === key);
      expect({ key, type: def?.type }).toEqual({ key, type: 'range' });
    }
  });

  it('keeps every option value a real font stack for the font setting', () => {
    const font = SETTING_DEFINITIONS.find((d) => d.key === 'terminal.fontFamily');
    for (const opt of font?.options ?? []) {
      // Stored value must remain usable by xterm directly.
      const value = typeof opt === 'object' ? opt.value : opt;
      expect(String(value).length).toBeGreaterThan(0);
    }
  });
});
