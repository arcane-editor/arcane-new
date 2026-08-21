/**
 * The card shown when Claude Code is selected but cannot run yet.
 *
 * There are five distinct reasons, and they need five distinct answers — a
 * single "Claude isn't available" message would leave the user guessing which
 * of Node, npm, the adapter, or their Claude account is the problem. Each state
 * therefore names what is missing and offers the one action that fixes it.
 *
 * Renders `null` once everything is ready, so `AiChatPanel` can mount it
 * unconditionally. That matters: `AiChatPanel`'s hooks must not sit behind a
 * new conditional return (see its `HOOKS END HERE` note), and a self-clearing
 * child avoids adding one.
 */

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Download, LogIn, RefreshCw, Terminal } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  installClaudeAgent,
  probeClaudeAgent,
  resolveSetupState,
  toMessage,
  REQUIRED_NODE_MAJOR,
  type AcpProbe,
  type AcpSetupState,
  type AuthMethod,
} from '../../acp';
import { useAiStore } from '../../../stores/ai';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useTerminalStore } from '../../../stores/terminal';
import { useUiStore } from '../../../stores/ui';
import { getClaudeBackend } from '../services/claude-backend';

const NODE_DOWNLOAD_URL = 'https://nodejs.org/en/download';

function ClaudeSetupGate() {
  const selectedAgent = useAiStore((s) => s.selectedAgent);
  const needsAuth = useAiStore((s) => s.agentNeedsAuth);
  const authMethods = useAiStore((s) => s.agentAuthMethods);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);

  const [probe, setProbe] = useState<AcpProbe | null>(null);
  const [setup, setSetup] = useState<AcpSetupState | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await probeClaudeAgent();
      setProbe(next);
      setSetup(resolveSetupState(next));
      setError(null);
    } catch (e) {
      setError(toMessage(e));
    }
  }, []);

  useEffect(() => {
    if (selectedAgent !== 'claude') return;
    void refresh();
  }, [selectedAgent, refresh]);

  // Live npm output while installing. Subscribed only during an install so the
  // panel isn't listening to a Tauri event for the whole session.
  useEffect(() => {
    if (!busy) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    void import('../../../utils/tauri-listener').then(({ listenScoped }) =>
      listenScoped<{ agentId: string; line: string }>('acp-install-progress', (event) => {
        if (!active || event.payload.agentId !== 'claude') return;
        setProgress(event.payload.line);
      }).then((fn) => {
        if (active) unlisten = fn;
        else fn();
      }),
    );
    return () => {
      active = false;
      unlisten?.();
    };
  }, [busy]);

  async function install() {
    setBusy(true);
    setError(null);
    setProgress('Starting…');
    try {
      // Reuse the user's own Claude CLI when they have one: it skips a ~321 MB
      // native download, and it is the binary their existing login belongs to.
      const next = await installClaudeAgent(!!probe?.claudePath);
      setProbe(next);
      setSetup(resolveSetupState(next));
    } catch (e) {
      setError(toMessage(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  /**
   * Run the agent's own sign-in as a real terminal tab.
   *
   * ACP's terminal auth method is defined exactly this way: the client re-runs
   * the agent program with extra arguments on a TTY, and a zero exit means the
   * user is signed in. It cannot be done in-protocol — the login is a TUI with
   * a browser handoff — and the spec explicitly forbids passing a terminal
   * method to `authenticate`.
   */
  async function signIn(method: AuthMethod) {
    if (!probe?.nodePath || !probe.adapterEntry) return;

    const meta = method._meta?.['terminal-auth'];
    const command = meta?.command ?? probe.nodePath;
    const args = meta?.args ?? [probe.adapterEntry, ...(method.args ?? [])];

    setError(null);
    const id = await useTerminalStore
      .getState()
      .createTerminal(workspacePath ?? '.', command, { args, name: meta?.label ?? 'Claude Login' });
    if (id === null) {
      setError('Could not open a terminal for sign-in.');
      return;
    }

    // Reveal the terminal AND select its tab — the login prompts for input, so
    // a tab the user cannot see is indistinguishable from a hang.
    const ui = useUiStore.getState();
    ui.setActiveBottomTab('terminal');
    ui.setBottomPanelVisible(true);
  }

  async function retryAfterSignIn() {
    setBusy(true);
    setError(null);
    try {
      await getClaudeBackend().retryAfterAuth();
    } catch (e) {
      setError(toMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (selectedAgent !== 'claude') return null;

  // Auth outranks setup: the agent only reports `auth_required` once it is
  // installed and running, so there is nothing left to install at this point.
  if (needsAuth) {
    return (
      <Card
        icon={<LogIn size={16} />}
        title="Sign in to Claude"
        body="Claude Code uses your own Anthropic account. Arcane never sees those credentials."
        error={error}
      >
        {authMethods.length === 0 ? (
          <Note>
            This agent needs authentication but offered no sign-in method Arcane can
            run. Sign in with the <code>claude</code> CLI in a terminal, then retry.
          </Note>
        ) : (
          authMethods.map((method) => (
            <button
              key={method.id}
              type="button"
              style={primaryBtnStyle}
              onClick={() => void signIn(method)}
            >
              <Terminal size={14} />
              {method.name}
            </button>
          ))
        )}
        <button type="button" style={secondaryBtnStyle} disabled={busy} onClick={() => void retryAfterSignIn()}>
          {busy ? 'Connecting…' : "I've signed in — continue"}
        </button>
      </Card>
    );
  }

  if (!setup || setup.kind === 'ready' || setup.kind === 'outdated') {
    // `outdated` still runs. Nagging someone mid-task about a version bump they
    // may not be able to download right now would be worse than the drift.
    return null;
  }

  switch (setup.kind) {
    case 'node-missing':
    case 'node-too-old':
      return (
        <Card
          icon={<AlertTriangle size={16} />}
          title={setup.kind === 'node-missing' ? 'Node.js is required' : 'Node.js is too old'}
          body={
            setup.kind === 'node-missing'
              ? `Claude Code runs as a local Node program. Install Node.js ${REQUIRED_NODE_MAJOR} or newer, then reload.`
              : `Found ${setup.found}; Claude Code needs Node.js ${setup.required} or newer.`
          }
          error={error}
        >
          <button type="button" style={primaryBtnStyle} onClick={() => void openUrl(NODE_DOWNLOAD_URL)}>
            <Download size={14} />
            Download Node.js
          </button>
          <RetryButton onClick={() => void refresh()} label="Check again" />
        </Card>
      );

    case 'npm-missing':
      return (
        <Card
          icon={<AlertTriangle size={16} />}
          title="npm is required"
          body="Node.js is installed but npm is not on your PATH, so Arcane cannot install the Claude agent."
          error={error}
        >
          <RetryButton onClick={() => void refresh()} label="Check again" />
        </Card>
      );

    case 'cli-missing':
      return (
        <Card
          icon={<AlertTriangle size={16} />}
          title="Claude CLI is missing"
          body="The agent was installed against your Claude CLI, which is no longer there. Reinstalling adds a self-contained copy."
          error={error}
        >
          <InstallButton busy={busy} progress={progress} onClick={() => void install()} label="Reinstall agent" />
        </Card>
      );

    case 'not-installed':
      return (
        <Card
          icon={<Terminal size={16} />}
          title="Set up Claude Code"
          body={
            probe?.claudePath
              ? 'Arcane will install the Claude agent adapter and connect it to the Claude CLI you already have.'
              : 'Arcane will install the Claude agent locally. This downloads a few hundred megabytes the first time.'
          }
          error={error}
        >
          <InstallButton busy={busy} progress={progress} onClick={() => void install()} label="Install Claude agent" />
        </Card>
      );

    default:
      return null;
  }
}

// ── Presentation ────────────────────────────────────────────────

function Card(props: {
  icon: React.ReactNode;
  title: string;
  body: string;
  error: string | null;
  children: React.ReactNode;
}) {
  return (
    <div style={containerStyle}>
      <div style={cardStyle}>
        <div style={iconRowStyle}>{props.icon}</div>
        <div style={titleStyle}>{props.title}</div>
        <div style={subtitleStyle}>{props.body}</div>
        {props.children}
        {props.error && <div style={errorStyle}>{props.error}</div>}
      </div>
    </div>
  );
}

function Note(props: { children: React.ReactNode }) {
  return <div style={subtitleStyle}>{props.children}</div>;
}

function InstallButton(props: {
  busy: boolean;
  progress: string | null;
  label: string;
  onClick: () => void;
}) {
  return (
    <>
      <button type="button" style={primaryBtnStyle} disabled={props.busy} onClick={props.onClick}>
        <Download size={14} />
        {props.busy ? 'Installing…' : props.label}
      </button>
      {props.busy && props.progress && (
        // One line, not a scrollback: npm is verbose and the useful signal is
        // simply that it is still moving.
        <div style={progressStyle}>{props.progress}</div>
      )}
    </>
  );
}

function RetryButton(props: { onClick: () => void; label: string }) {
  return (
    <button type="button" style={secondaryBtnStyle} onClick={props.onClick}>
      <RefreshCw size={13} />
      {props.label}
    </button>
  );
}

const containerStyle: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '24px',
  overflow: 'auto',
};

const cardStyle: React.CSSProperties = {
  width: '100%',
  maxWidth: 300,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'stretch',
  gap: 10,
  textAlign: 'center',
};

const iconRowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'center',
  color: 'var(--text-secondary)',
};

const titleStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  color: 'var(--text-primary)',
};

const subtitleStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--text-secondary)',
  lineHeight: 1.5,
  marginBottom: 4,
};

const primaryBtnStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  padding: '8px 14px',
  background: 'var(--button-primary-bg)',
  border: 'none',
  borderRadius: 6,
  color: 'var(--button-primary-text)',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
};

const secondaryBtnStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  padding: '6px 14px',
  background: 'transparent',
  border: '1px solid var(--border)',
  borderRadius: 6,
  color: 'var(--text-primary)',
  fontSize: 12,
  fontWeight: 500,
  cursor: 'pointer',
};

const progressStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10.5,
  color: 'var(--text-secondary)',
  textAlign: 'left',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const errorStyle: React.CSSProperties = {
  fontSize: 11.5,
  color: 'var(--error, #f87171)',
  textAlign: 'left',
  lineHeight: 1.45,
  whiteSpace: 'pre-wrap',
};

export default ClaudeSetupGate;
