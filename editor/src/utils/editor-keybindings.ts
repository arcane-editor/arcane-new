import type { BindingContext, KeyBinding } from '../types/editor-experience';

const KEY_ALIASES: Record<string, string> = {
  '`': 'backquote', backtick: 'backquote', '\\': 'backslash', '[': 'bracketleft', ']': 'bracketright',
  ',': 'comma', '.': 'period', '/': 'slash', ';': 'semicolon', "'": 'quote', '-': 'minus', '=': 'equal',
  escape: 'esc', return: 'enter', arrowleft: 'left', arrowright: 'right', arrowup: 'up', arrowdown: 'down',
  spacebar: 'space', del: 'delete', command: 'cmd', meta: 'cmd', control: 'ctrl', option: 'alt',
};
const MODIFIERS = ['ctrl', 'cmd', 'alt', 'shift', 'win'] as const;
const NAMED_KEYS = new Set(['backquote', 'backslash', 'bracketleft', 'bracketright', 'comma', 'period', 'slash',
  'semicolon', 'quote', 'minus', 'equal', 'esc', 'enter', 'left', 'right', 'up', 'down', 'space', 'delete',
  'tab', 'backspace', 'home', 'end', 'pageup', 'pagedown', 'insert']);

/** Physical keys and exact modifiers, independent of display names and host OS. */
export function normalizeStroke(stroke: string, mac: boolean): string | null {
  const parts = stroke.trim().toLowerCase().split('+').map((part) => part.trim()).filter(Boolean)
    .map((part) => part === 'mod' ? (mac ? 'cmd' : 'ctrl') : KEY_ALIASES[part] ?? part);
  const keys = parts.filter((part) => !MODIFIERS.includes(part as typeof MODIFIERS[number]));
  if (keys.length !== 1) return null;
  const key = keys[0].replace(/^key([a-z])$/, '$1').replace(/^digit([0-9])$/, '$1');
  if (!/^[a-z0-9]$/.test(key) && !/^f(?:[1-9]|1[0-9])$/.test(key) && !NAMED_KEYS.has(key)) return null;
  const mods = MODIFIERS.filter((mod) => parts.includes(mod));
  return [...mods, key].join('+');
}

export function normalizeBinding(binding: KeyBinding, mac: boolean): KeyBinding | null {
  if (!binding.commandId || (!binding.removed && binding.strokes.length < 1) || binding.strokes.length > 2) return null;
  const strokes = binding.strokes.map((stroke) => normalizeStroke(stroke, mac));
  if (strokes.some((stroke) => !stroke)) return null;
  if (binding.context && !['global', 'editor', 'terminal', 'input'].includes(binding.context)) return null;
  return { ...binding, strokes: strokes as string[], context: binding.context ?? 'global' };
}

export function bindingKey(binding: KeyBinding): string {
  return `${binding.context ?? 'global'}|${binding.strokes.join(' ')}`;
}

export function bindingsFromCommand(command: { id: string; keybinding?: string; extraKeybindings?: string[] }, mac: boolean): KeyBinding[] {
  return [command.keybinding, ...(command.extraKeybindings ?? [])].filter((chord): chord is string => !!chord)
    .map((chord) => normalizeBinding({ commandId: command.id, strokes: chord.trim().split(/\s+/) }, mac))
    .filter((binding): binding is KeyBinding => !!binding);
}

/** These belong to the OS/native Edit menu; a migration must not repurpose them. */
export function isProtectedStroke(stroke: string, mac: boolean): boolean {
  const normalized = normalizeStroke(stroke, mac);
  if (!normalized) return false;
  if (normalized.split('+').includes('win')) return true;
  if (!mac && normalized.split('+').includes('cmd')) return true;
  const primary = mac ? 'cmd' : 'ctrl';
  if (new Set([`${primary}+c`, `${primary}+x`, `${primary}+v`, `${primary}+a`, `${primary}+z`, `${primary}+shift+z`,
    ...(mac ? ['cmd+q', 'cmd+h', 'cmd+alt+h', 'cmd+tab', 'cmd+shift+tab', 'ctrl+cmd+f'] : ['alt+tab', 'alt+shift+tab', 'alt+f4', 'ctrl+alt+delete'])])
    .has(normalized)) return true;
  return !mac && normalized === 'ctrl+y';
}

export interface ShortcutKeyEvent {
  code: string; key?: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean;
  repeat?: boolean; isComposing?: boolean; getModifierState?: (name: string) => boolean;
}

