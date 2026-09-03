/**
 * Agent service — singleton that orchestrates the PI agent loop
 * with the UnityIDE server StreamFn and Tauri-backed tools.
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
import { createBashTool, BASH_TOOL_BUDGET_MS } from './vendor/tools/bash';
import { withRealPathGuard } from './vendor/tools/real-path-guard';
import { createListTool } from './vendor/tools/list';
import { createTodoTool } from './todo-tool';
import { createAskUserTool } from './ask-user-tool';
import {
  createGraphifyExplainTool,
  createGraphifyPathTool,
  createGraphifyQueryTool,
  createProjectSymbolsTool,
} from '../../graphify';
import { hostedStream } from './hosted-stream';
import {
  tauriReadOperations,
  tauriWriteOperations,
  tauriEditOperations,
  tauriBashOperations,
  tauriRealPathOperations,
  tauriListOperations,
  onFileWritten,
  onFileEdited,
} from './tool-operations';
import {
  createUnityReadTools,
  createUnityAssetMutateTools,
  createUnityMutateTools,
  withUnityAnalyzerGate,
  withUnityAssetGate,
  withUnityCompileGate,
  withLspDiagnosticsGate,
  resetCompileGate,
} from './unity-tools';
import { resolveToCwd } from './vendor/tools/path-utils';
import { withCheckpoint } from './checkpoints/checkpoint-gate';
import { withWriteApproval } from './write-approval-gate';
import { withResultDiffs } from './diff-decorator';
import { withEditReview } from './edit-review/edit-review-decorator';
import {
  withTurnGovernor,
  resetTurnGovernor,
  grantExtraCalls,
  wasCapReachedThisSend,
  softLimitNotice,
  capReachedNotice,
} from './turn-governor';
import { resolveSendEffort, resetSendEscalation } from './send-escalation';
import { withStreamErrorGuard } from './stream-error-guard';
import { withRepeatCallGuard, resetRepeatCallGuard } from './tool-guards';
import { computeAllowedRoots } from './sandbox-roots';
import {
  resetTurnTelemetry,
  recordTelemetryEvent,
  recordGroundingLintHit,
  recordEscalation,
  getPreviousSendNudgeCounts,
  getPreviousSendRepairCount,
  shouldNudgeTodoUpdate,
} from './turn-telemetry';
import {
  beginVerifiedPass,
  recordTouchedFile,
  touchedFileCount,
  touchedFileList,
  runVerifiedPass,
} from './verified-pass';
import { distillSend } from './memory/distiller';
import { maybeConsolidate } from './memory/consolidate';
import { createMemorySearchTool } from './memory/memory-tool';
import { primeMemory } from './memory/memory-cache';
import { sideTaskRequest } from './memory/memory-request';
import { tauriMemoryFs } from './memory/tauri-memory-fs';
import { useAiStore, type AiMessage } from '../../../stores/ai';
import { useAuthStore } from '../../../stores/auth';
import {
  useServerConfigStore,
  effectiveContextWindow,
  maxAllowedEffort,
  turnCapsFromConfig,
} from '../../../stores/server-config';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useProjectContextStore } from '../../../stores/project-context';
import { useSettingsStore } from '../../../stores/settings';
import { useCheckpointsStore } from '../../../stores/checkpoints';
import { buildSystemPrompt, captureDecoration, defaultPromptModeFor, type PromptMode } from './prompts';
import { graphChangedSinceFreeze, resetFrozenDecoration } from './prompts/frozen-context';
import { buildPlanSendPrefix } from './prompts/plan-execution';
import { setSendPromptMode } from './send-context';
import { includesTodoTool, nudgeEligible } from './todo-gates';
import { getUnityGroundingContext } from './prompts/unity-facts';
import type { ContrastFacts } from './prompts/unity-contrast';
import { lintAnswer, buildReviseMessage } from './grounding-lint';
import { resolveAttachments } from './attachments';
import { classifyTurnError, detectTurnOutcome, loopCrashError } from './turn-errors';
import type { Model, AgentTool, AgentMessage, TextContent } from './vendor/types';
import type { Attachment, ChatMode, Effort } from './types';

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
    // system / permissionRequest / questionRequest / verifiedPass / error /
    // stopped are not part of LLM history — skip. (`ask_user`'s answer is
    // already the tool call's own `toolResult`, which the branch above
    // restores; the questionRequest message is UI-only, same as
    // permissionRequest. `stopped` (T4) is a UI-only marker for a user Stop —
    // resuming re-sends fresh text, it never replays as if the model said it.)
  }
  return out;
}

const PLACEHOLDER_MODEL: Model = { id: 'auto', name: 'auto', provider: 'hosted' };

/**
 * T9 Part 4: cheap harness nudge, prepended to the outgoing prompt text (same
 * mechanism as the attachment prefix below) when `shouldNudgeTodoUpdate`
 * fires for the previous send. No extra model call — this only shapes what
 * the model reads in its own next turn.
 */
