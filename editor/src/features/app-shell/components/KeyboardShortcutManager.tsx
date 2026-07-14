import { useMemo } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { useCommandsStore } from '../../../stores/commands';

function HotkeyBinding({ keybinding, handler }: { keybinding: string; handler: () => void }) {
  useHotkeys(keybinding, (e) => {
    // Carve-out: Monaco's find/replace widget (`.find-widget`) is a form element,
    // so `enableOnFormTags: true` would otherwise let every app shortcut fire while
    // typing in it (e.g. mod+g, mod+shift+f) and shadow the widget's own keymap.
    if ((e.target as HTMLElement | null)?.closest('.find-widget')) return;
    e.preventDefault();
    handler();
  }, { enableOnFormTags: true });
  return null;
}

function KeyboardShortcutManager() {
  // Select the commands Map directly (stable reference when unchanged)
  const commands = useCommandsStore((s) => s.commands);

  // Derive keybindings from the Map in a memo
  const keybindings = useMemo(() => {
    return Array.from(commands.values())
      .filter((cmd) => cmd.keybinding)
      .map((cmd) => ({
        id: cmd.id,
        keybinding: cmd.keybinding!,
        handler: () => {
          if (!cmd.when || cmd.when()) cmd.handler();
        },
      }));
  }, [commands]);

  return (
    <>
      {keybindings.map((kb) => (
        <HotkeyBinding key={kb.id} keybinding={kb.keybinding} handler={kb.handler} />
      ))}
    </>
  );
}

export default KeyboardShortcutManager;
