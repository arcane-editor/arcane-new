/**
 * Deciding whether an external agent can be launched, and installing it if not.
 *
 * The Claude adapter (`@agentclientprotocol/claude-agent-acp`) is a Node
 * package, so "can we run it?" has several independent answers — no Node, Node
 * too old, no npm, not installed, installed-but-stale, installed against a
 * `claude` binary that has since been deleted. `resolveSetupState` collapses a
 * probe into exactly one of them, as a pure function, so every branch is
 * testable without a machine in that state.
 *
 * The version pin lives in Rust (`src-tauri/src/acp.rs`) because Rust performs
 * the install; it is echoed back in the probe so this layer can compare rather
 * than duplicate it.
 */

import { invoke } from '@tauri-apps/api/core';

/** Minimum Node the adapter's `engines` field allows. */
export const REQUIRED_NODE_MAJOR = 22;

/** Snapshot of the machine, as reported by the Rust `acp_probe` command. */
export interface AcpProbe {
  nodePath: string | null;
  /** Raw `node -v` output, e.g. `"v24.12.0"`. */
  nodeVersion: string | null;
  npmPath: string | null;
  /** The user's own Claude Code CLI, if they have one. */
  claudePath: string | null;
  /** Version recorded in our install manifest, or null when not installed. */
  installedVersion: string | null;
  /** Absolute path to the adapter's entrypoint, when installed. */
  adapterEntry: string | null;
  /**
   * True when we installed with `--omit=optional`, i.e. the adapter has no
   * bundled native binary and MUST be pointed at `claudePath`.
   */
  usesExternalCli: boolean;
  /** The version Rust would install right now. */
  pinnedVersion: string;
}

export type AcpSetupState =
  /** Everything present — these are the exact spawn parameters. */
  | { kind: 'ready'; command: string; args: string[]; env: Record<string, string> }
  | { kind: 'node-missing' }
  | { kind: 'node-too-old'; found: string; required: number }
  | { kind: 'npm-missing' }
  | { kind: 'not-installed' }
  | { kind: 'outdated'; installed: string; pinned: string }
  /** Installed lean, but the `claude` binary it was pointed at is gone. */
  | { kind: 'cli-missing' };

/** `"v24.12.0"` → `24`. Returns null for anything unparseable. */
export function parseNodeMajor(version: string | null): number | null {
  if (!version) return null;
  const match = /^v?(\d+)\./.exec(version.trim());
  return match ? Number(match[1]) : null;
}

/**
 * The single reason setup is incomplete, or `ready` with the spawn parameters.
 *
 * Order matters. Node is checked before npm and before "installed", because a
 * machine with no Node cannot use an adapter even if one is somehow on disk —
 * telling the user to reinstall would send them down the wrong path.
 * `cli-missing` is checked before `outdated` so a broken install is repaired
 * rather than merely bumped.
 */
export function resolveSetupState(probe: AcpProbe): AcpSetupState {
  if (!probe.nodePath) return { kind: 'node-missing' };

  const major = parseNodeMajor(probe.nodeVersion);
  if (major === null || major < REQUIRED_NODE_MAJOR) {
    return {
      kind: 'node-too-old',
      found: probe.nodeVersion ?? 'unknown',
      required: REQUIRED_NODE_MAJOR,
    };
  }

  if (!probe.installedVersion || !probe.adapterEntry) {
    // npm is only needed to INSTALL. An already-installed adapter runs fine on
    // a machine where npm has since been removed, so this check sits here
    // rather than above.
    return probe.npmPath ? { kind: 'not-installed' } : { kind: 'npm-missing' };
  }

  if (probe.usesExternalCli && !probe.claudePath) return { kind: 'cli-missing' };

  if (probe.installedVersion !== probe.pinnedVersion) {
    return {
      kind: 'outdated',
      installed: probe.installedVersion,
      pinned: probe.pinnedVersion,
    };
  }

  return {
    kind: 'ready',
    command: probe.nodePath,
    args: [probe.adapterEntry],
    env: probe.usesExternalCli && probe.claudePath
      ? { CLAUDE_CODE_EXECUTABLE: probe.claudePath }
      : {},
  };
}

/**
 * An `outdated` adapter still runs. Offer the upgrade, never force it — a user
 * mid-task on a plane should not be blocked by a version bump.
 */
export function isLaunchable(state: AcpSetupState): boolean {
  return state.kind === 'ready' || state.kind === 'outdated';
}

/**
 * Spawn parameters for a launchable state. Returns null when setup must be
 * completed first.
 */
export function launchParams(
  state: AcpSetupState,
  probe: AcpProbe,
): { command: string; args: string[]; env: Record<string, string> } | null {
  if (state.kind === 'ready') {
    return { command: state.command, args: state.args, env: state.env };
  }
  if (state.kind === 'outdated' && probe.nodePath && probe.adapterEntry) {
    return {
      command: probe.nodePath,
      args: [probe.adapterEntry],
      env: probe.usesExternalCli && probe.claudePath
        ? { CLAUDE_CODE_EXECUTABLE: probe.claudePath }
        : {},
    };
  }
  return null;
}

/** One line of installer output, streamed while `acp_install` runs. */
export interface AcpInstallProgress {
  agentId: string;
  line: string;
  stream: 'stdout' | 'stderr';
}

export function probeClaudeAgent(): Promise<AcpProbe> {
  return invoke<AcpProbe>('acp_probe', { agentId: 'claude' });
}

/**
 * Install (or upgrade) the adapter.
 *
 * `reuseExistingCli` trades disk and time for a dependency on the user's own
 * Claude CLI: with it, npm runs `--omit=optional` and skips the adapter's
 * platform-specific native binary — a ~321 MB unpacked download — and the agent
 * is pointed at `claudePath` instead. Callers should pass `true` whenever
 * `probe.claudePath` is set.
 */
export function installClaudeAgent(reuseExistingCli: boolean): Promise<AcpProbe> {
  return invoke<AcpProbe>('acp_install', { agentId: 'claude', reuseExistingCli });
}
