/**
 * What the composer's placeholder promises, given who is going to answer.
 *
 * Pure and separate from `ChatInput` for the reason `empty-state.ts` gives:
 * this project has no component-test infrastructure, so the copy rules worth
 * verifying live outside the React wiring.
 *
 * The rule this module exists to hold: a placeholder is a claim about what
 * pressing Enter will do, so it may only mention settings the receiving agent
 * actually reads. UnityIDE's `mode` is one of those for the UnityIDE loop and none
 * of them for an external agent, which runs its own loop and exposes its own
 * equivalents as session config options in the toolbar beside this text.
 */

import type { AgentKind, ChatMode } from '../services/types';
import { isExternalAgent } from '../services/types';

export interface PlaceholderInput {
  agent: AgentKind;
  /** UnityIDE's chat mode. Meaningless — and unread — for an external agent. */
  mode: ChatMode;
  /**
   * What Enter will actually do in plan mode — taken straight from
   * `routePlanSend` rather than re-derived from the phase, so the promise the
   * placeholder makes cannot drift from the routing that keeps it. Ignored
   * outside plan mode.
   */
  planRoute: 'revise' | 'resume' | 'plan';
  /** The agent is blocked on an `ask_user` question, so typing answers it. */
  pendingQuestion: boolean;
}

/** Shown in place of the agent's name when we have nothing better. */
const AGENT_LABEL: Record<Exclude<AgentKind, 'hosted'>, string> = {
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
    if (input.planRoute === 'revise') {
      return 'Message revises the plan — Execute when it looks right. ⏎ to send.';
    }
    if (input.planRoute === 'resume') {
      return 'Message resumes the plan from where it stopped. ⏎ to send.';
    }
    return 'Describe what you want to build. @ for context, ⏎ to plan.';
  }

  return 'Plan, build, edit. @ for context, ⏎ to send.';
}
