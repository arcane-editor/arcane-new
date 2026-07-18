import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import { invoke } from '@tauri-apps/api/core';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { escapePathForShell } from '../shell-escape';
import { overrideKeySequence } from '../key-sequences';
import { useTerminalStore } from '../../../stores/terminal';
import { useThemeStore } from '../../../stores/theme';
import { useSettingsStore } from '../../../stores/settings';
import { registerTerminal, unregisterTerminal } from '../../theme';
import { safeUnlisten, listenScoped } from '../../../utils/tauri-listener';
import { isMac } from '../../../utils/platform';
import { register, unregister } from '../terminal-registry';

interface Props {
  id: number;
}

/**
 * How many UTF-16 units to let pile up before acking the backend.
 * VS Code's `CharCountAckSize` (`src/vs/platform/terminal/common/terminal.ts`).
 * Must stay <= the backend's low watermark, or it could never unpause.
 */
const CHAR_COUNT_ACK_SIZE = 5000;

/**
 * Handles Cmd+V (mac) / Ctrl+Shift+V for a terminal.
 *
 * An image on the clipboard is spilled to a PNG on disk and its shell-escaped
 * path is typed in, because a terminal is a byte stream and cannot carry image
 * bytes through a paste — a path is the only thing a TUI can actually receive,
 * and Claude Code reads images from paths.
 *
 * Text goes through `term.paste()` rather than `write()`, which is what applies
 * bracketed paste (ESC[200~ … ESC[201~) when the running program has asked for
 * it. That's how Claude Code tells a multi-line paste from someone hitting
 * Enter, so hand-rolling this would submit the prompt on the first newline.
 */
async function pasteIntoTerminal(term: Terminal): Promise<void> {
  try {
    const imagePath = await invoke<string | null>('terminal_clipboard_image_to_temp');
    if (imagePath) {
      term.paste(escapePathForShell(imagePath));
      return;
    }
  } catch {
    // Fall through to text: a clipboard with no image is the normal case.
  }

  try {
    const text = await readText();
    if (text) term.paste(text);
  } catch {
    // Nothing usable on the clipboard.
  }
}

