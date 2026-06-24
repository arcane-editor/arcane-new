/**
 * AgentPicker — header dropdown that switches between the Arcane Agent
 * (cloud) and Claude Agent (local `claude` CLI via ACP bridge).
 *
 * Matches the Zed pattern: clickable label with a chevron in the panel header.
 * Opens a popover with: Arcane Agent / External Agents / Claude Agent.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Sparkles, Check, Plus } from 'lucide-react';
import { useAiStore } from '../../../stores/ai';
import type { AgentKind } from '../services/types';

interface AgentOption {
  value: AgentKind;
  label: string;
  description: string;
  group: 'arcane' | 'external';
}

const AGENTS: AgentOption[] = [
  {
    value: 'arcane',
    label: 'Arcane Agent',
    description: 'Hosted agent using your Arcane account.',
    group: 'arcane',
  },
  {
    value: 'claude',
    label: 'Claude Agent',
    description: 'Your local Claude Code, via Agent Client Protocol.',
    group: 'external',
  },
];

const POPOVER_WIDTH = 240;

function AgentPicker() {
  const selectedAgent = useAiStore((s) => s.selectedAgent);
  const setSelectedAgent = useAiStore((s) => s.setSelectedAgent);
  const isAgentRunning = useAiStore((s) => s.isAgentRunning);

  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);

  const active = AGENTS.find((a) => a.value === selectedAgent) ?? AGENTS[0];

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

  function pick(value: AgentKind) {
    if (value !== selectedAgent) {
      setSelectedAgent(value);
    }
    setOpen(false);
  }

  // Popover opens downward from the panel header.
  const popoverStyle: React.CSSProperties | null = anchorRect
    ? {
        position: 'fixed',
        top: anchorRect.bottom + 4,
        left: Math.max(
          8,
          Math.min(window.innerWidth - POPOVER_WIDTH - 8, anchorRect.left),
        ),
        width: POPOVER_WIDTH,
        zIndex: 1000,
      }
    : null;

  const arcaneOpts = AGENTS.filter((a) => a.group === 'arcane');
  const externalOpts = AGENTS.filter((a) => a.group === 'external');

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`ai-panel-agent-pill ${open ? 'is-open' : ''}`}
        onClick={toggle}
        disabled={isAgentRunning}
        aria-haspopup="menu"
        aria-expanded={open}
        title={active.description}
      >
        <Sparkles size={12} className="ai-panel-agent-pill-icon" strokeWidth={2.25} />
        <span className="ai-panel-agent-pill-label">{active.label}</span>
        <ChevronDown size={11} className="ai-panel-agent-pill-caret" strokeWidth={2} />
      </button>

      {open &&
        popoverStyle &&
        createPortal(
          <div
            ref={popoverRef}
            className="ai-panel-mode-menu ai-panel-agent-menu"
            style={popoverStyle}
            role="menu"
          >
            {arcaneOpts.map((a) => {
              const selected = selectedAgent === a.value;
              return (
                <button
                  key={a.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  className={`ai-panel-mode-menu-item ${selected ? 'is-selected' : ''}`}
                  onClick={() => pick(a.value)}
                >
                  <span className="ai-panel-mode-menu-icon">
                    <Sparkles size={14} strokeWidth={2} />
                  </span>
                  <span className="ai-panel-mode-menu-text">
                    <span className="ai-panel-mode-menu-label">{a.label}</span>
                    <span className="ai-panel-mode-menu-desc">{a.description}</span>
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

            {externalOpts.length > 0 && (
              <div className="ai-panel-agent-menu-section">External Agents</div>
            )}
            {externalOpts.map((a) => {
              const selected = selectedAgent === a.value;
              return (
                <button
                  key={a.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  className={`ai-panel-mode-menu-item ${selected ? 'is-selected' : ''}`}
                  onClick={() => pick(a.value)}
                >
                  <span className="ai-panel-mode-menu-icon">
                    <Sparkles size={14} strokeWidth={2} />
                  </span>
                  <span className="ai-panel-mode-menu-text">
                    <span className="ai-panel-mode-menu-label">{a.label}</span>
                    <span className="ai-panel-mode-menu-desc">{a.description}</span>
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

            <div className="ai-panel-agent-menu-section">More</div>
            <button
              type="button"
              className="ai-panel-mode-menu-item is-disabled"
              disabled
              title="Additional agents (Gemini, Codex…) coming soon"
            >
              <span className="ai-panel-mode-menu-icon">
                <Plus size={14} strokeWidth={2} />
              </span>
              <span className="ai-panel-mode-menu-text">
                <span className="ai-panel-mode-menu-label">Add More Agents</span>
                <span className="ai-panel-mode-menu-desc">Coming soon</span>
              </span>
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}

export default AgentPicker;
