import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { invoke } from '@tauri-apps/api/core';
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

function TerminalInstance({ id }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const fontFamily = useSettingsStore((s) => s.settings['terminal.fontFamily']);
  const fontSize = useSettingsStore((s) => s.settings['terminal.fontSize']);
  const cursorBlink = useSettingsStore((s) => s.settings['terminal.cursorBlink']);

  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;
    let term: Terminal | null = null;
    let fitAddon: FitAddon | null = null;
    let dataDisposable: { dispose: () => void } | null = null;
    let unlistenOutputFn: (() => void) | null = null;
    let unlistenExitFn: (() => void) | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;

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

      term.open(containerRef.current);
      termRef.current = term;
      fitAddonRef.current = fitAddon;
      registerTerminal(id, term);
      // Lets command handlers (split, focus-next/previous-pane) and the
      // tab-switch effect in RichTerminalPanel move REAL keyboard focus into
      // this pane's xterm instance — plain store-state updates don't do
      // that on their own, and a pane mounted in a `display:none` slot
      // can't be focused by DOM lookup alone.
      register(id, () => termRef.current?.focus());

      // Three new pane commands (mod+\, mod+shift+[, mod+shift+]) are Ctrl-
      // chords on non-mac platforms (mod=Ctrl there). xterm's default
      // keydown handling would otherwise ALSO forward them to the PTY —
      // Ctrl+\ as the literal SIGQUIT byte (0x1C), Ctrl+Shift+[ / Ctrl+
      // Shift+] as escape sequences — double-firing alongside the app-level
      // command and leaking into whatever's running in the shell (vim, a
      // REPL, etc). Returning `false` tells xterm to ignore the keystroke
      // entirely so only the document-level command handler
      // (KeyboardShortcutManager) sees it. On macOS these are Cmd-chords
      // instead (mod=Cmd there); xterm never forwards Cmd combinations to
      // the PTY to begin with, so this guard is naturally dormant there —
      // no separate mac-side handling is needed.
      if (!isMac()) {
        term.attachCustomKeyEventHandler((e) => {
          if (e.type !== 'keydown') return true;
          if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.code === 'Backslash') {
            return false;
          }
          if (
            e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey &&
            (e.code === 'BracketLeft' || e.code === 'BracketRight')
          ) {
            return false;
          }
          return true;
        });
      }

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

      requestAnimationFrame(() => {
        if (!fitAddon || !term || !containerRef.current) return;
        // Explicit width/height guard (mirrors the ResizeObserver's own
        // `width>0 && height>0` check below) instead of relying on
        // addon-fit's internal handling of a zero-size container, which is
        // inconsistent about bailing on undefined/zero dimensions. A pane
        // that mounts inside a `display:none` slot (inactive tab or split
        // group) measures 0x0 here and gets its real fit once the
        // ResizeObserver fires after the slot becomes visible. Cosmetic-only
        // consequence: xterm's default 80-col buffer prewraps any output
        // that arrives before that first real fit — accepted, since the
        // pane isn't visible yet anyway.
        const { width, height } = containerRef.current.getBoundingClientRect();
        if (width === 0 || height === 0) return;
        fitAddon.fit();
        invoke('terminal_resize', {
          id,
          rows: term.rows,
          cols: term.cols,
        }).catch(() => {});
      });

      const localTerm = term;
      dataDisposable = localTerm.onData((data) => {
        invoke('terminal_write', { id, data }).catch(() => {});
      });

      listenScoped<{ id: number; data: string }>('terminal-output', (event) => {
        if (event.payload.id === id) {
          localTerm.write(event.payload.data);
        }
      }).then((fn) => {
        if (cancelled) safeUnlisten(fn);
        else unlistenOutputFn = fn;
      });

      listenScoped<{ id: number; exit_code: number | null }>('terminal-exit', (event) => {
        if (event.payload.id === id) {
          localTerm.write('\r\n\x1b[90m[Process exited]\x1b[0m\r\n');
          useTerminalStore.getState().markExited(id);
        }
      }).then((fn) => {
        if (cancelled) safeUnlisten(fn);
        else unlistenExitFn = fn;
      });

      resizeObserver = new ResizeObserver(() => {
        if (resizeTimeout) clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
          if (fitAddonRef.current && containerRef.current) {
            const { width, height } = containerRef.current.getBoundingClientRect();
            if (width > 0 && height > 0) {
              fitAddonRef.current.fit();
              if (termRef.current) {
                invoke('terminal_resize', {
                  id,
                  rows: termRef.current.rows,
                  cols: termRef.current.cols,
                }).catch(() => {});
              }
            }
          }
        }, 50);
      });
      if (containerRef.current) resizeObserver.observe(containerRef.current);
    })();

    return () => {
      cancelled = true;
      unregisterTerminal(id);
      unregister(id);
      dataDisposable?.dispose();
      safeUnlisten(unlistenOutputFn);
      safeUnlisten(unlistenExitFn);
      resizeObserver?.disconnect();
      if (resizeTimeout) clearTimeout(resizeTimeout);
      term?.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, [id]);

  // Apply live setting changes to the existing terminal so users see updates
  // without reopening the tab. Refit after font changes so dimensions stay
  // correct.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontFamily = fontFamily as string;
    term.options.fontSize = fontSize as number;
    term.options.cursorBlink = cursorBlink as boolean;
    if (fitAddonRef.current && containerRef.current) {
      const { width, height } = containerRef.current.getBoundingClientRect();
      if (width > 0 && height > 0) {
        fitAddonRef.current.fit();
        invoke('terminal_resize', {
          id,
          rows: term.rows,
          cols: term.cols,
        }).catch(() => {});
      }
    }
  }, [id, fontFamily, fontSize, cursorBlink]);

  return (
    <div
      ref={containerRef}
      className="terminal-xterm"
      onClick={() => termRef.current?.focus()}
    />
  );
}

export default TerminalInstance;
