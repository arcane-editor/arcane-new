/**
 * What the composer's placeholder promises, given who is going to answer.
 *
 * Pure and separate from `ChatInput` for the reason `empty-state.ts` gives:
 * this project has no component-test infrastructure, so the copy rules worth
 * verifying live outside the React wiring.
 *
 * The rule this module exists to hold: a placeholder is a claim about what
 * pressing Enter will do, so it may only mention settings the receiving agent
 * actually reads. Arcane's `mode` is one of those for the Arcane loop and none
 * of them for an external agent, which runs its own loop and exposes its own
 * equivalents as session config options in the toolbar beside this text.
 */

import type { AgentKind, ChatMode } from '../services/types';
import { isExternalAgent } from '../services/types';

export interface PlaceholderInput {
  agent: AgentKind;
  /** Arcane's chat mode. Meaningless — and unread — for an external agent. */
  mode: ChatMode;
  /** Plan mode with a plan already written and awaiting (or mid-) execution. */
  planResumePending: boolean;
  /** The agent is blocked on an `ask_user` question, so typing answers it. */
  pendingQuestion: boolean;
}

/** Shown in place of the agent's name when we have nothing better. */
const AGENT_LABEL: Record<Exclude<AgentKind, 'arcane'>, string> = {
  claude: 'Claude Code',
};

export function composerPlaceholder(input: PlaceholderInput): string {
  // Answer mode outranks everything: the next Enter resolves the question, no
  // matter which agent asked it or what mode is selected behind it.
  if (input.pendingQuestion) {
    return "Answer the agent's question — or click an option above.";
  }

  if (isExternalAgent(input.agent)) {
    return `Ask ${AGENT_LABEL[input.agent]} to build, edit, or explain. @ for context, ⏎ to send.`;
  }

  if (input.mode === 'ask') {
    return 'Ask a question about your Unity project. @ for context, ⏎ to send.';
  }

  if (input.mode === 'plan') {
    return input.planResumePending
      ? 'Message continues the current plan — Regenerate to re-plan. ⏎ to send.'
      : 'Describe what you want to build. @ for context, ⏎ to plan.';
  }

  return 'Plan, build, edit. @ for context, ⏎ to send.';
}
