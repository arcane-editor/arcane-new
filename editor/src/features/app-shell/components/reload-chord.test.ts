import { describe, it, expect } from 'bun:test';
import { isWebviewReloadChord } from './KeyboardShortcutManager';

/**
 * F5 and Ctrl+R are WebView2's own reload accelerators. Nothing in the command
 * registry bound them, so they reached the webview and reloaded the whole app —
 * losing unsaved buffers, terminal sessions and the AI thread to a mistyped key.
 *
 * It stopped being merely bad when `unity.play` moved to F5: that command is
 * `when`-gated to Unity projects, so in any other project the key fell straight
 * through to a reload.
 *
 * Suppression only — `preventDefault` without `stopPropagation`. The command
 * still runs (Ctrl+Shift+R is `editor.refactor`), and xterm does not consult
 * `defaultPrevented`, so Ctrl+R still reaches the shell as reverse-search.
 */
const ev = (init: Partial<KeyboardEvent> & { code: string }) =>
  ({ ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...init }) as KeyboardEvent;

describe('isWebviewReloadChord', () => {
  it('claims the three chords the webview reloads on', () => {
    expect(isWebviewReloadChord(ev({ code: 'F5' }))).toBe(true);
    expect(isWebviewReloadChord(ev({ code: 'KeyR', ctrlKey: true }))).toBe(true);
    expect(isWebviewReloadChord(ev({ code: 'KeyR', ctrlKey: true, shiftKey: true }))).toBe(true);
  });

  it('claims Shift+F5 too, which is Chromium hard-reload and unity.stop', () => {
    expect(isWebviewReloadChord(ev({ code: 'F5', shiftKey: true }))).toBe(true);
  });

  it('claims Cmd+R on macOS', () => {
    expect(isWebviewReloadChord(ev({ code: 'KeyR', metaKey: true }))).toBe(true);
  });

  it('leaves a bare R alone, so typing still works', () => {
    expect(isWebviewReloadChord(ev({ code: 'KeyR' }))).toBe(false);
    expect(isWebviewReloadChord(ev({ code: 'KeyR', shiftKey: true }))).toBe(false);
  });

  it('leaves the other function keys alone', () => {
    expect(isWebviewReloadChord(ev({ code: 'F6' }))).toBe(false);
    expect(isWebviewReloadChord(ev({ code: 'F7' }))).toBe(false);
    expect(isWebviewReloadChord(ev({ code: 'F12' }))).toBe(false);
  });

  it('does not claim AltGr+R, which types a character on some layouts', () => {
    expect(isWebviewReloadChord(ev({ code: 'KeyR', ctrlKey: true, altKey: true }))).toBe(false);
  });
});
