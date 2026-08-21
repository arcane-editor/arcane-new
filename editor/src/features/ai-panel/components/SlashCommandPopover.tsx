/**
 * SlashCommandPopover — lists the slash commands the connected external agent
 * advertises (ACP `available_commands_update`) when the user types `/` at the
 * start of the composer. Reuses the mention-popover styles. Picking inserts
 * `/<name> `.
 *
 * The list is entirely agent-supplied: an agent's commands are its own, they
 * change with its configuration (project-local commands, plugins), and Arcane
 * neither interprets nor validates them — the text is sent as an ordinary
 * prompt and the agent does the rest.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SlashSquare } from 'lucide-react';
import type { AvailableCommand } from '../../acp';

const POPOVER_WIDTH = 300;
const MAX_ITEMS = 8;
const SPACE_BELOW_THRESHOLD = 240;

interface Props {
  open: boolean;
  query: string;
  anchorRect: DOMRect | null;
  commands: AvailableCommand[];
  onPick: (name: string) => void;
  onClose: () => void;
}

function SlashCommandPopover({ open, query, anchorRect, commands, onPick, onClose }: Props) {
  const items = useMemo(() => {
    const q = query.toLowerCase();
    return commands
      .filter((c) => c.name && (!q || c.name.toLowerCase().includes(q)))
      .slice(0, MAX_ITEMS);
  }, [commands, query]);

  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [query, open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((i) => (items.length ? (i + 1) % items.length : 0));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => (items.length ? (i - 1 + items.length) % items.length : 0));
      } else if (e.key === 'Enter') {
        if (!items.length) return;
        e.preventDefault();
        e.stopPropagation();
        onPick(items[active].name);
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, items, active, onPick]);

  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    const t = setTimeout(() => window.addEventListener('mousedown', onClick), 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener('mousedown', onClick);
    };
  }, [open, onClose]);

  const style = useMemo<React.CSSProperties | null>(() => {
    if (!anchorRect) return null;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = anchorRect.left;
    if (left + POPOVER_WIDTH > vw - 8) left = Math.max(8, vw - POPOVER_WIDTH - 8);
    const base: React.CSSProperties = {
      position: 'fixed',
      left,
      width: POPOVER_WIDTH,
      maxHeight: 320,
      zIndex: 1000,
    };
    const spaceBelow = vh - anchorRect.bottom;
    return spaceBelow < SPACE_BELOW_THRESHOLD
      ? { ...base, bottom: vh - anchorRect.top + 6 }
      : { ...base, top: anchorRect.bottom + 6 };
  }, [anchorRect]);

  if (!open || !style || items.length === 0) return null;

  return createPortal(
    <div ref={ref} className="ai-panel-mention-popover" style={style}>
      <div className="ai-panel-mention-section">
        <div className="ai-panel-mention-section-header">COMMANDS</div>
        {items.map((c, i) => (
          <button
            key={c.name}
            type="button"
            className={`ai-panel-mention-item ${i === active ? 'is-active' : ''}`}
            onMouseEnter={() => setActive(i)}
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(c.name);
            }}
          >
            <SlashSquare size={14} className="ai-panel-mention-icon" />
            <span className="ai-panel-mention-label">/{c.name}</span>
            {c.description && <span className="ai-panel-mention-path">{c.description}</span>}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}

export default SlashCommandPopover;
