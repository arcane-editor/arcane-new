/**
 * Agent service — singleton that orchestrates the PI agent loop
 * with the Arcane server StreamFn and Tauri-backed tools.
 *
 * Per-call configuration: chat mode (ask/agent/plan) drives system prompt
 * + tool subset; effort (low/mid/high) drives reasoning level.
 *
 * Tools and prompt are rebuilt before every send so the agent always
 * operates on the current workspace + the right mode.
 */

import { Agent } from './vendor/agent';
import { convertToLlm } from './vendor/messages';
import { createReadTool } from './vendor/tools/read';
import { createWriteTool } from './vendor/tools/write';
import { createEditTool } from './vendor/tools/edit';
import { createBashTool } from './vendor/tools/bash';
import { createListTool } from './vendor/tools/list';
import { createTodoTool } from './todo-tool';
import {
  createGraphifyExplainTool,
  createGraphifyPathTool,
  createGraphifyQueryTool,
} from '../../graphify';
import { useGraphifyStore } from '../../../stores/graphify';
import { arcaneStream } from './arcane-stream';
import {
  tauriReadOperations,
  tauriWriteOperations,
  tauriEditOperations,
  tauriBashOperations,
  tauriListOperations,
  onFileWritten,
  onFileEdited,
} from './tool-operations';
import {
  createUnityReadTools,
  createUnityMutateTools,
  withUnityAnalyzerGate,
  withUnityCompileGate,
  withLspDiagnosticsGate,
  resetCompileGate,
} from './unity-tools';
import { withCheckpoint } from './checkpoints/checkpoint-gate';
import { withTurnGovernor, resetTurnGovernor, grantExtraCalls } from './turn-governor';
import { withTurnEscalation, resetTurnEscalation } from './turn-escalation';
import { withRepeatCallGuard, resetRepeatCallGuard } from './tool-guards';
import { resetTurnTelemetry, recordTelemetryEvent, recordGroundingLintHit } from './turn-telemetry';
import {
  beginVerifiedPass,
  recordTouchedFile,
  touchedFileCount,
  runVerifiedPass,
} from './verified-pass';
import { useAiStore, type AiMessage } from '../../../stores/ai';
import { useAuthStore } from '../../../stores/auth';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useProjectContextStore } from '../../../stores/project-context';
import { useSettingsStore } from '../../../stores/settings';
import { useCheckpointsStore } from '../../../stores/checkpoints';
import { buildSystemPrompt, defaultPromptModeFor, type PromptMode } from './prompts';
import { getUnityGroundingContext } from './prompts/unity-facts';
import type { ContrastFacts } from './prompts/unity-contrast';
import { lintAnswer, buildReviseMessage } from './grounding-lint';
import { resolveAttachments } from './attachments';
import type { Model, AgentTool, AgentMessage, TextContent } from './vendor/types';
import { TIER_CONTEXT_WINDOWS, type Attachment, type ChatMode, type Effort } from './types';

/** Convert saved UI messages back into vendor AgentMessages for resume. */
function restoreAgentMessages(messages: AiMessage[]): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.text ?? '', timestamp: m.timestamp });
    } else if (m.role === 'assistant') {
      out.push({ role: 'assistant', content: m.content ?? [], timestamp: m.timestamp });
    } else if (m.role === 'toolResult') {
      out.push({
        role: 'toolResult',
        toolCallId: m.toolCallId ?? '',
        toolName: m.toolName ?? '',
        content: m.toolResult?.content ?? '',
        isError: m.toolResult?.isError ?? false,
        timestamp: m.timestamp,
      });
    }
    // system / permissionRequest / verifiedPass are not part of LLM history — skip.
  }
  return out;
}

const PLACEHOLDER_MODEL: Model = { id: 'auto', name: 'auto', provider: 'arcane' };

function getCurrentWorkspacePath(): string {
  return useWorkspaceStore.getState().workspacePath ?? '/';
}

/**
 * ASK + PLAN-planning → read + list (no mutations).
 * AGENT and PLAN-execution → all five (read, list, write, edit, bash), plus
 * `todo_update` (P3.5's in-loop todo tool — mutating modes only, since a
 * read-only conversation has no multi-step work to track).
 *
 * Graphify tools (query, explain, path) are read-only and join every mode
 * when a graph has been built for the workspace.
 */
