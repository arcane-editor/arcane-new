import { describe, it, expect } from 'bun:test';
import {
  detectInputSystem,
  isNewInputSystemActive,
  inputSystemLabel,
} from './input-system';

/** A realistic ProjectSettings.asset slice — the field is nested and indented. */
function projectSettings(handler: string | null): string {
  return [
    'MonoBehaviour:',
    '  m_ObjectHideFlags: 0',
    '  productName: Ashfall',
    ...(handler === null ? [] : [`  activeInputHandler: ${handler}`]),
    '  cloudProjectId: ',
  ].join('\n');
}

describe('detectInputSystem', () => {
  it('reads activeInputHandler 0 as Legacy', () => {
    expect(detectInputSystem(projectSettings('0'), false)).toBe('Legacy');
  });

  it('reads activeInputHandler 1 as New', () => {
    expect(detectInputSystem(projectSettings('1'), false)).toBe('New');
  });

  it('reads activeInputHandler 2 as Both', () => {
    expect(detectInputSystem(projectSettings('2'), false)).toBe('Both');
  });

  it('trusts activeInputHandler over package presence', () => {
    // The package can sit in manifest.json while the project still runs the
    // legacy handler — the setting is what actually decides at runtime.
    expect(detectInputSystem(projectSettings('0'), true)).toBe('Legacy');
  });

  it('falls back to the package when ProjectSettings is unreadable', () => {
    expect(detectInputSystem(null, true)).toBe('New');
    expect(detectInputSystem(null, false)).toBe('Legacy');
  });

  it('falls back to the package when the field is absent', () => {
    expect(detectInputSystem(projectSettings(null), true)).toBe('New');
    expect(detectInputSystem(projectSettings(null), false)).toBe('Legacy');
  });

  it('ignores an unrecognised handler value rather than guessing Both', () => {
    // Guarding a real bug in the previous inline version, which treated every
    // non-0/non-1 digit as Both — including values Unity has never emitted.
    expect(detectInputSystem(projectSettings('9'), false)).toBe('Legacy');
    expect(detectInputSystem(projectSettings('9'), true)).toBe('New');
  });

  it('ignores a commented-out or unrelated occurrence of the token', () => {
    expect(detectInputSystem('  # activeInputHandler: 1\n', false)).toBe('Legacy');
  });

  it('handles an empty file', () => {
    expect(detectInputSystem('', false)).toBe('Legacy');
  });
});

describe('isNewInputSystemActive', () => {
  it('is true only when the new system can actually receive input', () => {
    expect(isNewInputSystemActive('New')).toBe(true);
    expect(isNewInputSystemActive('Both')).toBe(true);
    expect(isNewInputSystemActive('Legacy')).toBe(false);
    expect(isNewInputSystemActive(null)).toBe(false);
  });
});

describe('inputSystemLabel', () => {
  it('names the package so the agent prompt stays specific', () => {
    expect(inputSystemLabel('New')).toBe('New (Input System package)');
    expect(inputSystemLabel('Both')).toBe('Both (legacy Input Manager + Input System)');
    expect(inputSystemLabel('Legacy')).toBe('Legacy (Input Manager)');
  });
});
