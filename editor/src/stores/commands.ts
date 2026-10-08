import { create } from 'zustand';
import type { Command } from '../types';
import type { KeyBinding } from '../types/editor-experience';
import { bindingsFromCommand } from '../utils/editor-keybindings';
import { isMac } from '../utils/platform';
import { MONACO_ACTION_LABELS } from '../utils/editor-action-labels';

interface EditorCommandTarget {
  focused: () => boolean;
  supports: (actionId: string) => boolean;
  execute: (actionId: string) => void;
}
const editorTargets = new Set<EditorCommandTarget>();
const EDITOR_COMMAND_ACTIONS: Record<string, string> = {
  'editor.formatDocument': 'editor.action.formatDocument',
  'editor.gotoLine': 'editor.action.gotoLine',
  'editor.gotoSymbol': 'editor.action.quickOutline',
  'editor.refactor': 'editor.action.refactor',
  'editor.quickFix': 'editor.action.quickFix',
};
function experienceOverlayOpen(): boolean {
  return typeof document !== 'undefined' && !!document.querySelector('.experience-startup,.experience-overlay,[data-workspace-change-overlay]');
}

export function registerEditorCommandTarget(target: EditorCommandTarget): () => void {
  editorTargets.add(target);
  return () => { editorTargets.delete(target); };
}

function displayCommands(base: Map<string, Command>, bindings: KeyBinding[]): Map<string, Command> {
  const commands = new Map(Array.from(base.values(), (command) => {
    const chords = bindings.filter((binding) => !binding.removed && binding.commandId === command.id)
      .map((binding) => binding.strokes.join(' '));
    return [command.id, { ...command, keybinding: chords[0], extraKeybindings: chords.slice(1) }];
  }));
  const editorActions = new Map<string, string[]>();
  for (const binding of bindings) {
    if (binding.removed || !binding.commandId.startsWith('monaco:')) continue;
    const chords = editorActions.get(binding.commandId) ?? [];
    const chord = binding.strokes.join(' ');
    if (!chords.includes(chord)) chords.push(chord);
    editorActions.set(binding.commandId, chords);
  }
  for (const [id, chords] of editorActions) {
    const label = MONACO_ACTION_LABELS[id.slice(7)];
    if (label) commands.set(id, { id, label, category: 'Editor', keybinding: chords[0], extraKeybindings: chords.slice(1),
      when: () => useCommandsStore.getState().canExecuteCommand(id),
      handler: () => { useCommandsStore.getState().executeCommand(id); } });
  }
  return commands;
}

export interface CommandsState {
  commands: Map<string, Command>;
  /** Original registration data; profile resolution never mutates command handlers. */
  baseCommands: Map<string, Command>;
  resolvedBindings: KeyBinding[];
  getBaseCommands: () => Command[];
  setResolvedKeybindings: (bindings: KeyBinding[]) => void;
  canExecuteCommand: (id: string) => boolean;
  registerCommand: (command: Command) => void;
  registerCommands: (commands: Command[]) => void;
  unregisterCommand: (id: string) => void;
  executeCommand: (id: string) => boolean;
  getCommands: () => Command[];
  getAllCommands: () => Command[];
  getCommandsByCategory: (category: string) => Command[];
  getKeybindings: () => Array<{ id: string; keybinding: string; handler: () => void }>;
}

export const useCommandsStore = create<CommandsState>((set, get) => ({
  commands: new Map(),
  baseCommands: new Map(),
  resolvedBindings: [],
  getBaseCommands: () => Array.from(get().baseCommands.values()),
  setResolvedKeybindings: (bindings) => set((state) => ({ resolvedBindings: bindings,
    commands: displayCommands(state.baseCommands, bindings) })),
  canExecuteCommand: (id) => {
    if (experienceOverlayOpen()) return false;
    if (id.startsWith('monaco:')) return Array.from(editorTargets).some((target) => target.focused() && target.supports(id.slice(7)));
    const command = get().baseCommands.get(id);
    if (!command || (command.when && !command.when())) return false;
    const editorAction = EDITOR_COMMAND_ACTIONS[id];
    return !editorAction || Array.from(editorTargets).some((target) => target.focused() && target.supports(editorAction));
  },

  registerCommand: (command) => {
    set((state) => {
      const next = new Map(state.baseCommands);
      next.set(command.id, command);
      const bindings = state.resolvedBindings.filter((binding) => binding.commandId !== command.id)
        .concat(bindingsFromCommand(command, isMac()));
      return { baseCommands: next, resolvedBindings: bindings, commands: displayCommands(next, bindings) };
    });
  },

  registerCommands: (commands) => {
    set((state) => {
      const next = new Map(state.baseCommands);
      for (const cmd of commands) {
        next.set(cmd.id, cmd);
      }
      const added = new Set(commands.map((command) => command.id));
      const bindings = state.resolvedBindings.filter((binding) => !added.has(binding.commandId))
        .concat(commands.flatMap((command) => bindingsFromCommand(command, isMac())));
      return { baseCommands: next, resolvedBindings: bindings, commands: displayCommands(next, bindings) };
    });
  },

  unregisterCommand: (id) => {
    set((state) => {
      const next = new Map(state.baseCommands);
      next.delete(id);
      const bindings = state.resolvedBindings.filter((binding) => binding.commandId !== id);
      return { baseCommands: next, resolvedBindings: bindings, commands: displayCommands(next, bindings) };
    });
  },

  executeCommand: (id) => {
    if (experienceOverlayOpen()) return false;
    if (id.startsWith('monaco:')) {
      const target = Array.from(editorTargets).find((candidate) => candidate.focused() && candidate.supports(id.slice(7)));
      if (!target) return false;
      target.execute(id.slice(7));
      return true;
    }
    const cmd = get().commands.get(id);
    if (!cmd) return false;
    // Keyboard ownership additionally requires a focused supported editor.
    // Menu/palette dispatch preserves the command's own gate; editor handlers
    // safely choose the active pane and check support after native focus moves.
    if (cmd.when && !cmd.when()) return false;
    cmd.handler();
    return true;
  },

  getCommands: () => {
    return Array.from(get().commands.values()).filter((cmd) => !cmd.when || cmd.when());
  },

  // Unfiltered, unlike getCommands. The keyboard-shortcuts sheet documents
  // the keymap, not the current state of the window: filtering by `when`
  // would hide every Unity and workspace-gated chord from the one screen
  // someone opens specifically to find out which chords exist.
  getAllCommands: () => Array.from(get().commands.values()),

  getCommandsByCategory: (category) => {
    return get().getCommands().filter((cmd) => cmd.category === category);
  },

  getKeybindings: () => {
    return Array.from(get().commands.values())
      .filter((cmd) => cmd.keybinding)
      .map((cmd) => ({
        id: cmd.id,
        keybinding: cmd.keybinding!,
        handler: () => {
          if (!cmd.when || cmd.when()) cmd.handler();
        },
      }));
  },
}));