function createToolsForPromptMode(mode: PromptMode, workspacePath: string): AgentTool[] {
  const isUnity = useProjectContextStore.getState().isUnityProject;
  // In a Unity project, confine ALL of the agent's file operations to the
  // Assets/ folder. `assetsRootPath` is `${workspacePath}/Assets` for Unity
  // projects, null otherwise (which disables the sandbox for non-Unity work).
  const allowedRoot = isUnity
    ? (useWorkspaceStore.getState().assetsRootPath ?? null)
    : null;

  const readOnly: AgentTool[] = [
    createReadTool(workspacePath, {
      operations: tauriReadOperations,
      allowedRoot,
    }),
    createListTool(workspacePath, {
      operations: tauriListOperations,
      allowedRoot,
    }),
  ];

  const graphStatus = useGraphifyStore.getState().status;
  const graphAvailable = graphStatus === 'present' || graphStatus === 'stale';
  const graphTools: AgentTool[] = graphAvailable
    ? [
        createGraphifyQueryTool(workspacePath),
        createGraphifyExplainTool(workspacePath),
        createGraphifyPathTool(workspacePath),
      ]
    : [];

  // Unity tools join only for Unity projects. Read tools are auto-approved and
  // available in every mode; engine-mutate tools (per-action approved) only join
  // the mutating modes. The analyzer-gate wraps write/edit on .cs output.
  const settings = useSettingsStore.getState();
  const analyzersOn =
    isUnity && settings.getSetting('unity.analyzers.enabled') !== false;
  // Live-bridge compile gate: real Unity compiler errors fed back to the agent.
  // Default-on for Unity projects; the gate itself no-ops when no bridge is connected.
  const compileGateOn =
    isUnity && settings.getSetting('unity.compileGate.enabled') !== false;
  // LSP diagnostics gate: csharp-ls error-severity diagnostics fed back to the
  // agent. Default-on; the gate itself no-ops when csharp-ls isn't running.
  const lspGateOn = isUnity && settings.getSetting('unity.lspGate.enabled') !== false;
  const unityRead: AgentTool[] = isUnity ? createUnityReadTools() : [];

  if (mode === 'ask' || mode === 'plan-planning') {
    return [...readOnly, ...graphTools, ...unityRead].map(withRepeatCallGuard);
  }

  // Verified-pass (P3.4) registers every file the send touches by composing
  // onto the existing onFileWritten/onFileEdited hooks — the vendor write/edit
  // tools themselves are untouched.
  const writeTool = createWriteTool(workspacePath, {
    operations: tauriWriteOperations,
    onFileWritten: (path) => {
      recordTouchedFile(path);
      onFileWritten(path);
    },
    allowedRoot,
  });
  const editTool = createEditTool(workspacePath, {
    operations: tauriEditOperations,
    onFileEdited: (path) => {
      recordTouchedFile(path);
      onFileEdited(path);
    },
    allowedRoot,
  });

  // Wrap .cs write/edit with the analyzer gate (instant, offline, regex) innermost,
  // then the LSP gate (csharp-ls, live but no engine needed), then the compile gate
  // (authoritative, needs a live Unity bridge) on the OUTSIDE so it runs last.
  const wrapCs = (t: AgentTool): AgentTool => {
    let g = analyzersOn ? withUnityAnalyzerGate(t, workspacePath) : t;
    if (lspGateOn) g = withLspDiagnosticsGate(g, workspacePath);
    if (compileGateOn) g = withUnityCompileGate(g, workspacePath);
    return g;
  };

  // Checkpoints (P5.2): snapshot the pre-write content before delegating to the
  // raw write/edit tool, so a turn can be restored later. It sits INSIDE the
  // cs-gates (wrapCs wraps the checkpoint-wrapped tool, not the other way
  // around) so snapshots happen right next to the actual write — P5.3 will
  // later insert an approval gate OUTSIDE the checkpoint; today's order is
  // just gates(checkpoint(tool)). `allowedRoot` must match the tools' own
  // sandbox so out-of-root writes (which the tools reject internally) don't
  // record phantom snapshots.
  return [
    ...readOnly,
    ...graphTools,
    ...unityRead,
    ...(isUnity ? createUnityMutateTools() : []),
    wrapCs(withCheckpoint(writeTool, workspacePath, { allowedRoot })),
    wrapCs(withCheckpoint(editTool, workspacePath, { allowedRoot })),
    createBashTool(workspacePath, {
      operations: tauriBashOperations,
      allowedRoot,
    }),
    createTodoTool(),
  ].map(withRepeatCallGuard);
}