const TODO_NUDGE_TEXT = '[Reminder: maintain your todo list with todo_update for multi-step work.]\n\n';

function getCurrentWorkspacePath(): string {
  return useWorkspaceStore.getState().workspacePath ?? '/';
}

/**
 * ASK → read + list only (no mutations, and no `ask_user` — plain chat is
 * already Q&A, per the ask_user design spec's out-of-scope list).
 * PLAN-planning → read + list, plus `ask_user` (in-loop question tool):
 * still no mutations, but planning benefits from clarifying ambiguous
 * requirements with the user before committing to a plan.
 * AGENT and PLAN-execution → all five (read, list, write, edit, bash), plus
 * `todo_update` (P3.5's in-loop todo tool) and `ask_user` — mutating modes
 * only, since a read-only conversation has no multi-step work to track and
 * (for `ask_user`) plain chat already lets the user drive interactively.
 * `ask_user` itself never mutates anything, so it's wrapped by
 * `withRepeatCallGuard` only (no checkpoint/diffs/approval) in every mode
 * that registers it.
 *
 * Graphify tools (query, explain, path) are read-only and join every mode
 * when a graph has been built for the workspace.
 *
 * PREPLANNING (Task 11) → read + list + graph + memory + unityRead, plus
 * `ask_user` and `todo_update` — the same read-only set as plan-planning,
 * because its one required final action IS a `todo_update` call.
 *
 * `effort` only matters for 'agent': `includesTodoTool` (todo-gates.ts)
 * excludes `todo_update` at 'low' (Standard has no todo machinery,
 * guaranteed) and includes it at every other tier/mode combo.
 */
