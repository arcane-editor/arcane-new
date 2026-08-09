import { useMemo } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { useCommandsStore } from '../../../stores/commands';
import { isMac } from '../../../utils/platform';
import { commandBeatsShell } from '../skip-shell';

function HotkeyBinding({
  id,
  keybinding,
  handler,
}: {
  id: string;
  keybinding: string;
  handler: () => void;
}) {
  useHotkeys(keybinding, (e) => {
    const target = e.target as HTMLElement | null;
    // Carve-out: Monaco's find/replace widget (`.find-widget`) is a form element,
    // so `enableOnFormTags: true` would otherwise let every app shortcut fire while
    // typing in it (e.g. mod+g, mod+shift+f) and shadow the widget's own keymap.
    if (target?.closest('.find-widget')) return;

    // Same problem, different owner: xterm's helper element is a <textarea>, so
    // every app chord fires while a terminal has focus. Worse than shadowing —
    // xterm's key handler sits on its own element and runs first, so the byte
    // is already on its way to the PTY and BOTH things happen. Returning
    // without preventDefault leaves the keystroke to the shell alone.
    if (
      target?.closest('.terminal-xterm') &&
      !commandBeatsShell(id, keybinding, { isMac: isMac(), inTerminal: true })
    ) {
      return;
    }

    e.preventDefault();
    handler();
    // enableOnFormTags covers <input>/<textarea>/<select>, but v5 gates
    // contenteditable behind a *separate* option (dist/index.js:194 bails when
    // `target.isContentEditable && !enableOnContentEditable`). Without it every
    // app chord is dead while typing in the Lexical AI chat box. Enabling it
    // makes that box behave like every other input rather than a special case.
  }, { enableOnFormTags: true, enableOnContentEditable: true });
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
        <HotkeyBinding key={kb.id} id={kb.id} keybinding={kb.keybinding} handler={kb.handler} />
      ))}
    </>
  );
}

export default KeyboardShortcutManager;