let agentInstance: AgentService | null = null;
let lastWorkspacePath: string | null = null;

export interface SendMessageOptions {
  mode: ChatMode;
  effort: Effort;
  /** Staged attachments to include with this send (file/unity-doc/image). */
  attachments?: Attachment[];
  /**
   * Override the prompt mode (Phase 6+: lets plan-controller request
   * 'plan-planning' or 'plan-execution' explicitly). If omitted, defaults from
   * the chat mode.
   */
  promptMode?: PromptMode;
  /** Required when promptMode === 'plan-execution'. */
  planExecution?: { planPath: string; planContent: string };
}

export class AgentService {
  private agent: Agent;
  private unsubscribe: (() => void) | null = null;
  private unsubscribeTelemetry: (() => void) | null = null;

  constructor() {
    const workspacePath = getCurrentWorkspacePath();

    this.agent = new Agent({
      systemPrompt: buildSystemPrompt('agent', workspacePath, { effort: 'mid' }),
      model: PLACEHOLDER_MODEL,
      tools: createToolsForPromptMode('agent', workspacePath),
      // Escalation (P3.6) sits INSIDE the governor: the governor's own
      // per-effort call-cap lookup must keep reading the send's ORIGINAL
      // effort (unaffected by escalation), while only the request actually
      // reaching `arcaneStream` should carry the bumped tier.
      streamFn: withTurnGovernor(withTurnEscalation(arcaneStream)),
      convertToLlm,
      reasoning: 'mid',
      // Server picks the model per reasoningLevel; default to the smallest tier's
      // window so no-LLM compaction triggers early enough for the weakest model.
      contextWindow: 32768,
    });

    this.unsubscribe = this.agent.subscribe((event) => {
      useAiStore.getState().handleAgentEvent(event);
    });
    this.unsubscribeTelemetry = this.agent.subscribe((event) => recordTelemetryEvent(event));
  }

  /**
   * Sync the system prompt + tools for the requested prompt mode against the
   * current workspace path. Called before every send.
   *
   * For plan-execution, the caller must provide planPath + planContent so the
   * approved plan is embedded into the system prompt.
   */
  private syncForPromptMode(
    promptMode: PromptMode,
    effort: Effort,
    planExecutionArgs?: { planPath: string; planContent: string },
  ): void {
    const workspacePath = getCurrentWorkspacePath();

    if (promptMode === 'plan-execution' && !planExecutionArgs) {
      throw new Error('plan-execution requires planPath and planContent');
    }

    this.agent.setSystemPrompt(
      buildSystemPrompt(promptMode, workspacePath, {
        effort,
        planExecution: planExecutionArgs,
      }),
    );

    this.agent.setTools(createToolsForPromptMode(promptMode, workspacePath));
  }

