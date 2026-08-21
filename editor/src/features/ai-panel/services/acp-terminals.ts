/**
 * ACP `terminal/*` on behalf of an external agent.
 *
 * The agent addresses terminals by an opaque string id it chooses; Rust hands
 * back a numeric handle. This module owns the mapping between the two, so the
 * translation never leaks into the protocol layer or the backend.
 *
 * Terminals live for the length of an agent session, not a turn: an agent may
 * start a dev server in one turn and read its output in the next. `releaseAll`
 * is therefore called on session teardown, not on turn end.
 */

import { invoke } from '@tauri-apps/api/core';
import type {
  TerminalCreateParams,
  TerminalOutputResult,
  TerminalRefParams,
  TerminalWaitResult,
} from '../../acp';
import { useWorkspaceStore } from '../../../stores/workspace';

interface RustOutputResult {
  output: string;
  truncated: boolean;
  exited: boolean;
  exitCode: number | null;
  signal: string | null;
}

export class AcpTerminals {
  /** Agent-facing terminal id → the Rust handle. */
  private readonly handles = new Map<string, number>();
  private nextId = 1;

  async create(params: TerminalCreateParams): Promise<{ terminalId: string }> {
    const id = await invoke<number>('acp_terminal_create', {
      command: params.command,
      args: params.args ?? [],
      // An agent may omit cwd; the project root is the only sane default, and
      // matches the `cwd` the session was created with.
      cwd: params.cwd ?? useWorkspaceStore.getState().workspacePath ?? null,
      env: params.env ?? [],
      outputByteLimit: params.outputByteLimit ?? null,
    });

    // The agent-facing id is ours to choose. A `term_` prefix keeps it
    // recognisable in the protocol trace next to Rust's bare numbers.
    const terminalId = `term_${this.nextId++}`;
    this.handles.set(terminalId, id);
    return { terminalId };
  }

  async output(params: TerminalRefParams): Promise<TerminalOutputResult> {
    const handle = this.resolve(params.terminalId);
    const result = await invoke<RustOutputResult>('acp_terminal_output', { id: handle });
    return {
      output: result.output,
      truncated: result.truncated,
      // ACP wants `null` for a process that is still running, and an object
      // only once it has actually exited — an object full of nulls would read
      // as "exited with unknown status".
      exitStatus: result.exited
        ? { exitCode: result.exitCode, signal: result.signal }
        : null,
    };
  }

  async waitForExit(params: TerminalRefParams): Promise<TerminalWaitResult> {
    const handle = this.resolve(params.terminalId);
    return invoke<TerminalWaitResult>('acp_terminal_wait', { id: handle });
  }

  async kill(params: TerminalRefParams): Promise<null> {
    await invoke('acp_terminal_kill', { id: this.resolve(params.terminalId) });
    return null;
  }

  async release(params: TerminalRefParams): Promise<null> {
    const handle = this.resolve(params.terminalId);
    this.handles.delete(params.terminalId);
    await invoke('acp_terminal_release', { id: handle });
    return null;
  }

  /**
   * Release every terminal this session opened.
   *
   * Best-effort per terminal: one failure must not strand the rest. Rust's
   * per-window teardown is the real backstop, but that only runs when the
   * window closes — this keeps a long-lived window from accumulating dead
   * processes across many agent sessions.
   */
  async releaseAll(): Promise<void> {
    // Snapshot the handles BEFORE clearing — reading them back out of a map we
    // just emptied would release nothing.
    const handles = [...this.handles.values()];
    this.handles.clear();
    await Promise.allSettled(
      handles.map((id) => invoke('acp_terminal_release', { id })),
    );
  }

  private resolve(terminalId: string): number {
    const handle = this.handles.get(terminalId);
    if (handle === undefined) {
      // Thrown back to the agent as a tool error, which it can recover from by
      // creating a new terminal — better than a silent no-op it would read as
      // an empty command output.
      throw new Error(`Unknown terminal '${terminalId}'.`);
    }
    return handle;
  }
}