function createToolsForPromptMode(mode: PromptMode, workspacePath: string, effort: Effort): AgentTool[] {
  const isUnity = useProjectContextStore.getState().isUnityProject;
  // Sandbox roots per workspace shape — see sandbox-roots.ts. Unity confines
  // file operations to Assets/ (+ .unityide/ plan files + Packages/ for
  // manifest.json, which the agent prompt allows after confirming); non-Unity
  // workspaces confine to the workspace itself (they used to get NO sandbox);
  // no workspace open denies file tools entirely.
  const allowedRoot = computeAllowedRoots(
    workspacePath,
    isUnity,
    isUnity ? (useWorkspaceStore.getState().assetsRootPath ?? null) : null,
  );

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

  // Always registered regardless of graph status (cache activation §1): the
  // tool set is part of the provider's cached prompt prefix, so it must not
  // change when a graph gets built mid-session. The tools themselves answer
  // with guidance when no graph exists (see graphify-tools.ts).
  const graphTools: AgentTool[] = [
    createGraphifyQueryTool(workspacePath),
    createGraphifyExplainTool(workspacePath),
    createGraphifyPathTool(workspacePath),
    createProjectSymbolsTool(workspacePath),
  ];

  // Per-project memory recall (spec §4) — read-only, all modes, always
  // registered (stable tool set; answers plainly when the store is empty).
  const memoryTools: AgentTool[] = [createMemorySearchTool(workspacePath)];

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
  // Asset gate: the same write-feedback loop for the four Unity formats the
  // analyzers never covered (.uxml/.uss/.inputactions/.asset). Default-on; the
  // gate itself early-returns on every other extension, including .cs.
  const assetGateOn =
    isUnity && settings.getSetting('unity.assetGate.enabled') !== false;
  const unityRead: AgentTool[] = isUnity ? createUnityReadTools(workspacePath) : [];

  if (mode === 'ask') {
    return [...readOnly, ...graphTools, ...memoryTools, ...unityRead].map((t) => withRepeatCallGuard(t, workspacePath));
  }

  if (mode === 'plan-planning') {
    return [...readOnly, ...graphTools, ...memoryTools, ...unityRead, createAskUserTool()].map((t) => withRepeatCallGuard(t, workspacePath));
  }

  if (mode === 'preplanning') {
    return [
      ...readOnly,
      ...graphTools,
      ...memoryTools,
      ...unityRead,
      createAskUserTool(),
      createTodoTool(),
    ].map((t) => withRepeatCallGuard(t, workspacePath));
  }

  // Verified-pass (P3.4) registers every file the send touches by composing
  // onto the existing onFileWritten/onFileEdited hooks — the vendor write/edit
  // tools themselves are untouched.
  // `timeoutMs: Infinity` on write/edit: in manual apply-mode they block on
  // HUMAN approval (unbounded by design), and in auto mode every stage of
  // their gate stack is now individually bounded (compile-wait 90s cap, LSP
  // 4s, hints 8s) — so the loop's default budget would only ever fire
  // spuriously. Decorators spread `...tool`, so the field survives wrapping.
  const writeTool: AgentTool = {
    ...createWriteTool(workspacePath, {
      operations: tauriWriteOperations,
      onFileWritten: (path) => {
        recordTouchedFile(path);
        onFileWritten(path);
      },
      allowedRoot,
    }),
    timeoutMs: Number.POSITIVE_INFINITY,
  };
  const editTool: AgentTool = {
    ...createEditTool(workspacePath, {
      operations: tauriEditOperations,
      onFileEdited: (path) => {
        recordTouchedFile(path);
        onFileEdited(path);
      },
      allowedRoot,
    }),
    timeoutMs: Number.POSITIVE_INFINITY,
  };

  // Wrap .cs write/edit with the analyzer gate (instant, offline, regex) innermost,
  // then the LSP gate (csharp-ls, live but no engine needed), then the compile gate
  // (needs the Unity bridge) outermost, so the cheapest signal reaches the model first.
  //
  // `withUnityAssetGate` covers exactly the extensions the other three ignore
  // (.uxml/.uss/.inputactions/.asset), so the order between it and the cs-gates
  // is irrelevant — each early-returns on the other's files.
  const wrapCs = (t: AgentTool): AgentTool => {
    let g = assetGateOn ? withUnityAssetGate(t, workspacePath) : t;
    if (analyzersOn) g = withUnityAnalyzerGate(g, workspacePath);
    if (lspGateOn) g = withLspDiagnosticsGate(g, workspacePath);
    if (compileGateOn) g = withUnityCompileGate(g, workspacePath);
    return g;
  };

  // Checkpoints (P5.2): snapshot the pre-write content before delegating to the
  // raw write/edit tool, so a turn can be restored later. `allowedRoot` must
  // match the tools' own sandbox so out-of-root writes (which the tools
  // reject internally) don't record phantom snapshots.
  //
  // Pre-apply write approval (P5.3): `withWriteApproval` sits OUTSIDE the
  // checkpoint (prompt first; snapshot only for writes that actually proceed
  // — a rejected write returns before ever calling `withCheckpoint`, so no
  // snapshot is recorded and the raw tool's `onFileWritten`/`onFileEdited`
  // never fire either) but INSIDE the cs-gates (analyzer/lsp/compile — see
  // `write-approval-gate.ts`'s header for why those needed an explicit
  // `isRejectedWrite` early-out to stay inert on a rejected write, since they
  // always run and post-process whatever result comes back).
  //
  // Structured diffs (P5.1): `withResultDiffs` sits OUTSIDE the cs-gates (so
  // the diff it attaches reflects the FINAL result the gates have already
  // annotated) but stays INSIDE the repeat-call guard applied by the trailing
  // `.map((t) => withRepeatCallGuard(t, workspacePath))` below (so a suppressed repeat call never
  // triggers a redundant pair of diff reads).
  //
  // Edit review (T7): `withEditReview` sits OUTSIDE `withResultDiffs` — it
  // reads `result.diffs`, the field only `withResultDiffs` attaches, so
  // wrapping inside it would never see a populated result — and stays INSIDE
  // the repeat-call guard for the same "no redundant registration for a
  // suppressed repeat" reason `withResultDiffs` stays inside it. Full order,
  // outer → inner: guard(editReview(diffs(gates(withWriteApproval(checkpoint(tool)))))).
  // This order is required, not stylistic — see diff-decorator.ts's header
  // for why a gate hit silently drops `diffs` if a gate ever ends up outside
  // (wrapping) that decorator, and edit-review-decorator.ts's header for why
  // it must wrap outside `withResultDiffs` and inside the repeat-call guard.
  // Symlink containment. `resolveWithinRoot` inside each tool is LEXICAL, so a
  // symlink in Assets/ (a shared asset folder, a package under development —
  // both normal Unity workflows) passed it and was then followed straight out
  // of the project. This sits outside the whole gate stack so a refusal costs
  // no approval prompt, no checkpoint pre-image and no compile round.
  const guardRealPath = (t: AgentTool): AgentTool =>
    withRealPathGuard(t, workspacePath, { allowedRoot, ops: tauriRealPathOperations });

  return [
    ...readOnly.map(guardRealPath),
    ...graphTools,
    ...memoryTools,
    ...unityRead,
    ...(isUnity ? createUnityMutateTools() : []),
    // Unity asset writes. They declare a top-level `path`, which is the only
    // thing `withCheckpoint` and `withWriteApproval` key off — so "restore this
    // turn" and the `ai.edits.alwaysApproveUnityAssets` policy cover them with
    // no special case. The cs-gates are deliberately NOT applied: these tools
    // never touch `.cs`, and the asset gate would re-check a write the tool
    // already performed through a validating writer.
    ...(isUnity
      ? createUnityAssetMutateTools(workspacePath, {
          // The same two consumers the vendor write tool notifies: the verified
          // pass's touched-file registry, and the editor's open-buffer reload.
          onWrite: (path) => {
            const abs = resolveToCwd(path, workspacePath);
            recordTouchedFile(abs);
            onFileWritten(abs);
          },
        }).map((t) =>
          guardRealPath(
            withEditReview(
              withResultDiffs(
                withWriteApproval(withCheckpoint(t, workspacePath, { allowedRoot }), workspacePath, {
                  allowedRoot,
                }),
                workspacePath,
                { allowedRoot },
              ),
            ),
          ),
        )
      : []),
    guardRealPath(
      withEditReview(
        withResultDiffs(
          wrapCs(withWriteApproval(withCheckpoint(writeTool, workspacePath, { allowedRoot }), workspacePath, { allowedRoot })),
          workspacePath,
          { allowedRoot },
        ),
      ),
    ),
    guardRealPath(
      withEditReview(
        withResultDiffs(
          wrapCs(withWriteApproval(withCheckpoint(editTool, workspacePath, { allowedRoot }), workspacePath, { allowedRoot })),
          workspacePath,
          { allowedRoot },
        ),
      ),
    ),
    {
      // bash self-bounds each command (its own `timeout` param). The loop
      // budget is derived from that ceiling rather than restated here, so the
      // backend timeout always fires first — see bash.ts for why the ordering
      // matters.
      ...createBashTool(workspacePath, {
        operations: tauriBashOperations,
        allowedRoot,
        // bash bypasses every write-side guarantee (checkpoint, compile gate,
        // analyzer gate, verified pass). Record it so the turn's checkpoint row
        // can say what it cannot restore.
        onUncheckpointedChange: (command) =>
          useCheckpointsStore.getState().recordUncheckpointedChange(command),
      }),
      timeoutMs: BASH_TOOL_BUDGET_MS,
    },
    ...(includesTodoTool(mode, effort) ? [createTodoTool()] : []),
    createAskUserTool(),
  ].map((t) => withRepeatCallGuard(t, workspacePath));
}

