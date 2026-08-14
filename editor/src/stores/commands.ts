import { create } from 'zustand';
import type { Command } from '../types';

export interface CommandsState {
  commands: Map<string, Command>;
  registerCommand: (command: Command) => void;
  registerCommands: (commands: Command[]) => void;
  unregisterCommand: (id: string) => void;
  executeCommand: (id: string) => boolean;
  getCommands: () => Command[];
  getCommandsByCategory: (category: string) => Command[];
  getKeybindings: () => Array<{ id: string; keybinding: string; handler: () => void }>;
}

export const useCommandsStore = create<CommandsState>((set, get) => ({
  commands: new Map(),

  registerCommand: (command) => {
    set((state) => {
      const next = new Map(state.commands);
      next.set(command.id, command);
      return { commands: next };
    });
  },

  registerCommands: (commands) => {
    set((state) => {
      const next = new Map(state.commands);
      for (const cmd of commands) {
        next.set(cmd.id, cmd);
      }
      return { commands: next };
    });
  },

  unregisterCommand: (id) => {
    set((state) => {
      const next = new Map(state.commands);
      next.delete(id);
      return { commands: next };
    });
  },

  executeCommand: (id) => {
    const cmd = get().commands.get(id);
    if (!cmd) return false;
    if (cmd.when && !cmd.when()) return false;
    cmd.handler();
    return true;
  },

  getCommands: () => {
    return Array.from(get().commands.values()).filter((cmd) => !cmd.when || cmd.when());
  },

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
