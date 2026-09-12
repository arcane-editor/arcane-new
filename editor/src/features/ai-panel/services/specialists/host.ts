import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Agent } from '../vendor/agent';
import { convertToLlm } from '../vendor/messages';
import type { AgentMessage, AgentTool, ImageContent } from '../vendor/types';
import { createHostedStreamFn } from '../hosted-stream';
import { createTurnTelemetry } from '../turn-telemetry';
import { createRepeatCallGuard } from '../tool-guards';
import { createToolsForPromptMode } from '../agent-service';
import { captureDecoration } from '../prompts';
import { createAskUserTool } from '../ask-user-tool';
import { createTodoTool } from '../todo-tool';
import { useAiStore } from '../../../../stores/ai';
import { useUnityStore } from '../../../../stores/unity';
import { useCheckpointsStore } from '../../../../stores/checkpoints';
import { useWorkspaceStore } from '../../../../stores/workspace';
import { useSettingsStore } from '../../../../stores/settings';
import { requestEngineApproval } from '../approval-gate';
import { bridgeRpc, triggerRecompileAndWait } from '../../../unity-bridge';
import { tauriRealPathOperations } from '../tool-operations';
import { resolveToCwd } from '../vendor/tools/path-utils';
import { assertWithinRootReal } from '../vendor/tools/real-path-guard';
import { runVerifiedPass } from '../verified-pass';
import { COORDINATOR_PROMPT } from './definitions';
import { TaskRunContext } from './task-context';
import { SpecialistOrchestrator } from './orchestrator';
import { createAutomationTools, type AutomationDeps } from './automation-tools';
import { createPlanProgressTool } from './plan-progress-tool';
import type { SpecialistResult } from './contracts';
import type { Effort } from '../types';

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Cancelled')); return; }
    const abort = () => { clearTimeout(timer); reject(new Error('Cancelled')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export function productionAutomationDeps(task: TaskRunContext): AutomationDeps {
  return {
    protocol: () => useUnityStore.getState().bridgeProtocol ?? 0,
    compile: async (signal) => {
      const result = await triggerRecompileAndWait({ signal, force: true, timeoutMs: 120_000 });
      // A compile report may precede the bridge's reload/reconnect.
      const until = Date.now() + 30_000;
      while (!useUnityStore.getState().connected && Date.now() < until) await wait(250, signal);
      return result;
    },
    checkpoint: async (paths, id) => {
      const hashes: Record<string, string | null> = {};
      for (const path of paths) {
        const absolute = resolveToCwd(path, task.workspacePath);
        // The bridge also rejects symlinks. Checkpoint reads must not follow one
        // before that guard has a chance to run.
        await assertWithinRootReal(absolute, task.workspacePath + '/Assets', tauriRealPathOperations);
        if (useWorkspaceStore.getState().openFiles.some((f) => f.path === absolute && f.isDirty)) throw new Error(`Unsaved editor buffer: ${path}`);
        const exists = await tauriRealPathOperations.exists(absolute);
        const bytes = exists ? await invoke<number[]>('read_file_bytes', { path: absolute }) : null;
        hashes[path] = bytes ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase() : null;
        let binary = '';
        if (bytes) for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.slice(offset, offset + 8192));
        useCheckpointsStore.getState().recordPreWrite(absolute, bytes ? btoa(binary) : null, id, 'base64');
      }
      await useCheckpointsStore.getState().flushCheckpointsNow();
      return hashes;
    },
    author: bridgeRpc.author,
    authorStatus: bridgeRpc.authorStatus, verifyScene: (path, root, requireRepresentativeLevel) => bridgeRpc.verifyScene(path, requireRepresentativeLevel, root),
    play: (id, scenario) => bridgeRpc.startPlaytest(id, scenario, task.id), status: bridgeRpc.playtestStatus, cancel: bridgeRpc.cancelPlaytest, wait,
    reconcile: async () => {
      // Coding and planning remain useful while Unity is closed or an older
      // bridge is installed. Automation tools still reject verification, so a
      // task cannot claim completion without current live evidence.
      if ((useUnityStore.getState().bridgeProtocol ?? 0) < 6) return;
      const state = await bridgeRpc.automationState();
      if (state.activePlaytest) {
        if (state.taskId !== task.id) throw new Error('Another task owns the active Unity playtest. Resume after it finishes.');
        let report = await bridgeRpc.cancelPlaytest(state.activePlaytest);
        const until = Date.now() + 30_000;
        while (report.cleanupComplete === false && Date.now() < until) { await wait(250); report = await bridgeRpc.playtestStatus(state.activePlaytest); }
        if (report.cleanupComplete !== true) throw new Error('Unity playtest cleanup is still pending. Resume after Unity returns to Edit Mode.');
      }
      if (useUnityStore.getState().playState !== 'Stopped') throw new Error('Exit user-owned Play Mode before resuming authoring.');
    },
  };
}

export async function runSpecialistHarness(args: {
  text: string; images: ImageContent[]; messages: AgentMessage[];
  workspacePath: string; sessionId: string; taskId: string; effort: Effort; maxCalls: number; contextWindow: number;
  planExecution?: { planPath: string };
  onContext: (task: TaskRunContext | null) => void;
}): Promise<AgentMessage[]> {
  const previous = [...useAiStore.getState().messages].reverse().find((m) => m.specialistTask?.status === 'interrupted' && m.specialistTask.workspacePath === args.workspacePath);
  const task = previous?.specialistTask ? TaskRunContext.restore(previous.specialistTask) : new TaskRunContext(args.taskId, args.workspacePath, args.maxCalls);
  if (!previous) task.originalRequest = args.text;
  args.onContext(task);
  const deps = productionAutomationDeps(task);
  const taskMessageId = previous?.id ?? useAiStore.getState().addSystemMessage('Specialist task');
  const persist = (status: 'running' | 'completed' | 'stopped') => {
    useAiStore.setState((s) => ({ messages: s.messages.map((m) => m.id === taskMessageId ? { ...m, specialistTask: task.snapshot(status) } : m) }));
    void useAiStore.getState().flushSessionNow();
  };
  task.onChange = () => persist('running');
  persist('running');
  const blocks = captureDecoration(args.effort);
  const facts = [blocks.factsBlock, blocks.contextPack, blocks.graphSnapshot].filter(Boolean).join('\n\n');
  const activityIds = new Map<string, string>();
  const telemetryByAgent = new Map<string, ReturnType<typeof createTurnTelemetry>>();
  const telemetryFor = (id: string) => {
    let telemetry = telemetryByAgent.get(id);
    if (!telemetry) { telemetry = createTurnTelemetry(); telemetryByAgent.set(id, telemetry); }
    return telemetry;
  };
  const onProgress = (result: SpecialistResult) => {
    let id = activityIds.get(result.id);
    if (!id) { id = useAiStore.getState().addSystemMessage(result.objective); activityIds.set(result.id, id); }
    useAiStore.setState((s) => ({ messages: s.messages.map((m) => m.id === id ? { ...m, specialistRun: result } : m) }));
    void useAiStore.getState().flushSessionNow();
  };
  const orchestrator = new SpecialistOrchestrator(task, {
    effort: args.effort, contextWindow: args.contextWindow,
    context: (role) => {
      const selected = captureDecoration(args.effort, { forceSubsystems: role === 'ui-building' ? ['uiToolkit'] : role === 'gameplay' || role === 'gameplay-verification' ? ['input'] : [] });
      return role === 'ui-building' ? selected.factsBlock ?? '' : [selected.factsBlock, selected.contextPack].filter(Boolean).join('\n\n');
    }, onProgress, onEvent: (id, event) => telemetryFor(id).recordTelemetryEvent(event),
    stream: (id, _role, onUsage) => {
      const telemetry = telemetryFor(id);
      const stream = createHostedStreamFn({ execution: { sessionId: `${args.sessionId}:${id}`, mode: 'agent', planPhase: 'executing', onUsage, nextTelemetry: telemetry.nextTurnTelemetry } });
      return (context, options) => {
        useAiStore.getState().setModelCallBudget({ used: task.calls, cap: task.maxCalls });
        return stream(context, options);
      };
    },
    tools: (assignment) => {
      const telemetry = telemetryFor(assignment.id);
      const guard = createRepeatCallGuard(telemetry.recordLoopGuardHit);
      let guardRevision = task.revision;
      const existing = createToolsForPromptMode('agent', args.workspacePath, args.effort, {
        withRepeatCallGuard: guard.withRepeatCallGuard,
        recordTouchedFile: (path) => task.changed(path),
      });
      return [...existing, ...createAutomationTools(task, assignment.role, deps)].map((tool): AgentTool => ({
        ...tool,
        execute: async (id, params, signal, update) => {
          if (guardRevision !== task.revision) { guard.resetRepeatCallGuard(); guardRevision = task.revision; }
          if (tool.name === 'unity_author' && useSettingsStore.getState().getSetting('ai.edits.applyMode') === 'approve') {
            const allowed = await requestEngineApproval(id, tool.name, `Author declared Unity content: ${JSON.stringify(params)}`, signal ?? task.abort.signal);
            if (allowed !== 'approve') return { isError: true, content: [{ type: 'text', text: 'Authoring rejected; no outputs changed.' }] };
          }
          if (['write', 'edit', 'unity_ui_write', 'unity_input_edit', 'unity_asset_edit', 'unity_fix_so_drift'].includes(tool.name)) {
            const path = resolveToCwd((params as { path: string }).path, args.workspacePath);
            await assertWithinRootReal(path, assignment.targets.map((p) => resolveToCwd(p, args.workspacePath)), tauriRealPathOperations);
            if (useUnityStore.getState().playState !== 'Stopped') throw new Error('Writes are paused during Play Mode.');
            while (useUnityStore.getState().isCompiling) { await wait(250, signal); task.assertActive(); }
          }
          return tool.execute(id, params, signal ?? task.abort.signal, update);
        },
      }));
    },
  });
  if (previous) orchestrator.restore(useAiStore.getState().messages.flatMap((m) => m.specialistRun ? [m.specialistRun] : []));
  const reads = createToolsForPromptMode('ask', args.workspacePath, args.effort, { recordTouchedFile: () => {}, withRepeatCallGuard: createRepeatCallGuard(() => {}).withRepeatCallGuard });
  const engine = createAutomationTools(task, 'coordinator', deps).filter((t) => t.name === 'unity_compile' || t.name.endsWith('_status')).map((tool): AgentTool => ({
    ...tool, execute: (id, params, signal, update) => task.exclusive(() => tool.execute(id, params, signal, update)),
  }));
  const planProgress = args.planExecution ? [createPlanProgressTool({
    workspacePath: args.workspacePath,
    planPath: args.planExecution.planPath,
    assertAllowed: (path) => assertWithinRootReal(
      path,
      `${args.workspacePath.replace(/[\\/]+$/, '')}/.unityide/plans`,
      tauriRealPathOperations,
    ),
    read: (path) => invoke<string>('read_file', { path }),
    writeIfUnchanged: (path, content, expectedContent) =>
      invoke<boolean>('write_file_if_unchanged', { path, contents: content, expectedContent }),
    isDirty: (path) => {
      const normalized = path.replace(/\\/g, '/').toLowerCase();
      return useWorkspaceStore.getState().openFiles.some(
        (file) => file.path.replace(/\\/g, '/').toLowerCase() === normalized && file.isDirty,
      );
    },
    onWritten: (path) => useWorkspaceStore.getState().reloadFileFromDisk(path, { skipIfDirty: true }),
  })] : [];
  const coordinator = new Agent({ model: { id: 'auto', name: 'auto', provider: 'hosted' }, reasoning: args.effort, contextWindow: args.contextWindow,
    systemPrompt: `${COORDINATOR_PROMPT}\n\n${facts}`, tools: [...reads, ...orchestrator.tools(), ...engine, ...planProgress, createAskUserTool(), createTodoTool()], streamFn: orchestrator.stream('coordinator', 'coordinator'), convertToLlm });
  coordinator.setMessages(args.messages);
  const unsubscribe = coordinator.subscribe((event) => {
    telemetryFor('coordinator').recordTelemetryEvent(event);
    useAiStore.getState().handleAgentEvent(event);
  });
  const abort = () => coordinator.abort(); task.abort.signal.addEventListener('abort', abort, { once: true });
  let unlistenFiles: (() => void) | undefined;
  let unlistenIndex: (() => void) | undefined;
  try {
    await task.exclusive(() => deps.reconcile!());
    const invalidatePaths = (paths: string[]) => {
      const workspace = args.workspacePath.replace(/\\/g, '/').replace(/\/$/, '');
      for (const path of paths) {
        const normalized = path.replace(/\\/g, '/');
        if (['Assets', 'ProjectSettings', 'Packages'].some((dir) => normalized.startsWith(`${workspace}/${dir}/`))) task.changed(path);
      }
    };
    unlistenFiles = await listen<string[]>('file-content-changed', ({ payload }) => invalidatePaths(payload));
    unlistenIndex = await listen<{ added: string[]; removed: string[] }>('file-index-changed', ({ payload }) => invalidatePaths([...payload.added, ...payload.removed]));
    if (previous) args.text = `Resuming interrupted task ${task.id}. Previous evidence is stale and Unity state was reconciled. Keep original acceptance and remaining shared budget.\n\n${args.text}`;
    await coordinator.promptStructured([{ type: 'text', text: args.text }, ...args.images]);
    while (!task.abort.signal.aborted && !task.canFinish()) {
      const missing = task.requiredResults().filter((e) => e.status !== 'passed');
      if (!task.beginRepair()) break;
      await coordinator.prompt(`Required verification is incomplete. Repair round ${task.repairCycles} has already begun. Complete the missing work without weakening acceptance. Current evidence: ${JSON.stringify(missing)}`);
    }
    if (!task.abort.signal.aborted) {
      const card = await runVerifiedPass(args.workspacePath, undefined, { touchedFiles: [...task.touchedFiles].map((p) => resolveToCwd(p, args.workspacePath)), skipCompile: true });
      const compile = task.requiredResults().find((e) => e.kind === 'compile');
      useAiStore.getState().addVerifiedPassMessage({ ...card, compile: compile?.status === 'passed' ? 'clean' : 'skipped', requiredEvidence: task.requiredResults() });
      if (!task.canFinish()) useAiStore.getState().addSystemMessage('Task is not verified. Required evidence is missing, unsupported, or failed. See the verification results.');
    }
    return coordinator.getMessages();
  } finally {
    unlistenFiles?.(); unlistenIndex?.(); persist(task.canFinish() ? 'completed' : 'stopped');
    task.onChange = () => {}; unsubscribe(); task.abort.signal.removeEventListener('abort', abort); args.onContext(null);
  }
}
