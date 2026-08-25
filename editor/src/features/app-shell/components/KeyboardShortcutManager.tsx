import { useMemo } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { useCommandsStore } from '../../../stores/commands';
import { isMac } from '../../../utils/platform';
import { commandBeatsShell } from '../skip-shell';

function HotkeyBinding({
  id,
  keybinding,
  enabled,
  handler,
}: {
  id: string;
  keybinding: string;
  /** The command's `when` gate, read at keystroke time. */
  enabled: () => boolean;
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

    // The `when` gate decides whether this chord is ours AT ALL right now, so
    // it has to be consulted before preventDefault, not after: swallowing a
    // keystroke outside the surface that owns it would break the key
    // everywhere while doing nothing.
    //
    // The gate bounds the damage, it does not remove it. `ai.effortUp` was
    // `mod+right` — line-end on macOS, word-jump on Windows — scoped to the AI
    // composer, so the only place it ever fired was a text box that needed
    // that key. A composer-scoped chord must be one no text field owns.
    if (!enabled()) return;

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
    return Array.from(commands.values()).flatMap((cmd) => {
      // Aliases bind exactly like the primary chord — same handler, same
      // `when` gate. Keyed by chord rather than by command id below, since a
      // command with aliases now yields more than one binding.
      const chords = [cmd.keybinding, ...(cmd.extraKeybindings ?? [])].filter(
        (c): c is string => !!c
      );
      return chords.map((keybinding) => ({
        id: cmd.id,
        keybinding,
        enabled: () => !cmd.when || cmd.when(),
        handler: cmd.handler,
      }));
    });
  }, [commands]);

  return (
    <>
      {keybindings.map((kb) => (
        <HotkeyBinding
          key={`${kb.id}|${kb.keybinding}`}
          id={kb.id}
          keybinding={kb.keybinding}
          enabled={kb.enabled}
          handler={kb.handler}
        />
      ))}
    </>
  );
}

export default KeyboardShortcutManager;
