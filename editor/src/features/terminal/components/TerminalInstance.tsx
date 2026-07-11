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
        if (!fitAddon || !term) return;
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