let agentInstance: AgentService | null = null;
let lastWorkspacePath: string | null = null;

/**
 * The exact `(text, opts)` pair passed to the most recent `sendMessage` call
 * that got past the isRunning/auth guards (T5). `retry-turn.ts` reads this
 * via `getLastSend()` to replay a failed turn byte-identical to the
 * original call, without an import cycle — this module never imports
 * retry-turn.ts. Cleared in `dispose()` (New Chat / workspace switch), so a
 * retry attempted after a fresh conversation starts never resends stale
 * text into the new one.
 */
let lastSend: { text: string; opts: SendMessageOptions } | null = null;

/** See `lastSend` above. `null` before any send this process, or after a `dispose()` (New Chat / workspace switch). */
export function getLastSend(): { text: string; opts: SendMessageOptions } | null {
  return lastSend;
}

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
  /** Identifies this backend to `chat-backend.ts`'s `ChatBackend` contract. */
  readonly kind = 'hosted' as const;

  private agent: Agent;
  private unsubscribe: (() => void) | null = null;
  private unsubscribeTelemetry: (() => void) | null = null;
  /**
   * Set by `abort()`, read (and reset) by `sendMessage`'s outcome inspection
   * (T5): `detectTurnOutcome` needs to know a user-initiated abort happened
   * even when the vendor loop's own tail is `stopReason: 'toolUse'` (an
   * abort mid-tool-execution never gets a chance to reach `'aborted'`).
   */
  private abortRequested = false;
  /**
   * True for the FULL duration of a send — vendor loop AND post-loop
   * (grounding lint, verified pass) — unlike `agent.isRunning`, which only
   * covers the loop. `sendMessage` guards on both so sends serialize fully.
   */
  private sendInFlight = false;

  constructor() {
    const workspacePath = getCurrentWorkspacePath();

    this.agent = new Agent({
      systemPrompt: buildSystemPrompt('agent', workspacePath, { effort: 'mid' }),
      model: PLACEHOLDER_MODEL,
      tools: createToolsForPromptMode('agent', workspacePath, 'mid'),
      // The stream-error guard (T5) sits OUTERMOST so it catches a
      // synchronous throw from the governor as well as the innermost
      // `hostedStream` itself. (Mid-send tier escalation was removed — model
      // switches inside a send reset the provider's prompt cache; escalation
      // now happens at send boundaries, see send-escalation.ts.)
      // The config closure runs on every stream call (not just once at
      // construction), so a server-config cap change picked up mid-conversation
      // applies starting the next call — `getState()` always reads the current
      // snapshot. `onProgress` drives the working row's live count;
      // `onSoftLimit`/`onCapReached` push the same in-loop notices the module's
      // defaults would, wired explicitly so the store import lives here rather
      // than in `turn-governor.ts` (kept Bun-safe for the eval harness).
      streamFn: withStreamErrorGuard(withTurnGovernor(hostedStream, () => ({
        caps: turnCapsFromConfig(useServerConfigStore.getState().config),
        onProgress: (used, cap) => useAiStore.getState().setModelCallBudget({ used, cap }),
        onSoftLimit: (_effort, used, cap) => useAiStore.getState().addSystemMessage(softLimitNotice(used, cap)),
        onCapReached: (_effort, cap) => useAiStore.getState().addSystemMessage(capReachedNotice(cap)),
      }))),
      convertToLlm,
      reasoning: 'mid',
      // Server picks the model per reasoningLevel; default to the smallest tier's
      // window so no-LLM compaction triggers early enough for the weakest model.
      contextWindow: 32768,
    });

    // T5: a bug in handleAgentEvent (or anything it transitively touches)
    // must not take down the whole subscribe callback silently — surface it
    // as a banner (never a timeline block; this runs from inside an event
    // handler, not a send's own try/catch).
    this.unsubscribe = this.agent.subscribe((event) => {
      try {
        useAiStore.getState().handleAgentEvent(event);
      } catch (error) {
        console.error('Internal UI error while processing agent events:', error);
        useAiStore.getState().setError('Internal UI error while processing agent events.');
      }
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
        // Freeze the volatile decoration blocks per conversation so the
        // system prompt stays byte-identical across sends (prefix caching).
        conversationId: useAiStore.getState().sessionId,
      }),
    );

    this.agent.setTools(createToolsForPromptMode(promptMode, workspacePath, effort));
  }

  async sendMessage(text: string, opts: SendMessageOptions): Promise<void> {
    // Serialize whole SENDS, not just the vendor loop: `agent.isRunning`
    // goes false while turn A's post-loop (grounding lint / verified pass,
    // up to ~10s) is still running, and a quick follow-up send used to clear
    // `abortRequested` and reset the governor/telemetry UNDER turn A —
    // making a deliberate Stop post a spurious red error block. (Also still
    // guards callers like fixConsoleError() that bypass the composer's
    // in-flight guard.)
    if (this.agent.isRunning || this.sendInFlight) {
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

    // T5: fresh per-send abort tracking. AFTER the guards, so entering while
    // a prior send is mid-post-loop can never clear THAT send's abort flag.
    this.abortRequested = false;
    // T5: capture the exact send for retry-turn.ts's replay path. Set only
    // after the guards above so a rejected send (already running / signed
    // out) never clobbers a real in-flight send's replay target.
    lastSend = { text, opts };

    this.sendInFlight = true;
    try {
      await this.runSend(text, opts);
    } finally {
      this.sendInFlight = false;
      // Close the checkpoint turn opened in runSend — recordPreWrite calls
      // landing after this send (mid-turn settings flips, stragglers) must
      // not attach to it (see stores/checkpoints.ts's endTurn).
      useCheckpointsStore.getState().endTurn();
    }
  }

  private async runSend(text: string, opts: SendMessageOptions): Promise<void> {
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

    // Fresh per-send state FIRST: resetTurnTelemetry() snapshots the
    // previous send's repair count, which the escalation decision below
    // consumes — so the resets must precede it.
    resetCompileGate();
    resetTurnTelemetry();
    // Fresh turn-governor call budget + repeat-call guard registries per
    // send (P3.2) — both wrap streamFn/tools ONCE (constructor /
    // createToolsForPromptMode), so their per-send state needs an explicit
    // reset here, same as the compile gate above.
    resetTurnGovernor();
    resetRepeatCallGuard();
    // Fresh touched-file registry for the verified-pass closing check (P3.4).
    beginVerifiedPass();

    // Send-boundary escalation (spec §2): if the PREVIOUS send burned through
    // repeated compile/analyzer/LSP repairs, run this and every later send of
    // the conversation one tier up. Replaces the old mid-send escalation,
    // which switched models inside a send and reset the provider's prompt
    // cache for the whole conversation.
    const escalation = resolveSendEffort(
      useAiStore.getState().sessionId,
      opts.effort,
      getPreviousSendRepairCount(),
      () => useSettingsStore.getState().getSetting('ai.escalation.enabled') !== false,
      // Never escalate past the plan's entitlement — the server 403s a gated
      // tier and a latched over-entitlement escalation bricked the session.
      // Config-first (server-published `allowed` flags), falling back to the
      // offline plan ladder only before the first /v1/config lands.
      maxAllowedEffort(useServerConfigStore.getState().config, useAuthStore.getState().plan),
    );
    const effectiveEffort = escalation.effort;
    if (effectiveEffort !== opts.effort) {
      recordEscalation();
    }
    if (escalation.escalatedNow) {
      useAiStore
        .getState()
        .addSystemMessage(
          `Escalating to ${effectiveEffort} for this conversation after repeated compile repairs`,
        );
    }

    const promptMode: PromptMode = opts.promptMode ?? defaultPromptModeFor(opts.mode);
    // Report the plan-mode phase FACT to the stream layer (metadata.planPhase);
    // the server's routing layer owns every model decision.
    setSendPromptMode(promptMode);
    this.syncForPromptMode(promptMode, effectiveEffort, opts.planExecution);
    this.agent.setReasoning(effectiveEffort);
    // Compaction budget: the server-published per-tier minimum window
    // (config-first; TIER_CONTEXT_WINDOWS is only the offline fallback).
    this.agent.setContextWindow(
      effectiveContextWindow(useServerConfigStore.getState().config, effectiveEffort),
    );
    // T9: the todo list now lives for the whole session, not just this send —
    // no reset here (see `resetConversation`/`loadSessionIntoStore` in stores/ai.ts).

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

    // T9 Part 4: cheap harness nudge — agent/plan-execution only (ask and
    // plan-planning never call mutating tools, so there's nothing to nudge
    // about). Applied AFTER the attachment prefix above (not folded into the
    // same assignment) so it stacks with — rather than getting overwritten
    // by — an attachment prefix on the same send.
    //
    // Task 11: the proactive "todo-first" heuristic (auto-plan.ts) is gone —
    // preplanning (preplan-controller.ts) now runs a real read-only context
    // pass ahead of execution on tiers that have it, instead of guessing from
    // prompt-text heuristics. The retrospective nudge below is gated to
    // `nudgeEligible` (todo-gates.ts, `effort !== 'low'`): at 'low' the todo
    // tool isn't even registered (see `createToolsForPromptMode`), so
    // reminding the model to call it would be nonsensical.
    if ((promptMode === 'agent' || promptMode === 'plan-execution') && nudgeEligible(effectiveEffort)) {
      const prevCounts = getPreviousSendNudgeCounts();
      if (shouldNudgeTodoUpdate(prevCounts.mutatingCalls, prevCounts.todoUpdateCalls)) {
        promptText = TODO_NUDGE_TEXT + promptText;
      }
    }

    // Cache activation §1: the system-prompt decoration is frozen per
    // conversation (frozen-context.ts), so graph drift is surfaced at the
    // message TAIL instead — appending to the newest user message never
    // invalidates the provider's cached prefix, while editing the system
    // prompt would re-bill the whole conversation.
    if (
      graphChangedSinceFreeze(
        useAiStore.getState().sessionId,
        captureDecoration(effectiveEffort).graphSnapshot,
      )
    ) {
      promptText +=
        '\n\n[Note: the codebase graph changed since this conversation started — graphify_query reflects the current structure.]';
    }

    // Cache activation §1: the plan body moved OUT of the system prompt (see
    // prompts/plan-execution.ts) — inject it into the first plan-execution
    // user message of the conversation; later sends carry a one-line pointer.
    // "Already injected" is detected from the conversation itself so it
    // survives session resume across process restarts.
    if (promptMode === 'plan-execution' && opts.planExecution) {
      const { planPath, planContent } = opts.planExecution;
      const marker = `## Approved plan (${planPath})`;
      const alreadyInjected = this.agent.getMessages().some(
        (m) =>
          m.role === 'user' &&
          (typeof m.content === 'string'
            ? m.content.includes(marker)
            : Array.isArray(m.content) &&
              m.content.some((c) => c.type === 'text' && c.text.includes(marker))),
      );
      promptText = buildPlanSendPrefix(alreadyInjected, planPath, planContent) + promptText;
    }

    // T5 outcome-detection choke point: `before` marks where THIS send's own
    // messages start in the agent's history, so the outcome check below
    // (after the try/catch) only ever classifies the tail this call itself
    // produced — never an earlier turn's messages in a multi-turn
    // conversation.
    const before = this.agent.getMessages().length;

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
        // Memory distillation (spec §4): fire-and-forget on the cheap
        // side-task lane; a failure never surfaces as a send error.
        this.maybeDistillMemory(promptMode, text);
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'Agent is already running') {
        // Pre-send validation, not a turn that actually ran (see the
        // concurrent-entry comment above) — banner only, no turn error.
        useAiStore.getState().setError('Agent is already processing a message.');
        return;
      }
      // A genuine thrown error still means SOME of the turn ran — keep the
      // existing banner behavior AND surface an inline error block (T5), then
      // return so the outcome inspection below never ALSO fires for the same
      // failure (exactly one error block per failed send).
      const message = error instanceof Error ? error.message : 'An unexpected error occurred.';
      useAiStore.getState().setError(message);
      useAiStore.getState().addTurnError(classifyTurnError(message));
      return;
    }

    // T4: `detectTurnOutcome`'s own rule 0 checks `abortRequested` FIRST, ahead
    // of everything else — so it always reports 'aborted' for a user-initiated
    // Stop no matter what shape the tail is left in (a deliberate Stop
    // mid-stream can leave an 'error' tail: the aborted fetch rejects
    // `reader.read()`, so `hosted-stream.ts` pushes an error event rather than
    // a clean 'aborted' done; a Stop mid-tool-execution can leave a 'toolUse'
    // tail, or even no assistant message at all). That means this call no
    // longer needs a caller-side `if (!this.abortRequested)` guard — the
    // outcome detector itself is now the single source of truth for "was this
    // aborted", so it always runs, and its result is always the right one to
    // act on.
    const outcome = detectTurnOutcome(this.agent.getMessages().slice(before), this.abortRequested);
    if (outcome.type === 'error') {
      useAiStore.getState().addTurnError(classifyTurnError(outcome.raw));
    } else if (outcome.type === 'crash') {
      useAiStore.getState().addTurnError(loopCrashError());
    } else if (outcome.type === 'aborted') {
      useAiStore.getState().addStoppedMarker({ promptMode });
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
    // A user Stop can leave an 'error'/'toolUse' tail instead of 'aborted'
    // (an abort mid-tool never reaches 'aborted'), so the stopReason check
    // below misses it — and this method then fired a fresh BILLED revise
    // turn on a brand-new AbortController for a cancelled send. Same guard
    // maybeDistillMemory already has.
    if (this.abortRequested) return;
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
    // Same Stop guard as runGroundingLint: a cancelled send must not trigger
    // a live Unity recompile and a "Verified" card.
    if (this.abortRequested) return;
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
   * Memory distillation gate + kickoff (spec §4). Only after sends that did
   * real mutating work, only when enabled, never for the placeholder
   * workspace, never after an abort. Runs detached — errors are swallowed
   * inside distillSend.
   */
  private maybeDistillMemory(promptMode: PromptMode, userPrompt: string): void {
    if (promptMode !== 'agent' && promptMode !== 'plan-execution') return;
    if (this.abortRequested) return;
    if (touchedFileCount() === 0) return;
    if (useSettingsStore.getState().getSetting('ai.memory.enabled') === false) return;
    const workspacePath = getCurrentWorkspacePath();
    if (workspacePath === '/') return;

    const lastAssistant = [...this.agent.getMessages()].reverse().find((m) => m.role === 'assistant');
    const finalAssistantText =
      lastAssistant && lastAssistant.role === 'assistant'
        ? lastAssistant.content
            .filter((c): c is TextContent => c.type === 'text')
            .map((c) => c.text)
            .join('\n')
        : '';

    void distillSend(
      { userPrompt, finalAssistantText, touchedFiles: touchedFileList() },
      { request: sideTaskRequest, fs: tauriMemoryFs, workspacePath },
    )
      .then(() => maybeConsolidate({ fs: tauriMemoryFs, workspacePath, request: sideTaskRequest }))
      .then(() => primeMemory(workspacePath))
      .catch(() => {});
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
    this.abortRequested = true;
    this.agent.abort();
  }

  /**
   * Preplan-controller chain-guard (Task 11): true iff the USER stopped the
   * most recently COMPLETED `sendMessage` call. `abortRequested` is reset to
   * `false` at the top of every `sendMessage` (after its guards, T5) and only
   * ever set by `abort()`, so it survives exactly for the duration this needs
   * — from the end of a send until the next one starts.
   */
  wasLastSendAborted(): boolean {
    return this.abortRequested;
  }

  /**
   * True iff the turn governor's cap was reached on the most recently
   * completed send — i.e. the model's tools were disabled and it was asked
   * to wrap up rather than finishing on its own. Exposed on the
   * `PreplanAgentService` seam (Task 3) for callers that need to tell a
   * capped turn apart from a clean one, mirroring `wasLastSendAborted()`'s
   * lifecycle: `wasCapReachedThisSend()` is per-send state cleared by
   * `resetTurnGovernor()`, which every `sendMessage` call makes, so this
   * reads the just-finished send's outcome.
   */
  wasLastSendCapped(): boolean {
    return wasCapReachedThisSend();
  }

  /** Seed the agent with a saved session's history so the next prompt continues it. */
  resume(messages: AiMessage[]): void {
    this.agent.setMessages(restoreAgentMessages(messages));
    // T5 fix wave: a resumed session is a DIFFERENT conversation on the SAME
    // service instance (SessionHistory's openSession and session-restore both
    // rehydrate the store + resume() without a dispose()), so a stale
    // lastSend from the previous chat must never replay into it — in agent
    // mode that could trigger unintended writes against the wrong context.
    // dispose() covers New Chat / workspace switch; this covers resume.
    lastSend = null;
  }

  reset(): void {
    this.agent.reset();
    // A reset starts a fresh conversation — drop the frozen prompt blocks and
    // escalation latches so the next conversation starts from current state.
    resetFrozenDecoration();
    resetSendEscalation();
  }

  /**
   * Retry (T5): drop the last user prompt and everything after it from the
   * agent's OWN message history — distinct from the ai store's UI
   * `messages` (see `retry-turn.ts`'s header) — so a re-send doesn't leave
   * the failed attempt sitting in the LLM context alongside the replay.
   * No-op while a turn is running (nothing to rewind mid-stream, and the
   * caller's own `isAgentRunning` bail-out should prevent this anyway) or
   * when there's no user message to find (e.g. a resumed session cut off
   * before any prompt).
   */
  rewindToLastUserPrompt(): void {
    if (this.agent.isRunning) return;
    const msgs = this.agent.getMessages();
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') {
        this.agent.setMessages(msgs.slice(0, i));
        return;
      }
    }
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribeTelemetry?.();
    this.agent.abort();
    // Workspace switch / New Chat: frozen prompt blocks and escalation
    // latches belong to the old workspace's conversations — never reuse them.
    resetFrozenDecoration();
    resetSendEscalation();
    // T5: a disposed service (New Chat / workspace switch) starts the next
    // conversation with no replay target — a stale `lastSend` from the
    // conversation just torn down must never resend into the new one.
    lastSend = null;
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
