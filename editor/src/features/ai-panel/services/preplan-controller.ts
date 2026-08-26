/**
 * Agent-mode preplanning controller (Task 11) — the agent-mode sibling of
 * `plan-controller.ts`'s two-phase plan workflow, but automatic and lighter:
 * on tiers with preplanning enabled and no live todo list, a composer send
 * runs a read-only context-gathering pass first (the 'preplanning' prompt +
 * todo tool only), then automatically chains into normal agent-mode
 * execution of the todo list it produced. No plan file, no user review step —
 * `routeAgentSend` (preplan-route.ts) decides per send whether a preplanning
 * pass is even needed (a live, unfinished todo list means one already ran).
 *
 * `runAgentModeSend` below is deliberately deps-injected rather than
 * reaching for `useAiStore`/`getAgentService()` directly at module scope, the
 * way `plan-controller.ts` does: that file has no test of its own precisely
 * because `stores/ai.ts` and `agent-service.ts` both pull in a DOM-touching
 * import graph that plain `bun test` cannot load (see `hosted-stream.test.ts`
 * and `session-persistence.test.ts`'s headers), and `stores/ai` is already
 * `mock.module`'d — process-globally — by `hosted-stream.test.ts`, so a
 * second, differently-shaped mock for it here would collide (same landmine
 * `stores/checkpoints.test.ts`'s header documents for the ai-panel barrel).
 * Injecting the three live accessors this controller needs sidesteps both
 * problems and mirrors the "Bun-safe by construction" DI seam `todo-tool.ts`
 * and `ask-user-tool.ts` already use for the same reason (dynamic import of
 * the real store only in the production default, never at module scope).
 * The exported `agentModeController` singleton is the thin production
 * wrapper — same call shape (`sendAgentModeMessage(text, attachments)`) as
 * `planController`'s methods.
 */
import { shouldPreplanTier, type ServerConfig } from '../../../stores/server-config';
import { routeAgentSend } from './preplan-route';
import type { Attachment, ChatMode, Effort } from './types';
// Type-only — erased at compile time, so this doesn't pull `stores/ai.ts`'s
// DOM-touching import graph into this module. Same discipline `todo-tool.ts`
// documents for its own type-only `HostedPlanEntry` import.
import type { HostedPlanEntry } from '../../../stores/ai';

/** The synthetic send-2 prompt: LLM-only history text, never a user bubble
 *  (this module never calls `addUserMessage` — see `runAgentModeSend`'s
 *  final call below). */
const RESUME_AFTER_PREPLAN_TEXT =
  '[Pre-planning complete. The todo list you created is your task list — execute it now, ' +
  'marking items in_progress and done with todo_update as you go.]';

/** Minimal seam onto `AgentService` this controller needs. */
export interface PreplanAgentService {
  sendMessage(
    text: string,
    opts: {
      mode: ChatMode;
      effort: Effort;
      attachments?: Attachment[];
      promptMode?: 'preplanning' | 'agent';
    },
  ): Promise<void>;
  /** Persisted `abortRequested` flag — true iff the USER stopped the most recent send. */
  wasLastSendAborted(): boolean;
}

/** Minimal seam onto the ai store's live state this controller reads. */
export interface PreplanAiState {
  mode: ChatMode;
  effort: Effort;
  hostedPlan: HostedPlanEntry[] | null;
  /** Only `role` is read (the error-tail chain-guard) — kept structural so a
   *  fake in tests never needs the store's full `AiMessage` shape. */
  messages: ReadonlyArray<{ role: string }>;
  addSystemMessage(text: string): string;
}

export interface AgentModeDeps {
  getAiState: () => PreplanAiState;
  getServerConfig: () => ServerConfig | null;
  getAgentService: () => PreplanAgentService;
}

/** "hostedPlan has no non-done items" — the same predicate `preplan-route.ts`
 *  uses to decide whether a preplanning pass is even needed, reused here to
 *  decide whether the pass that just ran actually produced anything. */