function TerminalInstance({ id }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const fitNowRef = useRef<() => void>(() => {});
  const fontFamily = useSettingsStore((s) => s.settings['terminal.fontFamily']);
  const fontSize = useSettingsStore((s) => s.settings['terminal.fontSize']);
  const cursorBlink = useSettingsStore((s) => s.settings['terminal.cursorBlink']);

  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;
    let term: Terminal | null = null;
    let fitAddon: FitAddon | null = null;
    let dataDisposable: { dispose: () => void } | null = null;
    let resizeDisposable: { dispose: () => void } | null = null;
    let unlistenOutputFn: (() => void) | null = null;
    let unlistenExitFn: (() => void) | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let rafId: number | null = null;
    let onPasteCapture: ((e: ClipboardEvent) => void) | null = null;
    const container = containerRef.current;

    (async () => {
      // Wait for fonts to be ready BEFORE opening the terminal. xterm caches
      // the character cell width on first paint, and if the font isn't ready
      // it measures a fallback whose cells don't match the real glyphs —
      // resulting in the "c o n t e n t" wide-spacing artifact. With a
      // system-mono default this resolves immediately.
      try {
        await document.fonts.ready;
      } catch { /* ignore */ }
      if (cancelled || !containerRef.current) return;

      const settings = useSettingsStore.getState().settings;
      const terminalTheme = useThemeStore.getState().getActiveTheme().terminal;
      term = new Terminal({
        theme: terminalTheme,
        fontFamily: settings['terminal.fontFamily'] as string,
        fontSize: settings['terminal.fontSize'] as number,
        cursorBlink: settings['terminal.cursorBlink'] as boolean,
        allowProposedApi: true,
      });

      fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(new WebLinksAddon());

      // Unicode 11 width tables. xterm defaults to Unicode 6, which measures a
      // lot of what a modern TUI draws at the wrong width — emoji, and the
      // symbols Claude Code builds its UI from. A width disagreement drifts
      // columns exactly the way the UTF-8 split did, and just as permanently,
      // because Ink positions every frame relative to the last one. This is
      // what `allowProposedApi` above is for; it was set but unused.
      term.loadAddon(new Unicode11Addon());
      term.unicode.activeVersion = '11';

      term.open(containerRef.current);

      // WebGL renderer. xterm v6 ships no canvas renderer, so without this the
      // DOM renderer runs — the slowest path for full-screen TUI repaints,
      // which is the whole workload here. VS Code's strategy for context loss
      // (which the OS can trigger on GPU pressure or sleep/wake): dispose and
      // let xterm fall back to DOM rather than leave a dead canvas.
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch {
        // No WebGL context available (software rendering, remote session):
        // the DOM renderer still works, just slower.
      }
      termRef.current = term;
      fitAddonRef.current = fitAddon;
      registerTerminal(id, term);
      // Lets command handlers (split, focus-next/previous-pane) and the
      // tab-switch effect in RichTerminalPanel move REAL keyboard focus into
      // this pane's xterm instance — plain store-state updates don't do
      // that on their own, and a pane mounted in a `display:none` slot
      // can't be focused by DOM lookup alone.
      register(id, () => termRef.current?.focus());

      // Non-null alias for the closures below (`term` is typed nullable and
      // reassigned by cleanup).
      const localTerm = term;

      const mac = isMac();
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== 'keydown') return true;

        // Shift+Enter -> Meta+Enter, so a TUI can distinguish it from Enter.
        // This is what Claude Code's `/terminal-setup` would install for us if
        // it knew what Arcane was; it only knows how to edit the config files
        // of terminals it recognises, so it refuses. Doing it here means the
        // command is never needed. See key-sequences.ts for the full why.
        const override = overrideKeySequence(e);
        if (override !== null) {
          invoke('terminal_write', { id, data: override }).catch(() => {});
          return false;
        }

        // Three pane commands (mod+\, mod+shift+[, mod+shift+]) are Ctrl-
        // chords on non-mac platforms (mod=Ctrl there). xterm's default
        // keydown handling would otherwise ALSO forward them to the PTY —
        // Ctrl+\ as the literal SIGQUIT byte (0x1C), Ctrl+Shift+[ / Ctrl+
        // Shift+] as escape sequences — double-firing alongside the app-level
        // command and leaking into whatever's running in the shell (vim, a
        // REPL, etc). Returning `false` tells xterm to ignore the keystroke
        // entirely so only the document-level command handler
        // (KeyboardShortcutManager) sees it. On macOS these are Cmd-chords
        // instead; xterm never forwards Cmd combinations to the PTY to begin
        // with, so this guard is naturally dormant there.
        if (!mac) {
          if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.code === 'Backslash') {
            return false;
          }
          if (
            e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey &&
            (e.code === 'BracketLeft' || e.code === 'BracketRight')
          ) {
            return false;
          }
        }

        // ---- Clipboard ----------------------------------------------------
        // THE ONE THAT MATTERS: plain Ctrl+V must reach the PTY untouched as
        // 0x16. Claude Code reads the system clipboard *itself* when it sees
        // Ctrl+V — that is exactly why Ctrl+V attaches images in iTerm2 and
        // Cmd+V doesn't, since a terminal is a byte stream and cannot carry an
        // image through a text paste. Intercepting Ctrl+V to be "helpful"
        // would permanently break that. The early return is explicit so nobody
        // adds a Ctrl+V branch below without reading this.
        if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.code === 'KeyV') {
          return true;
        }

        // Everything else clipboard-related is macOS's job to deliver, not
        // ours to intercept: the native Edit menu (src-tauri/src/menu.rs) turns
        // Cmd+C/Cmd+V into real `copy`/`paste` DOM events, and xterm already
        // handles both — including bracketed paste. Adding a Cmd+V chord here
        // would paste twice. Off macOS no menu is ever built, so no clipboard
        // events fire and these chords are the only path there.
        if (!mac) {
          if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.code === 'KeyC') {
            const selection = localTerm.getSelection();
            // No selection: let it through — Ctrl+Shift+C means other things.
            if (!selection) return true;
            void writeText(selection).catch(() => {});
            return false;
          }
          if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.code === 'KeyV') {
            void pasteIntoTerminal(localTerm);
            return false;
          }
        }

        return true;
      });

      // Image paste. xterm's *only* clipboard read is `getData("text/plain")`
      // (verified in the shipped bundle), so pasting an image hands it an
      // empty string and silently does nothing — the gap this closes.
      //
      // Capture phase is required: xterm's own paste handler calls
      // stopPropagation(), so a bubble-phase listener here would never run.
      // Text is deliberately left to xterm, which already does it correctly.
      onPasteCapture = (e: ClipboardEvent) => {
        const items = e.clipboardData?.items;
        if (!items) return;
        const hasImage = Array.from(items).some(
          (i) => i.kind === 'file' && i.type.startsWith('image/')
        );
        if (!hasImage) return;
        e.preventDefault();
        e.stopPropagation();
        void pasteIntoTerminal(localTerm);
      };
      containerRef.current.addEventListener('paste', onPasteCapture, { capture: true });

      // Without this, the xterm helper-textarea has no focus on mount and
      // first keystrokes go nowhere — common cause of "delete doesn't work"
      // until the user clicks into the panel.
      term.focus();

      // Force-invalidate xterm's cached cell width by toggling fontFamily.
      // Same-value reassignment doesn't always trip the internal cache; a
      // throwaway swap guarantees re-measure with the now-loaded font.
      const original = term.options.fontFamily;
      term.options.fontFamily = `${original ?? 'monospace'} `;
      term.options.fontFamily = original;

      // The ONLY place the PTY is told about a size change. xterm and the PTY
      // disagreeing on width is what shreds a full-screen TUI: Ink wraps its
      // frame to the width TIOCGWINSZ reports, then erases exactly that many
      // lines next frame — so if xterm re-wraps those lines into a different
      // row count, the erase is wrong and every later frame compounds it.
      // Deriving the notification from xterm's own onResize (rather than
      // reading term.rows/cols by hand after each fit) makes divergence
      // structurally impossible: whatever resizes xterm, for whatever reason,
      // the PTY hears about it.
      resizeDisposable = localTerm.onResize(({ cols, rows }) => {
        invoke('terminal_resize', { id, rows, cols }).catch(() => {});
      });

      // Measure and apply; onResize does the rest.
      const fitNow = () => {
        const fa = fitAddonRef.current;
        const t = termRef.current;
        const el = containerRef.current;
        if (!fa || !t || !el) return;

        // A pane in a `display:none` slot (inactive tab/group) or inside a
        // collapsed panel measures 0x0. Don't fit — keep the last good
        // geometry so the PTY is never told about a size that isn't real.
        const { width, height } = el.getBoundingClientRect();
        if (width === 0 || height === 0) return;

        // proposeDimensions() over a blind fit(): it hands back xterm's own
        // measurement so we can sanity-check it before acting, and skip the
        // reflow entirely when nothing actually changed.
        const dims = fa.proposeDimensions();
        if (
          !dims ||
          !Number.isFinite(dims.cols) ||
          !Number.isFinite(dims.rows) ||
          dims.cols < 1 ||
          dims.rows < 1
        ) {
          return;
        }
        if (dims.cols === t.cols && dims.rows === t.rows) return;
        t.resize(dims.cols, dims.rows);
      };
      fitNowRef.current = fitNow;

      // Coalesce to one fit per frame. A sash drag fires ResizeObserver far
      // faster than a terminal needs re-fitting and every fit reflows the
      // whole buffer — but a trailing debounce is worse than useless here: it
      // leaves xterm at a stale size for the entire drag, which is exactly the
      // divergence above. One fit per frame keeps the two in lockstep, the way
      // a real terminal SIGWINCHes continuously while its window is dragged.
      const scheduleFit = () => {
        if (rafId !== null) return;
        rafId = requestAnimationFrame(() => {
          rafId = null;
          fitNow();
        });
      };

      dataDisposable = localTerm.onData((data) => {
        invoke('terminal_write', { id, data }).catch(() => {});
      });

      // Flow-control ack, in UTF-16 units to match what the backend counts.
      let unacked = 0;

      const outputFn = await listenScoped<{ id: number; data: string }>(
        'terminal-output',
        (event) => {
          if (event.payload.id !== id) return;
          const data = event.payload.data;
          // The callback fires once xterm has actually PARSED the data, not
          // merely received it — which is what makes this real backpressure
          // rather than a delivery receipt. The backend pauses the PTY while
          // too much is unacknowledged, so a missed ack throttles this
          // terminal and a phantom one lets its buffer overflow.
          localTerm.write(data, () => {
            unacked += data.length;
            if (unacked >= CHAR_COUNT_ACK_SIZE) {
              invoke('terminal_ack', { id, count: unacked }).catch(() => {});
              unacked = 0;
            }
          });
        }
      );
      if (cancelled) {
        safeUnlisten(outputFn);
        return;
      }
      unlistenOutputFn = outputFn;

      const exitFn = await listenScoped<{ id: number; exit_code: number | null }>(
        'terminal-exit',
        (event) => {
          if (event.payload.id === id) {
            localTerm.write('\r\n\x1b[90m[Process exited]\x1b[0m\r\n');
            useTerminalStore.getState().markExited(id);
          }
        }
      );
      if (cancelled) {
        safeUnlisten(exitFn);
        return;
      }
      unlistenExitFn = exitFn;

      resizeObserver = new ResizeObserver(scheduleFit);
      if (containerRef.current) resizeObserver.observe(containerRef.current);

      // One frame before measuring: xterm can only report cell dimensions once
      // it has painted, so proposeDimensions() is meaningless before this.
      //
      // Raced against a timer rather than awaited outright: rAF is throttled or
      // suspended entirely while a window is occluded, and attach is now the
      // one gate on this terminal producing any output at all. Waiting on a
      // frame that may never come would leave a permanently blank terminal —
      // a worse failure than fitting a beat late, which the ResizeObserver
      // corrects anyway.
      await Promise.race([
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 100)),
      ]);
      if (cancelled) return;
      fitNow();

      // Unpark the shell — LAST, and deliberately so. terminal_spawn leaves the
      // reader parked, because a PTY draining into a webview that has no
      // listener yet is output thrown away (Tauri discards it and reports
      // success). Attaching only now means the listeners above are live and the
      // geometry is real, so the shell's very first paint — profile output, the
      // prompt — is both delivered and correctly sized.
      await invoke('terminal_attach', {
        id,
        rows: localTerm.rows,
        cols: localTerm.cols,
      }).catch(() => {});
    })();

    return () => {
      cancelled = true;
      unregisterTerminal(id);
      unregister(id);
      dataDisposable?.dispose();
      resizeDisposable?.dispose();
      safeUnlisten(unlistenOutputFn);
      safeUnlisten(unlistenExitFn);
      resizeObserver?.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (onPasteCapture) {
        container?.removeEventListener('paste', onPasteCapture, { capture: true });
      }
      fitNowRef.current = () => {};
      term?.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, [id]);

  // Apply live setting changes to the existing terminal so users see updates
  // without reopening the tab. A font change alters the cell size, so the
  // column count changes even though the container didn't — refit. No explicit
  // resize IPC here: fitNow goes through term.resize(), and onResize is the
  // single notifier.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontFamily = fontFamily as string;
    term.options.fontSize = fontSize as number;
    term.options.cursorBlink = cursorBlink as boolean;
    fitNowRef.current();
  }, [id, fontFamily, fontSize, cursorBlink]);

  return (
    <div
      ref={containerRef}
      className="terminal-xterm"
      // Lets the window-level OS drop handler work out which pane a file was
      // dropped on. Tauri delivers drops natively (dragDropEnabled defaults to
      // true), so no DOM drop event ever fires here to tell us — the handler
      // only gets a window coordinate and has to hit-test it back to a pane.
      data-terminal-id={id}
      onClick={() => termRef.current?.focus()}
    />
  );
}

export default TerminalInstance;
