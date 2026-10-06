import type { Command } from '../../../types';
import type { EditorExperienceState, ImportReportItem, KeyBinding } from '../../../types/editor-experience';
import { bindingKey, bindingsFromCommand, isProtectedStroke, normalizeBinding } from '../../../utils/editor-keybindings';
import { getDefaultEditorKeybindings, getPresetKeybindings, MONACO_ACTION_LABELS } from './keymaps';

const COMMAND_ALIASES: Record<string, string> = {
  'editor.gotoDefinition': 'monaco:editor.action.revealDefinition', 'editor.rename': 'monaco:editor.action.rename',
};

export function validateKeybindings(bindings: KeyBinding[], commands: Command[], mac: boolean): ImportReportItem[] {
  const known = new Set(commands.map((command) => command.id));
  const report: ImportReportItem[] = [];
  const seen = new Map<string, string>();
  for (const original of bindings) {
    const binding = normalizeBinding({ ...original, commandId: COMMAND_ALIASES[original.commandId] ?? original.commandId }, mac);
    const action = binding?.commandId.startsWith('monaco:') ? binding.commandId.slice(7) : null;
    const unsupported = !binding || (!known.has(binding.commandId) && (!action || !(action in MONACO_ACTION_LABELS)));
    const protectedKey = binding?.strokes.some((stroke) => isProtectedStroke(stroke, mac));
    const prior = binding && !binding.removed && seen.get(bindingKey(binding));
    if (unsupported || protectedKey || (prior && prior !== binding?.commandId)) report.push({ category: 'shortcuts',
      label: original.strokes.join(' '), status: protectedKey || prior ? 'conflicting' : 'unsupported',
      detail: protectedKey ? 'This shortcut belongs to native editing or the operating system.' : prior
        ? `This shortcut also belongs to ${prior}; the later mapping wins.` : 'This command or shortcut is not supported by UnityIDE.' });
    if (binding && !binding.removed) seen.set(bindingKey(binding), binding.commandId);
  }
  return report;
}

export function resolveKeybindings(commands: Command[], experience: EditorExperienceState, mac: boolean): KeyBinding[] {
  const known = new Set(commands.map((command) => command.id));
  let bindings: KeyBinding[] = [];
  const apply = (incoming: KeyBinding[], replaceCommands: boolean) => {
    const normalized = incoming.map((binding) => normalizeBinding({ ...binding,
      commandId: COMMAND_ALIASES[binding.commandId] ?? binding.commandId }, mac))
      .filter((binding): binding is KeyBinding => !!binding && !binding.strokes.some((stroke) => isProtectedStroke(stroke, mac)) &&
        (known.has(binding.commandId) || (binding.commandId.startsWith('monaco:') && binding.commandId.slice(7) in MONACO_ACTION_LABELS)));
    if (replaceCommands) {
      const replaced = new Set(normalized.filter((binding) => !binding.removed).map((binding) => binding.commandId));
      bindings = bindings.filter((binding) => !replaced.has(binding.commandId));
    }
    for (const binding of normalized) {
      if (binding.removed) {
        bindings = bindings.filter((prior) => !(prior.commandId === binding.commandId && (!binding.strokes.length || prior.strokes.join(' ') === binding.strokes.join(' ')) &&
          (!binding.context || binding.context === 'global' || binding.context === prior.context)));
        continue;
      }
      // One winning command per context/chord. A more specific editor binding can coexist with a global one.
      bindings = bindings.filter((prior) => bindingKey(prior) !== bindingKey(binding) &&
        !((binding.context === 'global' || !binding.context) && prior.strokes.join(' ') === binding.strokes.join(' ')));
      bindings.push(binding);
    }
  };
  apply(getDefaultEditorKeybindings(mac), false);
  for (const command of commands) {
    const defaults = bindingsFromCommand(command, mac).map((binding) => ({ ...binding,
      ...(command.skipMonacoBridge ? { context: command.id.startsWith('terminal.') ? 'terminal' as const : 'input' as const } : {}) }));
    if (!command.skipMonacoBridge) {
      // Preserve the original UnityIDE ownership: its app bridge won over
      // Monaco defaults and sequence prefixes on the same first stroke.
      bindings = bindings.filter((binding) => !binding.commandId.startsWith('monaco:') ||
        !defaults.some((app) => app.strokes.length === 1 && app.strokes[0] === binding.strokes[0]));
    }
    apply(defaults, false);
  }
  const shortcutProfile = experience.shortcutProfile ?? experience.profile;
  apply(getPresetKeybindings(shortcutProfile, experience.keymap, mac), true);
  // VS Code custom rules add shortcuts; only explicit removal rules disable
  // inherited ones. Rider custom action maps replace that action's key list.
  apply(experience.importedBindings, shortcutProfile !== 'vscode');
  apply(experience.userBindings, true);
  // Removal rules dispose Monaco's former default chords when a profile moves an action.
  const removals = getDefaultEditorKeybindings(mac).filter((baseline) => !bindings.some((binding) =>
    binding.commandId === baseline.commandId && bindingKey(binding) === bindingKey(baseline)))
    .map((baseline) => ({ ...baseline, removed: true }));
  return [...bindings, ...removals];
}