function hasRemainingTodos(plan: HostedPlanEntry[] | null): boolean {
  return !!plan && plan.some((item) => item.status !== 'done');
}

/**
 * Core orchestration for an agent-mode composer send, deps-injected (see the
 * module header). `agentModeController.sendAgentModeMessage` below supplies
 * the real deps via dynamic import.
 */
export async function runAgentModeSend(
  deps: AgentModeDeps,
  text: string,
  attachments: Attachment[] = [],
): Promise<void> {
  const state = deps.getAiState();
  // Caller guarantees: ChatInput's handleSubmit only reaches the agent-mode
  // branch for `mode === 'agent'` on the UnityIDE backend (it already returns
  // early for `selectedAgent !== 'hosted'` and routes 'plan' elsewhere) —
  // assert cheaply rather than silently mis-sending on a future call site
  // that gets this wrong.
  console.assert(
    state.mode === 'agent',
    'agentModeController.sendAgentModeMessage called outside agent mode',
  );

  const effort = state.effort;
  const agentService = deps.getAgentService();
  const decision = routeAgentSend(shouldPreplanTier(deps.getServerConfig(), effort), state.hostedPlan);

  if (decision === 'execute') {
    await agentService.sendMessage(text, { mode: 'agent', effort, attachments });
    return;
  }

  // 'preplan' — Send 1: read-only exploration + exactly one todo_update call.
  await agentService.sendMessage(text, {
    mode: 'agent',
    effort,
    attachments,
    promptMode: 'preplanning',
  });

  // Chain-guards: each one on its own must prevent (or redirect) send 2.
  //
  // (i) The user stopped the preplanning turn — nothing more to chain into.
  if (agentService.wasLastSendAborted()) return;

  // (ii) The preplanning turn errored — the T5 choke point's outcome
  // inspection appends a `role: 'error'` message for every error/crash tail
  // (agent-service.ts's `runSend`); check the freshest state, not the
  // snapshot from before send 1 ran.
  const afterSend1 = deps.getAiState();
  const lastMessage = afterSend1.messages[afterSend1.messages.length - 1];
  if (lastMessage?.role === 'error') return;

  // (iii) FAIL OPEN: the preplanning turn produced no non-done todo (the
  // model skipped its required todo_update, or checked everything off
  // immediately) — still execute the user's request rather than stranding
  // it on an empty preplan. Attachments are NOT repeated: send 1 already
  // carried them into the conversation history.
  if (!hasRemainingTodos(afterSend1.hostedPlan)) {
    await agentService.sendMessage(text, { mode: 'agent', effort });
    return;
  }

  const taskCount = afterSend1.hostedPlan!.filter((item) => item.status !== 'done').length;
  afterSend1.addSystemMessage(`Pre-planning complete — executing ${taskCount} tasks`);

  // Send 2: a synthetic pointer, not the user's own words. Never added as a
  // user bubble — this module never calls `addUserMessage` (only ChatInput's
  // `handleSubmit` does, once, for the ORIGINAL text, before this controller
  // ever runs), the same "sendMessage without a fresh addUserMessage" contract
  // `plan-controller.ts`'s `executePlan` pointer text relies on (see
  // `checkpoint-selection.ts`'s header, which documents that exact precedent).
  await agentService.sendMessage(RESUME_AFTER_PREPLAN_TEXT, {
    mode: 'agent',
    effort,
    promptMode: 'agent',
  });
}

async function liveDeps(): Promise<AgentModeDeps> {
  const [{ useAiStore }, { useServerConfigStore }, { getAgentService }] = await Promise.all([
    import('../../../stores/ai'),
    import('../../../stores/server-config'),
    import('./agent-service'),
  ]);
  return {
    getAiState: () => useAiStore.getState(),
    getServerConfig: () => useServerConfigStore.getState().config,
    getAgentService: () => getAgentService(),
  };
}

export const agentModeController = {
  async sendAgentModeMessage(text: string, attachments: Attachment[] = []): Promise<void> {
    await runAgentModeSend(await liveDeps(), text, attachments);
  },
};
