import { useEffect, useMemo, useRef, useState } from 'react';
import { useCommandsStore } from '../../../stores/commands';
import { formatKeybinding } from '../../../utils/format-keybinding';
import type { Command } from '../../../types';

interface ShortcutsHelpModalProps {
  onClose: () => void;
}

/** A command and every chord that runs it, already rendered for this platform. */
interface Row {
  id: string;
  label: string;
  chords: string[];
}

function rowsFor(commands: Command[]): Map<string, Row[]> {
  const byCategory = new Map<string, Row[]>();
  for (const cmd of commands) {
    if (!cmd.keybinding) continue;
    // `extraKeybindings` are shown here and nowhere else. The palette
    // deliberately advertises one chord per command so there is a single
    // answer to "what runs this"; a reference sheet has the opposite job.
    const chords = [cmd.keybinding, ...(cmd.extraKeybindings ?? [])].map((c) =>
      formatKeybinding(c)
    );
    const list = byCategory.get(cmd.category) ?? [];
    list.push({ id: cmd.id, label: cmd.label, chords });
    byCategory.set(cmd.category, list);
  }
  for (const list of byCategory.values()) {
    list.sort((a, b) => a.label.localeCompare(b.label));
  }
  return byCategory;
}

function ShortcutsHelpModal({ onClose }: ShortcutsHelpModalProps) {
  // The Map itself, so the sheet re-renders if commands are ever registered
  // after mount.
  const commands = useCommandsStore((s) => s.commands);
  const [filter, setFilter] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // No stopPropagation: React's listeners sit on #root, below the document
      // listener react-hotkeys-hook uses, so stopping here would kill every app
      // hotkey for as long as this modal is open.
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const categories = useMemo(() => {
    // Unfiltered on purpose — see getAllCommands. A sheet that hid every Unity
    // chord unless a Unity project happened to be open would be worse than
    // useless: it would look complete while omitting a third of the keymap.
    const all = Array.from(commands.values());
    const q = filter.trim().toLowerCase();
    const matching = !q
      ? all
      : all.filter((cmd) => {
          const chords = [cmd.keybinding, ...(cmd.extraKeybindings ?? [])]
            .filter((c): c is string => !!c)
            .map((c) => formatKeybinding(c).toLowerCase())
            .join(' ');
          return (
            cmd.label.toLowerCase().includes(q) ||
            cmd.category.toLowerCase().includes(q) ||
            chords.includes(q)
          );
        });
    return [...rowsFor(matching).entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [commands, filter]);

  const total = useMemo(
    () => categories.reduce((n, [, rows]) => n + rows.length, 0),
    [categories]
  );

  return (
    <>
      <div className="palette-overlay" onClick={onClose} />
      <div
        className="shortcuts-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard Shortcuts"
      >
        <div className="palette-input-wrapper">
          <input
            ref={inputRef}
            className="palette-input"
            placeholder="Search shortcuts…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Filter shortcuts"
          />
          <span className="shortcuts-sheet-count">{total}</span>
        </div>
        <div className="shortcuts-sheet-body">
          {total === 0 && <div className="palette-empty">No matching shortcuts</div>}
          {categories.map(([category, rows]) => (
            <section key={category} className="shortcuts-sheet-group">
              <h2 className="palette-section-header">{category}</h2>
              {rows.map((row) => (
                <div key={row.id} className="shortcuts-sheet-row">
                  <span className="shortcuts-sheet-label">{row.label}</span>
                  <span className="shortcuts-sheet-chords">
                    {row.chords.map((chord) => (
                      <kbd key={chord} className="palette-keybinding">
                        {chord}
                      </kbd>
                    ))}
                  </span>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </>
  );
}

export default ShortcutsHelpModal;
