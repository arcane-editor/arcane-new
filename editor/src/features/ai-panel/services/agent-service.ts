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
  resetCompileGate,
} from './unity-tools';
import { resetTurnTelemetry, recordTelemetryEvent } from './turn-telemetry';
import { useAiStore, type AiMessage } from '../../../stores/ai';
import { useAuthStore } from '../../../stores/auth';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useProjectContextStore } from '../../../stores/project-context';
import { useSettingsStore } from '../../../stores/settings';
import { buildSystemPrompt, defaultPromptModeFor, type PromptMode } from './prompts';
import { resolveAttachments } from './attachments';
import type { Model, AgentTool, AgentMessage } from './vendor/types';
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
    // system / permissionRequest are not part of LLM history — skip.
  }
  return out;
}

const PLACEHOLDER_MODEL: Model = { id: 'auto', name: 'auto', provider: 'arcane' };

function getCurrentWorkspacePath(): string {
  return useWorkspaceStore.getState().workspacePath ?? '/';
}

/**
 * ASK + PLAN-planning → read + list (no mutations).
 * AGENT and PLAN-execution → all five (read, list, write, edit, bash).
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
  const unityRead: AgentTool[] = isUnity ? createUnityReadTools() : [];

  if (mode === 'ask' || mode === 'plan-planning') {
    return [...readOnly, ...graphTools, ...unityRead];
  }

  const writeTool = createWriteTool(workspacePath, {
    operations: tauriWriteOperations,
    onFileWritten,
    allowedRoot,
  });
  const editTool = createEditTool(workspacePath, {
    operations: tauriEditOperations,
    onFileEdited,
    allowedRoot,
  });

  // Wrap .cs write/edit with the analyzer gate (instant, offline, regex) first,
  // then the compile gate (authoritative, online) on the OUTSIDE so it runs last.
  const wrapCs = (t: AgentTool): AgentTool => {
    let g = analyzersOn ? withUnityAnalyzerGate(t, workspacePath) : t;
    if (compileGateOn) g = withUnityCompileGate(g, workspacePath);
    return g;
  };

  return [
    ...readOnly,
    ...graphTools,
    ...unityRead,
    ...(isUnity ? createUnityMutateTools() : []),
    wrapCs(writeTool),
    wrapCs(editTool),
    createBashTool(workspacePath, {
      operations: tauriBashOperations,
      allowedRoot,
    }),
  ];
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
      streamFn: arcaneStream,
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

    const promptMode: PromptMode = opts.promptMode ?? defaultPromptModeFor(opts.mode);
    this.syncForPromptMode(promptMode, opts.effort, opts.planExecution);
    this.agent.setReasoning(opts.effort);
    // Compaction budget: the real window of the model this tier maps to
    // (server model lineup is fixed; see TIER_CONTEXT_WINDOWS).
    this.agent.setContextWindow(TIER_CONTEXT_WINDOWS[opts.effort]);
    // Fresh compile-gate repair budget per user turn.
    resetCompileGate();
    resetTurnTelemetry();

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
