/**
 * The card shown when Claude Code is selected but cannot run yet — and the one
 * place that brings it up.
 *
 * There are several distinct reasons it cannot run, and they need distinct
 * answers: a single "Claude isn't available" message would leave the user
 * guessing which of Node, npm, the adapter, or their Claude account is the
 * problem. Each state names what is missing and offers the one action that
 * fixes it.
 *
 * **This component connects.** Selecting Claude Code used to do nothing at all
 * until the first message was sent, which is what made the panel look broken:
 * sign-in methods arrive from `initialize` and the agent's own modes and models
 * arrive from `session/new`, so with no subprocess running there was no login
 * button to offer, no model picker to draw, and no way to tell a signed-out
 * user from a ready one. Mounting is the right trigger — this component only
 * exists while the AI panel is on screen with Claude selected, which is exactly
 * when the user is waiting to see one of those two things.
 *
 * Renders `null` once everything is ready, so `AiChatPanel` can mount it
 * unconditionally. That matters: `AiChatPanel`'s hooks must not sit behind a
 * new conditional return (see its `HOOKS END HERE` note), and a self-clearing
 * child avoids adding one.
 */

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Download, LoaderCircle, LogIn, Plug, RefreshCw, Terminal } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  installClaudeAgent,
  isLaunchable,
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
  const connect = useAiStore((s) => s.agentConnect);
  const authMethods = useAiStore((s) => s.agentAuthMethods);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);

  const [probe, setProbe] = useState<AcpProbe | null>(null);
  const [setup, setSetup] = useState<AcpSetupState | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Re-read the machine, and connect if it is now able to run the agent. */
  const refresh = useCallback(async (): Promise<AcpSetupState | null> => {
    try {
      const next = await probeClaudeAgent();
      setProbe(next);
      const state = resolveSetupState(next);
      setSetup(state);
      setError(null);
      return state;
    } catch (e) {
      setError(toMessage(e));
      return null;
    }
  }, []);

  // Probe, then start the agent. Both halves are needed and neither implies
  // the other: the probe answers "could it run?" (a local filesystem check),
  // and only a running agent answers "will it, for this user?" — which is
  // where sign-in and the agent's own settings come from.
  useEffect(() => {
    if (selectedAgent !== 'claude' || !workspacePath) return;
    // `idle` is the ONLY state that wants a connection attempt, and keying the
    // effect on it is what makes this self-healing rather than once-per-mount:
    // New Chat, an agent switch and a workspace change all end at `idle`
    // (`externalAgentReset`, `resetClaudeBackend`), so each one reconnects
    // here instead of leaving a panel that looks connected and is not. Every
    // other state is terminal until the user acts — `failed` and
    // `auth-required` have their own buttons, and retrying them on a timer
    // would spawn a subprocess per render.
    if (connect.kind !== 'idle') return;
    let cancelled = false;
    void (async () => {
      const state = await refresh();
      // A setup problem has its own card and its own button; launching into a
      // missing Node just to produce a spawn error would replace an actionable
      // message with a worse one.
      if (cancelled || !state || !isLaunchable(state)) return;
      await getClaudeBackend().connect();
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedAgent, workspacePath, connect.kind, refresh]);

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
      const state = resolveSetupState(next);
      setSetup(state);
      // Straight into the connection rather than leaving the user on a card
      // that has nothing left to say — a fresh install still has to sign in.
      if (isLaunchable(state)) await getClaudeBackend().connect();
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

  /** Re-probe and re-launch after a failed start. */
  async function reconnect() {
    setBusy(true);
    setError(null);
    try {
      const state = await refresh();
      if (state && isLaunchable(state)) await getClaudeBackend().connect();
    } finally {
      setBusy(false);
    }
  }

  async function retryAfterSignIn() {
    setBusy(true);
    setError(null);
    try {
      const state = await getClaudeBackend().retryAfterAuth();
      // Still refusing means the sign-in did not take — say so, rather than
      // re-rendering the same card with no acknowledgement that anything
      // happened.
      if (state.kind === 'auth-required') {
        setError('Claude still reports you as signed out. Finish the sign-in in the terminal, then try again.');
      }
    } catch (e) {
      setError(toMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (selectedAgent !== 'claude') return null;

  // Auth outranks setup: the agent only reports `auth_required` once it is
  // installed and running, so there is nothing left to install at this point.
  if (connect.kind === 'auth-required') {
    return (
      <Card
        icon={<LogIn size={16} />}
        title="Sign in to Claude"
        body="Claude Code uses your own Anthropic account. UnityIDE never sees those credentials."
        error={error}
      >
        {authMethods.length === 0 ? (
          <Note>
            This agent needs authentication but offered no sign-in method UnityIDE can
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

  // Nothing on the machine is missing. What is left is the connection itself —
  // checked AFTER the setup switch below would have fired, so a real
  // "install Node" never loses to a stale "could not start".
  if (!setup || setup.kind === 'ready' || setup.kind === 'outdated') {
    // `outdated` still runs. Nagging someone mid-task about a version bump they
    // may not be able to download right now would be worse than the drift.

    // No folder: the composer is disabled and says so, but the picker says
    // "Claude Code", so name the piece that is actually missing.
    if (!workspacePath) {
      return (
        <Card
          icon={<Plug size={16} />}
          title="Open a folder"
          body="Claude Code runs inside a project folder — open one and it will connect."
          error={error}
        />
      );
    }

    // Worth showing rather than leaving blank: a first launch installs nothing
    // but still spends several seconds spawning Node and negotiating the
    // session, and an empty panel for that long reads as a dead feature rather
    // than a slow one.
    if (connect.kind === 'connecting') {
      return (
        <Card
          icon={<LoaderCircle size={16} className="spin" />}
          title="Starting Claude Code…"
          body="Launching the agent and opening a session for this folder."
          error={error}
        />
      );
    }

    // The handshake failed, or the subprocess would not stay up. Distinct from
    // a setup problem: nothing is missing, so there is nothing to install and
    // the only useful action is to try again.
    if (connect.kind === 'failed') {
      return (
        <Card
          icon={<AlertTriangle size={16} />}
          title="Claude Code could not start"
          body={connect.message}
          error={error}
        >
          <button type="button" style={primaryBtnStyle} disabled={busy} onClick={() => void reconnect()}>
            <RefreshCw size={13} />
            {busy ? 'Connecting…' : 'Try again'}
          </button>
        </Card>
      );
    }

    // The probe itself threw — rare, but it means we know nothing about the
    // machine, so failing silently would leave the panel dead with no reason.
    if (error) {
      return (
        <Card icon={<AlertTriangle size={16} />} title="Could not check for Claude Code" body={error} error={null}>
          <RetryButton onClick={() => void reconnect()} label="Check again" />
        </Card>
      );
    }

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
          body="Node.js is installed but npm is not on your PATH, so UnityIDE cannot install the Claude agent."
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
              ? 'UnityIDE will install the Claude agent adapter and connect it to the Claude CLI you already have.'
              : 'UnityIDE will install the Claude agent locally. This downloads a few hundred megabytes the first time.'
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
  /** Optional: some states are pure status and have no action to offer. */
  children?: React.ReactNode;
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
