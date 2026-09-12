import { useEffect, useMemo } from 'react';
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

    // AltGr reports itself as Ctrl+Alt, so on every non-US Windows layout a
    // `mod+alt+*` chord matches the keystrokes that type @ \ { } ~ | — and
    // the preventDefault below then swallows the character. No such chord is
    // registered any more (they moved to bare alt+<letter> and mod+PgUp/PgDn),
    // but this makes the class of bug unreachable rather than merely absent.
    if (e.getModifierState?.('AltGraph')) return;

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

/**
 * True for the chords the webview reloads on: F5, Ctrl+R, Ctrl+Shift+R.
 *
 * Nothing in the registry binds these, so today they reach WebView2 and
 * reload the whole app — losing every unsaved buffer, the terminal sessions
 * and the AI thread. That is bad on its own, and it becomes load-bearing
 * with `unity.play` on F5: that command is `when`-gated to Unity projects,
 * so in any other project the key would fall straight through to a reload.
 */
export function isWebviewReloadChord(e: KeyboardEvent): boolean {
  if (e.code === 'F5' && !e.ctrlKey && !e.altKey && !e.metaKey) return true;
  return e.code === 'KeyR' && (e.ctrlKey || e.metaKey) && !e.altKey;
}

function KeyboardShortcutManager() {
  // Select the commands Map directly (stable reference when unchanged)
  const commands = useCommandsStore((s) => s.commands);

  // Bound once, outside the registry, because it is a suppression rather
  // than a command: there is nothing to run, the key just must not reach the
  // webview. Capture phase so it lands before Monaco's and xterm's own
  // handlers, which sit on their elements.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isWebviewReloadChord(e)) e.preventDefault();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, []);

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
