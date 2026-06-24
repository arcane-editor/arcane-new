/**
 * ModeSelector — pill button that shows the active mode with an icon and a
 * chevron, opening a popover menu for ASK / AGENT / PLAN. Replaces the prior
 * three-segment control to free up horizontal space in the composer toolbar
 * and to match the user's reference design.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronDown,
  Infinity as InfinityIcon,
  ListChecks,
  MessageSquare,
  Check,
} from 'lucide-react';
import { useAiStore } from '../../../stores/ai';
import type { ChatMode } from '../services/types';

interface ModeOption {
  value: ChatMode;
  label: string;
  description: string;
  Icon: typeof MessageSquare;
}

const MODES: ModeOption[] = [
  {
    value: 'ask',
    label: 'Ask',
    description: 'Read-only conversation. No file edits.',
    Icon: MessageSquare,
  },
  {
    value: 'agent',
    label: 'Agent',
    description: 'AI can edit files and run commands.',
    Icon: InfinityIcon,
  },
  {
    value: 'plan',
    label: 'Plan',
    description: 'Plan first, then execute step by step.',
    Icon: ListChecks,
  },
];

const POPOVER_WIDTH = 240;

function ModeSelector() {
  const mode = useAiStore((s) => s.mode);
  const setMode = useAiStore((s) => s.setMode);
  const isAgentRunning = useAiStore((s) => s.isAgentRunning);

  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);

  const active = MODES.find((m) => m.value === mode) ?? MODES[1];
  const ActiveIcon = active.Icon;

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    if (buttonRef.current) {
      setAnchorRect(buttonRef.current.getBoundingClientRect());
    }
    setOpen(true);
  }

  // Close on outside click / scroll / Esc
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        !buttonRef.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    function onScroll() {
      setOpen(false);
    }
    const t = setTimeout(() => window.addEventListener('mousedown', onDown), 0);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      clearTimeout(t);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  function pick(value: ChatMode) {
    setMode(value);
    setOpen(false);
  }

  // Position above the pill button (popover opens upward in the toolbar).
  const popoverStyle: React.CSSProperties | null = anchorRect
    ? {
        position: 'fixed',
        bottom: window.innerHeight - anchorRect.top + 6,
        left: Math.max(8, Math.min(window.innerWidth - POPOVER_WIDTH - 8, anchorRect.left)),
        width: POPOVER_WIDTH,
        zIndex: 1000,
      }
    : null;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`ai-panel-mode-pill ${open ? 'is-open' : ''}`}
        onClick={toggle}
        disabled={isAgentRunning}
        aria-haspopup="menu"
        aria-expanded={open}
        title={active.description}
      >
        <ActiveIcon size={12} className="ai-panel-mode-pill-icon" strokeWidth={2.25} />
        <span className="ai-panel-mode-pill-label">{active.label}</span>
        <ChevronDown size={11} className="ai-panel-mode-pill-caret" strokeWidth={2} />
      </button>

      {open &&
        popoverStyle &&
        createPortal(
          <div ref={popoverRef} className="ai-panel-mode-menu" style={popoverStyle} role="menu">
            {MODES.map((m) => {
              const Icon = m.Icon;
              const selected = mode === m.value;
              return (
                <button
                  key={m.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  className={`ai-panel-mode-menu-item ${selected ? 'is-selected' : ''}`}
                  onClick={() => pick(m.value)}
                >
                  <span className="ai-panel-mode-menu-icon">
                    <Icon size={14} strokeWidth={2} />
                  </span>
                  <span className="ai-panel-mode-menu-text">
                    <span className="ai-panel-mode-menu-label">{m.label}</span>
                    <span className="ai-panel-mode-menu-desc">{m.description}</span>
                  </span>
                  {selected && (
                    <Check size={13} className="ai-panel-mode-menu-check" strokeWidth={2.5} />
                  )}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}

export default ModeSelector;
