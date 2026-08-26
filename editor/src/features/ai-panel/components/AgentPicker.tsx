/**
 * AgentPicker — header dropdown for the chat agent: the hosted UnityIDE agent, or
 * an external one connected over ACP.
 *
 * External agents are a paid-plan feature, and the row for one is always
 * RENDERED — never hidden — with the single reason it is unavailable shown in
 * place of its description. Hiding it would leave a paid feature undiscoverable;
 * showing "Upgrade" to someone who is merely offline would be worse, which is
 * why the reason comes from `externalAgentStatus` rather than a plan check.
 *
 * Matches the Zed pattern: clickable label with a chevron in the panel header.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Sparkles, Check, Lock, Terminal, RefreshCw } from 'lucide-react';
import { useAiStore } from '../../../stores/ai';
import { useAuthStore } from '../../../stores/auth';
import { useConnectivityStore } from '../../../stores/connectivity';
import { useServerConfigStore, acpAllowed } from '../../../stores/server-config';
import {
  externalAgentStatus,
  showsUpgradeCta,
  showsRetryCta,
  EXTERNAL_AGENT_STATUS_LABEL,
  EXTERNAL_AGENT_STATUS_TITLE,
} from '../services/external-agent-gate';
import { disposeExternalBackends } from '../services/chat-backend';
import type { AgentKind } from '../services/types';

interface AgentOption {
  value: AgentKind;
  label: string;
  description: string;
  icon: typeof Sparkles;
  /** External agents run locally, are plan-gated, and bill through their own provider. */
  external: boolean;
}

const AGENTS: AgentOption[] = [
  {
    value: 'hosted',
    label: 'UnityIDE Agent',
    description: 'Hosted agent using your UnityIDE account.',
    icon: Sparkles,
    external: false,
  },
  {
    value: 'claude',
    label: 'Claude Code',
    description: 'Runs locally with your own Claude account.',
    icon: Terminal,
    external: true,
  },
];

const POPOVER_WIDTH = 240;

function AgentPicker() {
  const selectedAgent = useAiStore((s) => s.selectedAgent);
  const setSelectedAgent = useAiStore((s) => s.setSelectedAgent);
  const isAgentRunning = useAiStore((s) => s.isAgentRunning);

  // Subscribed per field so the row's locked state follows a plan refresh or a
  // connectivity flip without the panel re-rendering for unrelated changes.
  // `acpEnabled` subscribes to the DERIVED flag (not the whole config object)
  // so a config change that doesn't affect this account's acp feature (or a
  // stale config a plan mismatch invalidates — see `acpAllowed`'s guard)
  // doesn't cause an extra re-render either.
  const loggedIn = useAuthStore((s) => s.loggedIn);
  const plan = useAuthStore((s) => s.plan);
  const online = useConnectivityStore((s) => s.online);
  const acpEnabled = useServerConfigStore((s) => acpAllowed(s.config, plan));
  const externalStatus = externalAgentStatus({ loggedIn, online, plan, acpEnabled });
  const externalAvailable = externalStatus === 'available';

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
    const option = AGENTS.find((a) => a.value === value);
    if (option?.external && !externalAvailable) return;

    if (value !== selectedAgent) {
      // Switching away from an external agent kills its subprocess. Leaving it
      // running would hold a workspace lock and an idle model session for a
      // conversation the user has moved on from.
      if (selectedAgent !== 'hosted') void disposeExternalBackends();
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
            {AGENTS.map((a) => {
              const selected = selectedAgent === a.value;
              const locked = a.external && !externalAvailable;
              const Icon = a.icon;
              return (
                <button
                  key={a.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  aria-disabled={locked}
                  className={`ai-panel-mode-menu-item ${selected ? 'is-selected' : ''} ${
                    locked ? 'is-disabled' : ''
                  }`}
                  disabled={locked}
                  title={locked ? EXTERNAL_AGENT_STATUS_TITLE[externalStatus] : a.description}
                  onClick={() => pick(a.value)}
                >
                  <span className="ai-panel-mode-menu-icon">
                    {locked ? (
                      <Lock size={14} strokeWidth={2} />
                    ) : (
                      <Icon size={14} strokeWidth={2} />
                    )}
                  </span>
                  <span className="ai-panel-mode-menu-text">
                    <span className="ai-panel-mode-menu-label">
                      {a.label}
                      {locked && (
                        <span className="ai-panel-agent-menu-badge">
                          {EXTERNAL_AGENT_STATUS_LABEL[externalStatus]}
                        </span>
                      )}
                    </span>
                    <span className="ai-panel-mode-menu-desc">
                      {locked ? EXTERNAL_AGENT_STATUS_TITLE[externalStatus] : a.description}
                    </span>
                  </span>
                  {selected && !locked && (
                    <Check
                      size={13}
                      className="ai-panel-mode-menu-check"
                      strokeWidth={2.5}
                    />
                  )}
                </button>
              );
            })}

            {showsRetryCta(externalStatus) && (
              <>
                <div className="ai-panel-agent-menu-section">More</div>
                <button
                  type="button"
                  className="ai-panel-mode-menu-item"
                  onClick={() => {
                    setOpen(false);
                    // `plan` is only ever in memory, so the fix for both of
                    // these states is one successful /v1/usage.
                    void useAuthStore.getState().refreshUsage();
                  }}
                >
                  <span className="ai-panel-mode-menu-icon">
                    <RefreshCw size={14} strokeWidth={2} />
                  </span>
                  <span className="ai-panel-mode-menu-text">
                    <span className="ai-panel-mode-menu-label">Check again</span>
                    <span className="ai-panel-mode-menu-desc">
                      Re-check your plan with the UnityIDE server.
                    </span>
                  </span>
                </button>
              </>
            )}

            {showsUpgradeCta(externalStatus) && (
              <>
                <div className="ai-panel-agent-menu-section">More</div>
                <button
                  type="button"
                  className="ai-panel-mode-menu-item"
                  onClick={() => {
                    setOpen(false);
                    // Purchases happen on the website, never in the app —
                    // matching every other upgrade path in the editor.
                    void useAuthStore.getState().openBilling();
                  }}
                >
                  <span className="ai-panel-mode-menu-icon">
                    <Sparkles size={14} strokeWidth={2} />
                  </span>
                  <span className="ai-panel-mode-menu-text">
                    <span className="ai-panel-mode-menu-label">Upgrade plan</span>
                    <span className="ai-panel-mode-menu-desc">
                      Unlock Claude Code and more
                    </span>
                  </span>
                </button>
              </>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

export default AgentPicker;