  async sendMessage(text: string, opts: SendMessageOptions): Promise<void> {
    // Guard against concurrent entry: callers like fixConsoleError() invoke
    // sendMessage() without the composer's in-flight guard. Bail out before
    // any reset/mutation below (compile-gate budget, turn telemetry) so a
    // concurrent call can't zero out the in-flight turn's state.
    if (this.agent.isRunning) {
      useAiStore.getState().setError('Agent is already processing a message.');
      return;
    }

    const auth = useAuthStore.getState();
    if (!auth.loggedIn || !auth.token) {
      if (auth.loggedIn && !auth.token) {
        await auth.logout().catch(() => {});
      }
      useAiStore.getState().setError('Sign in to use AI.');
      return;
    }

    // Checkpoints (P5.2): open a new turn for this send so any writes the
    // agent makes get grouped under it for later restore. Requires a
    // sessionId — set by `addUserMessage`/`agent_start` before every normal
    // composer send, but a handful of auxiliary entry points (fixConsoleError)
    // can reach here before one exists; skip rather than mistag the turn with
    // a throwaway id (the next send in that conversation checkpoints normally).
    // Also gated on `ai.checkpoints.enabled` (default on) — the same setting
    // check `checkpoint-gate.ts`'s per-write recording uses, so a turn never
    // opens when the feature is off.
    const sessionIdForTurn = useAiStore.getState().sessionId;
    if (
      sessionIdForTurn &&
      useSettingsStore.getState().getSetting('ai.checkpoints.enabled') !== false
    ) {
      useCheckpointsStore.getState().beginTurn(sessionIdForTurn, this.currentUserMessageId());
    }

    const promptMode: PromptMode = opts.promptMode ?? defaultPromptModeFor(opts.mode);
    this.syncForPromptMode(promptMode, opts.effort, opts.planExecution);
    this.agent.setReasoning(opts.effort);
    // Compaction budget: the real window of the model this tier maps to
    // (server model lineup is fixed; see TIER_CONTEXT_WINDOWS).
    this.agent.setContextWindow(TIER_CONTEXT_WINDOWS[opts.effort]);
    // Fresh compile-gate repair budget per user turn.
    resetCompileGate();
    resetTurnTelemetry();
    // Fresh turn-governor call budget + repeat-call guard registries per
    // send (P3.2) — both wrap streamFn/tools ONCE (constructor /
    // createToolsForPromptMode), so their per-send state needs an explicit
    // reset here, same as the compile gate above.
    resetTurnGovernor();
    // Fresh escalation latch per send (P3.6) — same "wraps streamFn ONCE,
    // needs an explicit per-send reset" reasoning as the governor above.
    resetTurnEscalation();
    resetRepeatCallGuard();
    // Fresh touched-file registry for the verified-pass closing check (P3.4).
    beginVerifiedPass();
    // Fresh todo list per user turn (P3.5) — a new send starts with no plan
    // until the model calls todo_update again, same "cleared on new send"
    // rule the other per-turn state above follows.
    useAiStore.getState().setArcanePlan(null);

    // Resolve attachments. File + Unity-doc become a text prefix; image
    // attachments become content blocks routed through promptStructured().
    let promptText = text;
    let imageBlocks: { type: 'image'; data: string; mimeType: string }[] = [];

    if (opts.attachments && opts.attachments.length > 0) {
      const resolved = await resolveAttachments(opts.attachments);
      if (resolved.warnings.length > 0) {
        useAiStore.getState().setError(resolved.warnings.join(' • '));
      }
      if (resolved.prefix) {
        promptText = resolved.prefix + text;
      }
      // Strip the data: URL prefix to base64 payload only — OpenAI's image_url
      // shape wants raw data URLs but the vendor types model `data` as the
      // base64 payload (mimeType separate), so we normalize here.
      imageBlocks = resolved.images.map((img) => {
        const commaIdx = img.dataUrl.indexOf(',');
        const data = commaIdx >= 0 ? img.dataUrl.slice(commaIdx + 1) : img.dataUrl;
        return { type: 'image' as const, data, mimeType: img.mimeType };
      });
    }

    try {
      if (imageBlocks.length > 0) {
        await this.agent.promptStructured([
          { type: 'text', text: promptText },
          ...imageBlocks,
        ]);
      } else {
        await this.agent.prompt(promptText);
      }

      // Ask-mode grounding linter (P2.2): one forced revise turn, hooked
      // OUTSIDE the vendor loop (architecturally the answer-level sibling of
      // the compile/analyzer gates, which operate at the tool-call level).
      // Agent mode has the compile gate instead — do not wire this there.
      if (opts.mode === 'ask') {
        await this.runGroundingLint();
      } else {
        // Verified-pass closing check (P3.4): the agent/plan-execution sibling
        // of the grounding linter above — runs once the whole send is done,
        // over everything it touched.
        await this.runVerifiedPassIfNeeded(promptMode);
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'Agent is already running') {
        useAiStore.getState().setError('Agent is already processing a message.');
        return;
      }
      useAiStore.getState().setError(
        error instanceof Error ? error.message : 'An unexpected error occurred.',
      );
    }
  }

