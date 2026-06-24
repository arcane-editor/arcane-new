/**
 * ClaudeModelPicker — pill button in the chat composer toolbar for selecting
 * which Claude family to route through. Matches Zed's "Auto / Sonnet / Opus /
 * Haiku" dropdown.
 *
 * 'auto' lets Claude Code's own router pick. The family aliases match the
 * `--model` flag on the `claude` CLI and resolve to the latest in-family
 * model server-side.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Cpu, Check } from 'lucide-react';
import { useAiStore } from '../../../stores/ai';
import { getClaudeAgentService } from '../services/claude-agent-service';
import type { ClaudeModel } from '../services/types';

const MODELS: Array<{
  value: ClaudeModel;
  label: string;
  description: string;
}> = [
  { value: 'auto', label: 'Auto', description: 'Let Claude Code pick the best model.' },
  { value: 'opus', label: 'Opus', description: 'Most capable. Highest cost.' },
  { value: 'sonnet', label: 'Sonnet', description: 'Balanced quality and speed.' },
  { value: 'haiku', label: 'Haiku', description: 'Fastest. Lowest cost.' },
];

const POPOVER_WIDTH = 220;

function ClaudeModelPicker() {
  const model = useAiStore((s) => s.claudeModel);
  const setModel = useAiStore((s) => s.setClaudeModel);
  const isAgentRunning = useAiStore((s) => s.isAgentRunning);

  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);

  const active = MODELS.find((m) => m.value === model) ?? MODELS[0];

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

  function pick(value: ClaudeModel) {
    setModel(value);
    getClaudeAgentService().setModel(value);
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
        <Cpu size={12} className="ai-panel-mode-pill-icon" strokeWidth={2.25} />
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
            {MODELS.map((m) => {
              const selected = model === m.value;
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
                    <Cpu size={14} strokeWidth={2} />
                  </span>
                  <span className="ai-panel-mode-menu-text">
                    <span className="ai-panel-mode-menu-label">{m.label}</span>
                    <span className="ai-panel-mode-menu-desc">{m.description}</span>
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

export default ClaudeModelPicker;
