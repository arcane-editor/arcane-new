import type { Monaco } from '@monaco-editor/react';

const NAMED_KEYS: Record<string, keyof Monaco['KeyCode']> = {
  enter: 'Enter',
  return: 'Enter',
  esc: 'Escape',
  escape: 'Escape',
  space: 'Space',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  up: 'UpArrow',
  down: 'DownArrow',
  left: 'LeftArrow',
  right: 'RightArrow',
  comma: 'Comma',
  period: 'Period',
  dot: 'Period',
  slash: 'Slash',
  backslash: 'Backslash',
  semicolon: 'Semicolon',
  quote: 'Quote',
  apostrophe: 'Quote',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  bracketleft: 'BracketLeft',
  bracketright: 'BracketRight',
  '-': 'Minus',
  minus: 'Minus',
  '=': 'Equal',
  equal: 'Equal',
  plus: 'Equal',
};

function keycodeFor(monaco: Monaco, token: string): number | null {
  const t = token.trim().toLowerCase();
  if (!t) return null;
  if (t.length === 1 && t >= 'a' && t <= 'z') {
    const key = `Key${t.toUpperCase()}` as keyof typeof monaco.KeyCode;
    return monaco.KeyCode[key] as unknown as number;
  }
  if (t.length === 1 && t >= '0' && t <= '9') {
    const key = `Digit${t}` as keyof typeof monaco.KeyCode;
    return monaco.KeyCode[key] as unknown as number;
  }
  const fMatch = /^f([1-9]|1[0-9])$/.exec(t);
  if (fMatch) {
    const key = `F${fMatch[1]}` as keyof typeof monaco.KeyCode;
    return monaco.KeyCode[key] as unknown as number;
  }
  const named = NAMED_KEYS[t];
  if (named) return monaco.KeyCode[named] as unknown as number;
  return null;
}

export function parseHotkeyToMonaco(hotkey: string, monaco: Monaco): number | null {
  if (!hotkey) return null;
  const tokens = hotkey.split('+').map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (tokens.length === 0) return null;

  let bitfield = 0;
  let key: number | null = null;

  for (const tok of tokens) {
    if (tok === 'mod' || tok === 'cmd' || tok === 'meta' || tok === 'ctrl' || tok === 'control') {
      bitfield |= monaco.KeyMod.CtrlCmd;
    } else if (tok === 'shift') {
      bitfield |= monaco.KeyMod.Shift;
    } else if (tok === 'alt' || tok === 'option') {
      bitfield |= monaco.KeyMod.Alt;
    } else if (tok === 'wincmd' || tok === 'winctrl') {
      bitfield |= monaco.KeyMod.WinCtrl;
    } else {
      const k = keycodeFor(monaco, tok);
      if (k === null) return null;
      if (key !== null) return null;
      key = k;
    }
  }

  if (key === null) return null;
  return bitfield | key;
}