  /**
   * Ask-mode grounding linter (P2.2). Reverse-scans the just-finished turn's
   * final assistant message (same approach as `tooling/unity-eval/
   * run-task.ts`'s finalAnswer extraction) and, if it uses an API this
   * project's detected facts say is wrong, pushes exactly ONE forced revise
   * turn — never more, even if the revised answer still has issues.
   *
   * No-ops for non-Unity workspaces (same `isUnityProject` gate
   * `getUnityFactsBlock()` uses — the contrast table's rows are Unity-
   * specific, so there's nothing to lint outside a Unity project).
   *
   * Skips a message whose `stopReason` is `'aborted'` (the user cancelled
   * mid-stream — nothing to lint, and prompting again would just restart a
   * cancelled turn). Errors from the revise prompt itself propagate to the
   * caller's existing catch block, same as the initial prompt.
   */
  private async runGroundingLint(): Promise<void> {
    if (!useProjectContextStore.getState().isUnityProject) return;

    const lastAssistant = [...this.agent.getMessages()]
      .reverse()
      .find((m) => m.role === 'assistant');
    if (!lastAssistant || lastAssistant.role !== 'assistant') return;
    if (lastAssistant.stopReason === 'aborted') return;

    const finalText = lastAssistant.content
      .filter((c): c is TextContent => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    if (!finalText) return;

    const ctx = getUnityGroundingContext();
    const facts: ContrastFacts = {
      renderPipeline: ctx.renderPipeline ?? null,
      inputSystem: ctx.inputSystem ?? null,
    };
    const violations = lintAnswer(finalText, facts);
    if (violations.length === 0) return;

    recordGroundingLintHit();
    useAiStore
      .getState()
      .addSystemMessage(`Grounding check — revising: ${violations.length} project-mismatch issue(s)`);
    // Reserve a turn for the revise prompt: the shared governor counter already
    // tracks the main ask-mode send; this grant ensures the revise request can run
    // even if the main send exhausted its cap (a granted call passes through untouched).
    grantExtraCalls(1);
    await this.agent.prompt(buildReviseMessage(violations));
  }

  /**
   * Verified-pass closing check (P3.4). The agent/plan-execution sibling of
   * `runGroundingLint` above: instead of linting the answer text, it re-checks
   * everything the send actually touched (analyzers, a live compile, GUID
   * integrity) and attaches the result as a compact "Verified" card. v1 renders
   * results only — no loop re-entry (in-loop repair already happens via the
   * per-write gates: analyzer-gate.ts, compile-gate.ts, lsp-gate.ts).
   *
   * No-ops for non-Unity workspaces and when the setting is off (same gating
   * shape as the compile/lsp gates in `createToolsForPromptMode`), when
   * nothing was written/edited this send, and when the turn was aborted
   * (same `stopReason` check `runGroundingLint` uses — nothing was "finished"
   * to verify).
   */
  private async runVerifiedPassIfNeeded(promptMode: PromptMode): Promise<void> {
    if (promptMode !== 'agent' && promptMode !== 'plan-execution') return;
    if (touchedFileCount() === 0) return;
    if (!useProjectContextStore.getState().isUnityProject) return;
    if (useSettingsStore.getState().getSetting('unity.verifiedPass.enabled') === false) return;

    const lastAssistant = [...this.agent.getMessages()]
      .reverse()
      .find((m) => m.role === 'assistant');
    if (lastAssistant && lastAssistant.role === 'assistant' && lastAssistant.stopReason === 'aborted') {
      return;
    }

    try {
      const data = await runVerifiedPass(getCurrentWorkspacePath());
      useAiStore.getState().addVerifiedPassMessage(data);
    } catch {
      // runVerifiedPass is already defensive per-step; this is just an extra
      // safety net so a verified-pass failure never surfaces as a send error.
    }
  }

  /**
   * The AiMessage id of the most recent user message — the checkpoint turn's
   * anchor for CheckpointRow. Falls back to a synthesized id on the rare path
   * that reaches `sendMessage` without one (see the `sessionIdForTurn` guard
   * above; this only runs when that guard already found a sessionId, which in
   * practice means `addUserMessage` ran first).
   */
  private currentUserMessageId(): string {
    const messages = useAiStore.getState().messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return messages[i].id;
    }
    return `turn_${Date.now()}`;
  }

  abort(): void {
    this.agent.abort();
  }

  /** Seed the agent with a saved session's history so the next prompt continues it. */
  resume(messages: AiMessage[]): void {
    this.agent.setMessages(restoreAgentMessages(messages));
  }

  reset(): void {
    this.agent.reset();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribeTelemetry?.();
    this.agent.abort();
  }
}

// ---- Singleton access ----

export function getAgentService(): AgentService {
  const currentPath = getCurrentWorkspacePath();

  if (agentInstance && lastWorkspacePath !== currentPath) {
    agentInstance.dispose();
    agentInstance = null;
  }

  if (!agentInstance) {
    agentInstance = new AgentService();
    lastWorkspacePath = currentPath;
  }

  return agentInstance;
}

export function resetAgentService(): void {
  agentInstance?.dispose();
  agentInstance = null;
  lastWorkspacePath = null;
}
