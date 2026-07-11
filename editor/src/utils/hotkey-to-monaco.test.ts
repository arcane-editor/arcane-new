import { describe, it, expect } from 'bun:test';
import type { Monaco } from '@monaco-editor/react';
import { parseHotkeyToMonaco } from './hotkey-to-monaco';

// Create a mock Monaco object with KeyCode and KeyMod
function createMockMonaco(): Monaco {
  const mockMonaco = {
    KeyCode: {
      Enter: 3,
      Escape: 9,
      Space: 10,
      Tab: 2,
      Backspace: 1,
      Delete: 8,
      Home: 14,
      End: 13,
      PageUp: 12,
      PageDown: 11,
      UpArrow: 16,
      DownArrow: 17,
      LeftArrow: 18,
      RightArrow: 19,
      Comma: 20,
      Period: 21,
      Slash: 22,
      Backslash: 23,
      Semicolon: 24,
      Quote: 25,
      Backquote: 26,
      BracketLeft: 27,
      BracketRight: 28,
      Minus: 29,
      Equal: 30,
      KeyA: 100,
      KeyB: 101,
      KeyC: 102,
      KeyK: 103,
      Digit0: 200,
      Digit1: 201,
      F1: 300,
      F12: 311,
    },
    KeyMod: {
      CtrlCmd: 2048,
      Shift: 1024,
      Alt: 512,
      WinCtrl: 256,
    },
  } as unknown as Monaco;

  return mockMonaco;
}

describe('parseHotkeyToMonaco', () => {
  const monaco = createMockMonaco();

  describe('basic keys', () => {
    it('parses single letter key', () => {
      const result = parseHotkeyToMonaco('a', monaco);
      expect(result).not.toBeNull();
      expect(result).toBe(100); // KeyA
    });

    it('parses single digit key', () => {
      const result = parseHotkeyToMonaco('0', monaco);
      expect(result).not.toBeNull();
      expect(result).toBe(200); // Digit0
    });

    it('parses function key', () => {
      const result = parseHotkeyToMonaco('F1', monaco);
      expect(result).not.toBeNull();
      expect(result).toBe(300); // F1
    });

    it('parses named key like Enter', () => {
      const result = parseHotkeyToMonaco('enter', monaco);
      expect(result).not.toBeNull();
      expect(result).toBe(3); // Enter
    });
  });

  describe('backtick and raw punctuation (new mappings)', () => {
    it('parses backtick ` as Backquote', () => {
      const result = parseHotkeyToMonaco('`', monaco);
      expect(result).not.toBeNull();
      expect(result).toBe(26); // Backquote
    });

    it('parses backquote alias', () => {
      const result = parseHotkeyToMonaco('backquote', monaco);
      expect(result).not.toBeNull();
      expect(result).toBe(26); // Backquote
    });

    it('parses backtick alias', () => {
      const result = parseHotkeyToMonaco('backtick', monaco);
      expect(result).not.toBeNull();
      expect(result).toBe(26); // Backquote
    });

    it('parses comma , as Comma', () => {
      const result = parseHotkeyToMonaco(',', monaco);
      expect(result).not.toBeNull();
      expect(result).toBe(20); // Comma
    });

    it('parses period . as Period', () => {
      const result = parseHotkeyToMonaco('.', monaco);
      expect(result).not.toBeNull();
      expect(result).toBe(21); // Period
    });

    it('parses slash / as Slash', () => {
      const result = parseHotkeyToMonaco('/', monaco);
      expect(result).not.toBeNull();
      expect(result).toBe(22); // Slash
    });

    it('parses backslash \\ as Backslash', () => {
      const result = parseHotkeyToMonaco('\\', monaco);
      expect(result).not.toBeNull();
      expect(result).toBe(23); // Backslash
    });

    it('parses semicolon ; as Semicolon', () => {
      const result = parseHotkeyToMonaco(';', monaco);
      expect(result).not.toBeNull();
      expect(result).toBe(24); // Semicolon
    });

    it("parses quote ' as Quote", () => {
      const result = parseHotkeyToMonaco("'", monaco);
      expect(result).not.toBeNull();
      expect(result).toBe(25); // Quote
    });
  });

  describe('modifier combinations', () => {
    it('parses mod+backtick', () => {
      const result = parseHotkeyToMonaco('mod+`', monaco);
      expect(result).not.toBeNull();
      // Should be KeyMod.CtrlCmd (2048) | Backquote (26)
      expect(result).toBe(2048 | 26);
    });

    it('parses mod+shift+backtick', () => {
      const result = parseHotkeyToMonaco('mod+shift+`', monaco);
      expect(result).not.toBeNull();
      // Should be KeyMod.CtrlCmd (2048) | KeyMod.Shift (1024) | Backquote (26)
      expect(result).toBe(2048 | 1024 | 26);
    });

    it('parses mod+comma', () => {
      const result = parseHotkeyToMonaco('mod+,', monaco);
      expect(result).not.toBeNull();
      expect(result).toBe(2048 | 20);
    });

    it('parses cmd+backtick (cmd alias for mod)', () => {
      const result = parseHotkeyToMonaco('cmd+`', monaco);
      expect(result).not.toBeNull();
      expect(result).toBe(2048 | 26);
    });

    it('parses ctrl+k', () => {
      const result = parseHotkeyToMonaco('ctrl+k', monaco);
      expect(result).not.toBeNull();
      expect(result).toBe(2048 | 103); // KeyK
    });
  });

  describe('unknown/invalid keys', () => {
    it('returns null for unknown single character', () => {
      const result = parseHotkeyToMonaco('', monaco);
      expect(result).toBeNull();
    });

    it('returns null for unknown named key', () => {
      const result = parseHotkeyToMonaco('unknownkey', monaco);
      expect(result).toBeNull();
    });

    it('returns null for empty string', () => {
      const result = parseHotkeyToMonaco('', monaco);
      expect(result).toBeNull();
    });

    it('returns null when no key is provided (only modifiers)', () => {
      const result = parseHotkeyToMonaco('mod+shift', monaco);
      expect(result).toBeNull();
    });

    it('returns null when multiple keys are provided', () => {
      const result = parseHotkeyToMonaco('a+b', monaco);
      expect(result).toBeNull();
    });
  });
});
