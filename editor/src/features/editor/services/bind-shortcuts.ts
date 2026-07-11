import type { Monaco } from '@monaco-editor/react';
import type { editor as MonacoEditorNs } from 'monaco-editor';
import { useCommandsStore } from '../../../stores/commands';
import { parseHotkeyToMonaco } from '../../../utils/hotkey-to-monaco';

export function bindGlobalShortcutsToMonaco(
  editor: MonacoEditorNs.IStandaloneCodeEditor,
  monaco: Monaco
): () => void {
  const registered = new Set<string>();

  const sync = () => {
    const all = useCommandsStore.getState().commands;
    for (const cmd of all.values()) {
      if (!cmd.keybinding) continue;
      const tag = `${cmd.id}|${cmd.keybinding}`;
      if (registered.has(tag)) continue;
      const bitfield = parseHotkeyToMonaco(cmd.keybinding, monaco);
      if (bitfield === null) {
        if (import.meta.env.DEV) console.warn('[Shortcuts] Unparseable keybinding, not bound in editor:', cmd.keybinding, cmd.id);
        continue;
      }
      const cmdId = cmd.id;
      editor.addCommand(bitfield, () => {
        const live = useCommandsStore.getState().commands.get(cmdId);
        if (!live) return;
        if (live.when && !live.when()) return;
        live.handler();
      });
      registered.add(tag);
    }
  };

  sync();
  const unsubscribe = useCommandsStore.subscribe(sync);
  return unsubscribe;
}
