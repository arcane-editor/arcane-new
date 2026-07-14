import type { Monaco } from '@monaco-editor/react';
import type { editor as MonacoEditorNs } from 'monaco-editor';
import { useCommandsStore } from '../../../stores/commands';
import { parseHotkeyToMonaco } from '../../../utils/hotkey-to-monaco';

// Every app command bridged into Monaco via `editor.addCommand` is registered
// with the `!findWidgetVisible` context precondition (Monaco's 3rd addCommand
// arg — a context-key expression string). Without it, `addCommand` installs a
// keybinding at the highest priority and fires unconditionally whenever the
// editor has focus, which shadows Monaco's own find/replace-widget keymap
// (e.g. app `editor.gotoLine` on mod+g shadows Monaco's built-in Find Next on
// Cmd+G) and makes the widget's own shortcuts unreliable while it's open.
// `findWidgetVisible` is Monaco's built-in context key (see
// CONTEXT_FIND_WIDGET_VISIBLE in monaco-editor's findModel.ts): guarding on
// its negation lets Monaco's find keymap win wholesale while the widget is
// visible; app commands remain reachable via the document-level hotkeys
// (KeyboardShortcutManager) when appropriate outside that context.
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
      editor.addCommand(
        bitfield,
        () => {
          const live = useCommandsStore.getState().commands.get(cmdId);
          if (!live) return;
          if (live.when && !live.when()) return;
          live.handler();
        },
        '!findWidgetVisible'
      );
      registered.add(tag);
    }
  };

  sync();
  const unsubscribe = useCommandsStore.subscribe(sync);
  return unsubscribe;
}
