import { useMemo } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { useCommandsStore } from '../../../stores/commands';

function HotkeyBinding({ keybinding, handler }: { keybinding: string; handler: () => void }) {
  useHotkeys(keybinding, (e) => { e.preventDefault(); handler(); }, { enableOnFormTags: true });
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
