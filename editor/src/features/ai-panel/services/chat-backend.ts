/**
 * One dispatch point for "which agent handles this message".
 *
 * The previous external-agent integration scattered `selectedAgent === 'claude'`
 * branches across six components, and unwinding them was most of the work when
 * it was removed. This module exists so there is exactly one branch: everything
 * downstream — the message list, tool blocks, permission cards, plan list,
 * checkpoints, review queue — stays backend-agnostic.
 *
 * The Arcane backend is `AgentService` unchanged; nothing about the hosted path
 * moves or is re-routed through here.
 */

import { useAiStore } from '../../../stores/ai';
import { useAuthStore } from '../../../stores/auth';
import { useConnectivityStore } from '../../../stores/connectivity';
import { useServerConfigStore, acpAllowed } from '../../../stores/server-config';
import { getAgentService, type SendMessageOptions } from './agent-service';
import { getClaudeBackend, resetClaudeBackend } from './claude-backend';
import {
  externalAgentStatus,
  refuseSendReason,
  type ExternalAgentGate,
  type ExternalAgentStatus,
} from './external-agent-gate';
import type { AgentKind } from './types';

/**
 * What a chat message needs from whichever backend is selected.
 *
 * Deliberately narrow. `AgentService` has a much larger surface (resume, plan
 * execution, rewind, telemetry), but those are Arcane-loop concerns that
 * `plan-controller`, `retry-turn` and `session-restore` call directly and that
 * an external agent has no equivalent for.
 */
export interface ChatBackend {
  readonly kind: AgentKind;
  sendMessage(text: string, opts: SendMessageOptions): Promise<void>;
  abort(): void;
}

/**
 * Read the entitlement inputs from the stores.
 *
 * Non-reactive by design — this is the send path, which wants the value at the
 * moment of sending. Components read the same stores through hooks so they
 * re-render when the plan or connectivity changes.
 */
export function readExternalAgentGate(): ExternalAgentGate {
  const auth = useAuthStore.getState();
  return {
    loggedIn: auth.loggedIn,
    online: useConnectivityStore.getState().online,
    plan: auth.plan,
    acpEnabled: acpAllowed(useServerConfigStore.getState().config, auth.plan),
  };
}

export function currentExternalAgentStatus(): ExternalAgentStatus {
  return externalAgentStatus(readExternalAgentGate());
}

export function getChatBackend(): ChatBackend {
  return useAiStore.getState().selectedAgent === 'claude'
    ? getClaudeBackend()
    : getAgentService();
}

/**
 * Send through the selected backend, refusing an unentitled external send.
 *
 * The gate is re-read here rather than trusted from selection time, so a plan
 * that lapses mid-session blocks the next message. The check is intentionally
 * duplicated with `AgentPicker`'s: the picker prevents the situation, this
 * prevents the outcome (a session restored from disk already has `'claude'`
 * selected before any picker renders).
 */
export async function sendChatMessage(text: string, opts: SendMessageOptions): Promise<void> {
  const ai = useAiStore.getState();
  const refusal = refuseSendReason(ai.selectedAgent, readExternalAgentGate());
  if (refusal) {
    ai.setError(refusal);
    return;
  }
  await getChatBackend().sendMessage(text, opts);
}

/**
 * Tear down every external agent — on workspace change, on sign-out, and when
 * the user switches back to the Arcane agent.
 *
 * A subprocess pinned to a workspace that is no longer open would answer the
 * next prompt with stale file context, so this is not merely tidiness.
 */
export async function disposeExternalBackends(): Promise<void> {
  await resetClaudeBackend();
}
