import { useEffect } from 'react';
import { useCommandsStore } from '../stores/commands';
import type { Command } from '../types';

export function useRegisterCommands(commands: Command[]) {
  useEffect(() => {
    const store = useCommandsStore.getState();
    store.registerCommands(commands);
    return () => {
      for (const cmd of commands) {
        store.unregisterCommand(cmd.id);
      }
    };
  }, [commands.map((c) => c.id).join(',')]);
}
