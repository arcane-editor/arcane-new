import type { Monaco } from '@monaco-editor/react';
import type { editor as MonacoEditorNs, IDisposable } from 'monaco-editor';
import { registerEditorCommandTarget, useCommandsStore } from '../../../stores/commands';
import { parseHotkeyToMonaco } from '../../../utils/hotkey-to-monaco';

/**
 * The capture-phase document dispatcher owns app shortcuts and their `when`
 * gates, including editor actions. Monaco contributes disposable default
 * removal rules, so switching profiles removes former keys without adding
 * unconditional bindings that swallow a disabled action's fallback chord.
 */
export function bindGlobalShortcutsToMonaco(editor: MonacoEditorNs.IStandaloneCodeEditor, monaco: Monaco): () => void {
  let contributions: IDisposable[] = [];
  const unregister = registerEditorCommandTarget({
    focused: () => editor.hasTextFocus(),
    supports: (actionId) => !!editor.getAction(actionId)?.isSupported(),
    execute: (actionId) => editor.trigger('editor-experience', actionId, null),
  });
  const clear = () => {
    for (const contribution of contributions) contribution.dispose();
    contributions = [];
  };
  const sync = () => {
    clear();
    const bindings = useCommandsStore.getState().resolvedBindings;
    const removals: MonacoEditorNs.IKeybindingRule[] = [];
    for (const binding of bindings) {
      if (!binding.commandId.startsWith('monaco:')) continue;
      const keybinding = parseHotkeyToMonaco(binding.strokes.join(' '), monaco);
      if (keybinding === null) continue;
      const actionId = binding.commandId.slice(7);
      if (binding.removed) {
        removals.push({ keybinding, command: `-${actionId}` });
      }
    }
    if (removals.length) contributions.push(monaco.editor.addKeybindingRules(removals));
  };
  sync();
  const unsubscribe = useCommandsStore.subscribe((next, previous) => {
    if (next.resolvedBindings !== previous.resolvedBindings) sync();
  });
  return () => { unsubscribe(); clear(); unregister(); };
}
