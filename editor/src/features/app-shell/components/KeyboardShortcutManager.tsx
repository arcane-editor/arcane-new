import { useEffect } from 'react';
import { useCommandsStore } from '../../../stores/commands';
import type { BindingContext } from '../../../types/editor-experience';
import { createShortcutDispatcher } from '../../../utils/editor-keybindings';
import { isMac } from '../../../utils/platform';

/** Suppress webview reload even when a workspace-gated command is unavailable. */
export function isWebviewReloadChord(e: KeyboardEvent): boolean {
  if (e.code === 'F5' && !e.ctrlKey && !e.altKey && !e.metaKey) return true;
  return e.code === 'KeyR' && (e.ctrlKey || e.metaKey) && !e.altKey;
}

function contextFor(target: HTMLElement | null): BindingContext {
  if (target?.closest('.terminal-xterm')) return 'terminal';
  if (target?.closest('.monaco-editor')) return 'editor';
  if (target?.closest('input,textarea,select,[contenteditable="true"]')) return 'input';
  return 'global';
}

function KeyboardShortcutManager() {
  useEffect(() => {
    const dispatcher = createShortcutDispatcher({
      isMac: isMac(), bindings: () => useCommandsStore.getState().resolvedBindings,
      enabled: (id) => useCommandsStore.getState().canExecuteCommand(id),
      execute: (id) => { useCommandsStore.getState().executeCommand(id); },
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (isWebviewReloadChord(event)) event.preventDefault();
      const target = event.target instanceof HTMLElement ? event.target : null;
      // Find inputs and onboarding own their keyboard; no app command may answer behind them.
      if (target?.closest('.find-widget,.experience-startup,.experience-overlay') ||
          document.querySelector('.experience-overlay')) {
        dispatcher.cancel();
        return;
      }
      if (dispatcher.dispatch(event, contextFor(target))) {
        event.preventDefault();
        // Capture phase stops Monaco/xterm seeing an already-handled stroke.
        event.stopPropagation();
      }
    };
    const cancel = () => dispatcher.cancel();
    const unsubscribe = useCommandsStore.subscribe((next, previous) => {
      if (next.resolvedBindings !== previous.resolvedBindings) cancel();
    });
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', cancel);
    window.addEventListener('blur', cancel);
    return () => {
      dispatcher.cancel(); unsubscribe();
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', cancel);
      window.removeEventListener('blur', cancel);
    };
  }, []);
  return null;
}

export default KeyboardShortcutManager;
