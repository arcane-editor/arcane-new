/**
 * ClaudeEffortPicker — Claude Code's `--effort` flag. Maps to extended-thinking
 * budget. Levels match the CLI exactly: low, medium, high, xhigh, max.
 *
 * 'xhigh' is the value Zed surfaces in the screenshot — displayed as "Xhigh".
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Zap, Check } from 'lucide-react';
import { useAiStore } from '../../../stores/ai';
import { getClaudeAgentService } from '../services/claude-agent-service';
import type { ClaudeEffort } from '../services/types';

const LEVELS: Array<{ value: ClaudeEffort; label: string; description: string }> = [
  { value: 'low', label: 'Low', description: 'Minimal reasoning. Fastest.' },
  { value: 'medium', label: 'Medium', description: 'Default reasoning budget.' },
  { value: 'high', label: 'High', description: 'Extra thinking for harder tasks.' },
  { value: 'xhigh', label: 'Xhigh', description: 'Deep reasoning. Slower.' },
  { value: 'max', label: 'Max', description: 'Maximum thinking budget.' },
];

const POPOVER_WIDTH = 220;

function ClaudeEffortPicker() {
  const effort = useAiStore((s) => s.claudeEffort);
  const setEffort = useAiStore((s) => s.setClaudeEffort);
  const isAgentRunning = useAiStore((s) => s.isAgentRunning);

  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);

  const active = LEVELS.find((l) => l.value === effort) ?? LEVELS[2];

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

  function pick(value: ClaudeEffort) {
    setEffort(value);
    getClaudeAgentService().setEffort(value);
    setOpen(false);
  }

  const popoverStyle: React.CSSProperties | null = anchorRect
    ? {
        position: 'fixed',
        bottom: window.innerHeight - anchorRect.top + 6,
        left: Math.max(
          8,
          Math.min(window.innerWidth - POPOVER_WIDTH - 8, anchorRect.left),
        ),
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
        <Zap size={12} className="ai-panel-mode-pill-icon" strokeWidth={2.25} />
        <span className="ai-panel-mode-pill-label">{active.label}</span>
        <ChevronDown size={11} className="ai-panel-mode-pill-caret" strokeWidth={2} />
      </button>

      {open &&
        popoverStyle &&
        createPortal(
          <div
            ref={popoverRef}
            className="ai-panel-mode-menu"
            style={popoverStyle}
            role="menu"
          >
            {LEVELS.map((l) => {
              const selected = effort === l.value;
              return (
                <button
                  key={l.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  className={`ai-panel-mode-menu-item ${selected ? 'is-selected' : ''}`}
                  onClick={() => pick(l.value)}
                >
                  <span className="ai-panel-mode-menu-icon">
                    <Zap size={14} strokeWidth={2} />
                  </span>
                  <span className="ai-panel-mode-menu-text">
                    <span className="ai-panel-mode-menu-label">{l.label}</span>
                    <span className="ai-panel-mode-menu-desc">{l.description}</span>
                  </span>
                  {selected && (
                    <Check
                      size={13}
                      className="ai-panel-mode-menu-check"
                      strokeWidth={2.5}
                    />
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

export default ClaudeEffortPicker;