export function eventStroke(event: ShortcutKeyEvent): string | null {
  if (event.isComposing || event.getModifierState?.('AltGraph')) return null;
  const key = event.code.toLowerCase().replace(/^key/, '').replace(/^digit/, '');
  const named = KEY_ALIASES[key] ?? key;
  if (['shiftleft', 'shiftright', 'controlleft', 'controlright', 'altleft', 'altright', 'metaleft', 'metaright'].includes(named)) return null;
  return normalizeStroke([event.ctrlKey && 'ctrl', event.metaKey && 'cmd', event.altKey && 'alt', event.shiftKey && 'shift', named]
    .filter(Boolean).join('+'), false);
}

export function contextMatches(binding: KeyBinding, context: BindingContext): boolean {
  return !binding.context || binding.context === 'global' || binding.context === context;
}

const TERMINAL_COMMANDS = new Set(['terminal.toggle', 'terminal.new', 'terminal.split', 'terminal.focusNextPane', 'terminal.focusPreviousPane']);

/** A single source for app dispatch AND xterm PTY suppression. */
export function bindingBeatsShell(binding: KeyBinding, mac: boolean): boolean {
  if (binding.context === 'editor' || binding.context === 'input') return false;
  if (binding.context === 'terminal' || TERMINAL_COMMANDS.has(binding.commandId)) return true;
  const stroke = normalizeStroke(binding.strokes[0] ?? '', mac) ?? '';
  if (stroke.startsWith('cmd+')) return true;
  // Control bytes and editing/navigation keys remain readline/TUI input.
  if (/^ctrl\+[a-z]$/.test(stroke)) return false;
  if (!stroke.includes('+') && !/^f[0-9]+$/.test(stroke)) return false;
  return true;
}

export function shouldSuppressTerminalKey(event: ShortcutKeyEvent, bindings: KeyBinding[], mac: boolean,
  enabled: (commandId: string) => boolean): boolean {
  const stroke = eventStroke(event);
  if (!stroke || isProtectedStroke(stroke, mac)) return false;
  return bindings.some((binding) => !binding.removed && binding.strokes[0] === stroke &&
    contextMatches(binding, 'terminal') && bindingBeatsShell(binding, mac) && enabled(binding.commandId));
}

/** Menus cannot inspect DOM focus, so send native accelerators a context-filtered view. */
export function nativeMenuBindingsForContext(bindings: KeyBinding[], opts: {
  context: BindingContext; suppressAppShortcuts: boolean;
}, mac: boolean): KeyBinding[] {
  return bindings.map((binding) => {
    const global = !binding.context || binding.context === 'global';
    const suppressed = global && (opts.suppressAppShortcuts || (opts.context === 'terminal' && !bindingBeatsShell(binding, mac)));
    return suppressed ? { ...binding, removed: true } : binding;
  });
}

export interface ShortcutDispatchOptions {
  bindings: () => KeyBinding[];
  enabled: (commandId: string) => boolean;
  execute: (commandId: string) => void;
  isMac: boolean;
  timeoutMs?: number;
}

/** Stateful two-stroke matcher. Pending sequences never survive blur, Escape or timeout. */
export function createShortcutDispatcher(options: ShortcutDispatchOptions) {
  let pending: { bindings: KeyBinding[]; context: BindingContext } | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    pending = null;
    if (timeout) clearTimeout(timeout);
    timeout = null;
  };
  const dispatch = (event: ShortcutKeyEvent, context: BindingContext): boolean => {
    const stroke = eventStroke(event);
    if (!stroke) { if (event.isComposing || event.getModifierState?.('AltGraph')) cancel(); return false; }
    if (stroke === 'esc' && pending) { cancel(); return true; }
    if (isProtectedStroke(stroke, options.isMac)) { cancel(); return false; }
    if (pending) {
      if (event.repeat && pending.bindings.some((binding) => binding.strokes[0] === stroke)) return true;
      const match = pending.context === context ? pending.bindings.find((binding) =>
        binding.strokes[1] === stroke && options.enabled(binding.commandId)) : undefined;
      cancel();
      if (match) { options.execute(match.commandId); return true; }
    }
    const matches = options.bindings().filter((binding) => !binding.removed && binding.strokes[0] === stroke &&
      contextMatches(binding, context) && (context !== 'terminal' || bindingBeatsShell(binding, options.isMac)) &&
      options.enabled(binding.commandId)).sort((left, right) => Number(right.context === context) - Number(left.context === context));
    if (!matches.length) return false;
    const focusedMatches = matches[0].context === context ? matches.filter((binding) => binding.context === context) : matches;
    const sequence = focusedMatches.filter((binding) => binding.strokes.length === 2);
    if (sequence.length) {
      if (event.repeat) return true;
      pending = { bindings: sequence, context };
      timeout = setTimeout(cancel, options.timeoutMs ?? 1000);
      return true;
    }
    options.execute(focusedMatches[0].commandId);
    return true;
  };
  return { dispatch, cancel, isPending: () => pending !== null };
}
