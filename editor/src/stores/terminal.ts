import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { notify } from './notifications';

export interface TerminalInstance {
  id: number;
  name: string;
  isAlive: boolean;
}

interface TerminalState {
  terminals: TerminalInstance[];
  activeTerminalId: number | null;

  createTerminal: (cwd: string, shell?: string) => Promise<number | null>;
  killTerminal: (id: number) => Promise<void>;
  setActiveTerminal: (id: number) => void;
  markExited: (id: number) => void;
  removeTerminal: (id: number) => void;
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  terminals: [],
  activeTerminalId: null,

  createTerminal: async (cwd: string, shell?: string) => {
    let id: number;
    try {
      id = await invoke<number>('terminal_spawn', {
        cwd,
        shell: shell ?? null,
        rows: 24,
        cols: 80,
      });
    } catch (err) {
      notify.error(`Failed to spawn terminal: ${err}`);
      return null;
    }

    const shellName = (shell ?? detect_shell_name()).split('/').pop() ?? 'terminal';
    const count = get().terminals.length + 1;
    const instance: TerminalInstance = {
      id,
      name: `${shellName} ${count}`,
      isAlive: true,
    };

    set((state) => ({
      terminals: [...state.terminals, instance],
      activeTerminalId: id,
    }));

    return id;
  },

  killTerminal: async (id: number) => {
    await invoke('terminal_kill', { id });
    const { terminals, activeTerminalId } = get();
    const remaining = terminals.filter((t) => t.id !== id);
    let nextActive = activeTerminalId;
    if (activeTerminalId === id) {
      nextActive = remaining.length > 0
        ? remaining[remaining.length - 1].id
        : null;
    }
    set({ terminals: remaining, activeTerminalId: nextActive });
  },

  setActiveTerminal: (id) => set({ activeTerminalId: id }),

  markExited: (id) =>
    set((state) => ({
      terminals: state.terminals.map((t) =>
        t.id === id ? { ...t, isAlive: false } : t
      ),
    })),

  removeTerminal: (id) => {
    const { terminals, activeTerminalId } = get();
    const remaining = terminals.filter((t) => t.id !== id);
    let nextActive = activeTerminalId;
    if (activeTerminalId === id) {
      nextActive = remaining.length > 0
        ? remaining[remaining.length - 1].id
        : null;
    }
    set({ terminals: remaining, activeTerminalId: nextActive });
  },
}));

function detect_shell_name(): string {
  if (navigator.platform.includes('Win')) return 'cmd';
  return 'zsh';
}
