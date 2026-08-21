/**
 * AgentConfigBar — renders whatever settings the connected external agent
 * advertises, and nothing Arcane decided in advance.
 *
 * The previous integration shipped three hardcoded pickers (model, effort,
 * permission mode) whose values were baked into the editor. They went stale the
 * moment the agent shipped a new model or renamed a mode. ACP solves this with
 * `session/new` → `configOptions[]`: a list of typed, agent-owned settings, each
 * with its id, label, current value and allowed values. Rendering that list
 * generically means a new Claude release — or a different agent entirely —
 * needs no change here at all.
 *
 * Replaces ModeSelector + EffortSelector while an external agent is selected,
 * because those two control the Arcane loop specifically.
 *
 * The context meter sits at the end of the same row. It is not a setting, but
 * it is the other thing that changes about a live session and the one number
 * that predicts a compaction, so it belongs with them rather than somewhere
 * else on screen.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Gauge } from 'lucide-react';
import type { SessionConfigOption } from '../../acp';
import { useAiStore } from '../../../stores/ai';
import { getClaudeBackend } from '../services/claude-backend';

const POPOVER_WIDTH = 240;

function AgentConfigBar() {
  const options = useAiStore((s) => s.agentConfigOptions);
  const usage = useAiStore((s) => s.agentContextUsage);
  if (options.length === 0 && !usage) return null;

  return (
    <>
      {options.map((option) =>
        option.type === 'select' ? (
          <SelectOption key={option.id} option={option} />
        ) : (
          <BooleanOption key={option.id} option={option} />
        ),
      )}
      {usage && <ContextMeter usage={usage} />}
    </>
  );
}

/** Round to the nearest useful unit — "620k" reads faster than "619,847". */
function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/**
 * The pill IS the gauge: its own background fills left to right as the context
 * does. One device rather than a pill plus a separate bar, and it reads
 * without being read — you notice a nearly-full pill before you parse "94%".
 */
function ContextMeter({ usage }: { usage: { used: number; size: number } }) {
  const ratio = Math.min(1, Math.max(0, usage.used / usage.size));
  const percent = Math.round(ratio * 100);
  // 80% is where compaction stops being hypothetical, which is the only moment
  // this needs to compete for attention.
  const pressed = ratio >= 0.8;

  return (
    <span
      className={`ai-panel-mode-pill ai-panel-context-meter ${pressed ? 'is-tight' : ''}`}
      style={{ '--context-fill': `${percent}%` } as React.CSSProperties}
      title={`Context: ${compactTokens(usage.used)} of ${compactTokens(usage.size)} tokens used. Claude compacts the conversation as this fills.`}
    >
      <Gauge size={11} className="ai-panel-mode-pill-icon" strokeWidth={2.25} />
      <span className="ai-panel-mode-pill-label">{percent}%</span>
    </span>
  );
}

function SelectOption({ option }: { option: Extract<SessionConfigOption, { type: 'select' }> }) {
  const isAgentRunning = useAiStore((s) => s.isAgentRunning);
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useDismissOnOutside(open, setOpen, popoverRef, buttonRef);

  const active = option.options.find((o) => o.value === option.currentValue);

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    if (buttonRef.current) setAnchorRect(buttonRef.current.getBoundingClientRect());
    setOpen(true);
  }

  function choose(value: string) {
    setOpen(false);
    if (value === option.currentValue) return;
    // Fire and forget: the agent answers with the full reconciled option set,
    // which the backend writes back to the store. Optimistically updating here
    // would fight that — switching model can change which modes even exist.
    void getClaudeBackend()
      .setConfigOption(option.id, value)
      .catch((e) => useAiStore.getState().setError(String(e)));
  }

  const popoverStyle: React.CSSProperties | null = anchorRect
    ? {
        position: 'fixed',
        // Opens UPWARD: this bar lives in the composer at the bottom of the
        // panel, so a downward menu would open off-screen.
        bottom: window.innerHeight - anchorRect.top + 4,
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
        title={option.description ?? option.name}
      >
        <span className="ai-panel-mode-pill-label">{active?.name ?? option.currentValue}</span>
        <ChevronDown size={11} className="ai-panel-mode-pill-caret" strokeWidth={2} />
      </button>

      {open &&
        popoverStyle &&
        createPortal(
          <div ref={popoverRef} className="ai-panel-mode-menu" style={popoverStyle} role="menu">
            <div className="ai-panel-agent-menu-section">{option.name}</div>
            {option.options.map((choice) => {
              const selected = choice.value === option.currentValue;
              return (
                <button
                  key={choice.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  className={`ai-panel-mode-menu-item ${selected ? 'is-selected' : ''}`}
                  onClick={() => choose(choice.value)}
                >
                  <span className="ai-panel-mode-menu-text">
                    <span className="ai-panel-mode-menu-label">{choice.name}</span>
                    {choice.description && (
                      <span className="ai-panel-mode-menu-desc">{choice.description}</span>
                    )}
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

function BooleanOption({ option }: { option: Extract<SessionConfigOption, { type: 'boolean' }> }) {
  const isAgentRunning = useAiStore((s) => s.isAgentRunning);

  return (
    <button
      type="button"
      role="switch"
      aria-checked={option.currentValue}
      className={`ai-panel-mode-pill ${option.currentValue ? 'is-open' : ''}`}
      disabled={isAgentRunning}
      title={option.description ?? option.name}
      onClick={() =>
        void getClaudeBackend()
          .setConfigOption(option.id, !option.currentValue)
          .catch((e) => useAiStore.getState().setError(String(e)))
      }
    >
      <span className="ai-panel-mode-pill-label">{option.name}</span>
    </button>
  );
}

/** Shared dismiss behaviour — click outside, Escape, or scroll closes the menu. */
function useDismissOnOutside(
  open: boolean,
  setOpen: (open: boolean) => void,
  popoverRef: React.RefObject<HTMLDivElement | null>,
  buttonRef: React.RefObject<HTMLButtonElement | null>,
) {
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
    // Deferred by a tick so the click that opened the menu does not immediately
    // close it again.
    const t = setTimeout(() => window.addEventListener('mousedown', onDown), 0);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      clearTimeout(t);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, setOpen, popoverRef, buttonRef]);
}

export default AgentConfigBar;
