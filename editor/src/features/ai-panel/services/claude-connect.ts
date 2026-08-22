/**
 * Why an external agent cannot answer a prompt yet, as one closed set of
 * states.
 *
 * Split out of `claude-backend.ts` so the classification is pure and testable
 * without a subprocess, and so `ClaudeSetupGate` can import the vocabulary
 * without importing the backend's whole dependency graph.
 *
 * The distinction this draws is the entire point. All three failures arrive at
 * the same `catch`, but only one of them is an *error*:
 *
 *   - `auth-required`  the user has never signed in to Claude. There is a card
 *                      with a sign-in button for this, driven by
 *                      `agentNeedsAuth`. Rendering it as a transcript error
 *                      instead — which is what used to happen, because
 *                      `session/new`'s `-32000` was never classified — leaves
 *                      the one actionable state with no way to appear.
 *   - `setup-required` the machine is missing Node, npm or the adapter. Also a
 *                      card, with an installer.
 *   - `failed`         a genuine fault. This one belongs in the transcript.
 */

import { isAuthRequired, toMessage, type AcpSetupState } from '../../acp';

/** Raised when the machine is not ready to run the agent yet. */
export class ClaudeSetupRequiredError extends Error {
  constructor(readonly state: AcpSetupState) {
    super('Claude Code is not set up yet.');
    this.name = 'ClaudeSetupRequiredError';
  }
}

export type ClaudeConnectState =
  /** Nothing has been attempted — the agent is not selected, or has no cwd. */
  | { kind: 'idle' }
  | { kind: 'connecting' }
  /** Subprocess up, handshake done, session open. Prompts may be sent. */
  | { kind: 'ready' }
  | { kind: 'auth-required' }
  | { kind: 'setup-required'; state: AcpSetupState }
  | { kind: 'failed'; message: string };

export type ClaudeConnectFailure = Extract<
  ClaudeConnectState,
  { kind: 'auth-required' | 'setup-required' | 'failed' }
>;

export function classifyConnectError(error: unknown): ClaudeConnectFailure {
  if (isAuthRequired(error)) return { kind: 'auth-required' };
  if (error instanceof ClaudeSetupRequiredError) {
    return { kind: 'setup-required', state: error.state };
  }
  return { kind: 'failed', message: toMessage(error) };
}

/**
 * True while the agent cannot take a prompt and the gate is showing why.
 *
 * `idle` is not blocking: it is the state before the panel has asked for a
 * connection at all, and the send path opens one on demand.
 */
export function connectStateIsBlocking(state: ClaudeConnectState): boolean {
  return state.kind !== 'idle' && state.kind !== 'ready';
}
