import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { notify } from './notifications';
import { useWorkspaceStore } from './workspace';
import {
  createGroup,
  addPane,
  removePane,
  focusPane,
  focusGroup,
  focusSibling,
  type GroupsState,
} from './terminal-groups';

export interface TerminalInstance {
  id: number;
  name: string;
  isAlive: boolean;
  // Spawn-time cwd. The backend never reports a PTY's *live* cwd (that would
  // need per-platform /proc or lsof introspection), so this is only ever the
  // directory the terminal was originally launched in. It's what lets
  // `splitTerminal` start a new pane in the same directory as its source.
  cwd: string;
}

interface TerminalState extends GroupsState {
  terminals: TerminalInstance[];

  createTerminal: (cwd: string, shell?: string) => Promise<number | null>;
  splitTerminal: (sourceId: number) => Promise<number | null>;
  killTerminal: (id: number) => Promise<void>;
  killGroup: (groupId: number) => Promise<void>;
  setActiveTerminal: (id: number) => void;
  setActiveGroup: (groupId: number) => void;
  focusSiblingPane: (dir: 1 | -1) => void;
  markExited: (id: number) => void;
  removeTerminal: (id: number) => void;
}

// Only ever merge these three GroupsState fields back into the zustand
// store — never spread a bare GroupsState object that might (in a no-op
// reducer branch) actually be the full store state reference itself.
function pickGroups(g: GroupsState): GroupsState {
  return { groups: g.groups, activeGroupId: g.activeGroupId, activeTerminalId: g.activeTerminalId };
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  terminals: [],
  groups: [],
  activeGroupId: null,
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
      cwd,
    };

    set((state) => ({
      terminals: [...state.terminals, instance],
      // New tab: the group id doubles up on the founding pane's terminal id
      // (both come from the same globally-unique backend id space) — the
      // group's own identity then stays stable even after that founding
      // pane is later closed while siblings remain.
      ...pickGroups(createGroup(state, id, id)),
    }));

    return id;
  },

  splitTerminal: async (sourceId: number) => {
    const source = get().terminals.find((t) => t.id === sourceId);
    // Splitting an exited pane is allowed — its stored cwd persists after
    // the process exits. Fall back to the workspace root only if the source
    // instance can't be found at all (shouldn't happen in normal usage).
    const cwd = source?.cwd || useWorkspaceStore.getState().workspacePath || '';
    if (!cwd) {
      notify.error('Cannot split terminal: no working directory available');
      return null;
    }

    let id: number;
    try {
      id = await invoke<number>('terminal_spawn', {
        cwd,
        shell: null,
        rows: 24,
        cols: 80,
      });
    } catch (err) {
      notify.error(`Failed to spawn terminal: ${err}`);
      return null;
    }

    const shellName = detect_shell_name();
    const count = get().terminals.length + 1;
    const instance: TerminalInstance = {
      id,
      name: `${shellName} ${count}`,
      isAlive: true,
      cwd,
    };

    set((state) => ({
      terminals: [...state.terminals, instance],
      ...pickGroups(addPane(state, sourceId, id)),
    }));

    return id;
  },

  killTerminal: async (id: number) => {
    await invoke('terminal_kill', { id });
    set((state) => ({
      terminals: state.terminals.filter((t) => t.id !== id),
      ...pickGroups(removePane(state, id)),
    }));
  },

  killGroup: async (groupId: number) => {
    const group = get().groups.find((g) => g.id === groupId);
    if (!group) return;
    const ids = [...group.terminalIds];

    await Promise.all(ids.map((id) => invoke('terminal_kill', { id }).catch(() => {})));

    set((state) => {
      let groupsState: GroupsState = state;
      for (const id of ids) {
        groupsState = removePane(groupsState, id);
      }
      return {
        terminals: state.terminals.filter((t) => !ids.includes(t.id)),
        ...pickGroups(groupsState),
      };
    });
  },

  setActiveTerminal: (id) => set((state) => pickGroups(focusPane(state, id))),

  setActiveGroup: (groupId) => set((state) => pickGroups(focusGroup(state, groupId))),

  focusSiblingPane: (dir) => set((state) => pickGroups(focusSibling(state, dir))),

  markExited: (id) =>
    set((state) => ({
      terminals: state.terminals.map((t) =>
        t.id === id ? { ...t, isAlive: false } : t
      ),
    })),

  removeTerminal: (id) => {
    set((state) => ({
      terminals: state.terminals.filter((t) => t.id !== id),
      ...pickGroups(removePane(state, id)),
    }));
  },
}));

function detect_shell_name(): string {
  if (navigator.platform.includes('Win')) return 'cmd';
  return 'zsh';
}
