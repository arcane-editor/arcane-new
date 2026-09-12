import { Type } from '@sinclair/typebox';
import { Agent } from '../vendor/agent';
import { convertToLlm } from '../vendor/messages';
import type { AgentTool, AgentToolResult, StreamFn } from '../vendor/types';
import { SPECIALISTS, SPECIALIST_ROLES, specialistPrompt } from './definitions';
import { TaskRunContext, taskPathAllowed } from './task-context';
import type { EvidenceKind, SceneTarget, SpecialistRole, SpecialistTask, SpecialistResult, SpecialistRunnerDeps } from './contracts';

const text = (value: unknown, isError = false): AgentToolResult => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], ...(isError ? { isError: true } : {}) });
const MUTATIONS = new Set(['write', 'edit', 'unity_ui_write', 'unity_input_edit', 'unity_asset_edit', 'unity_fix_so_drift', 'unity_author']);
const ENGINE = new Set(['unity_author', 'unity_compile', 'unity_playtest', 'unity_verify_scene']);

export class SpecialistOrchestrator {
  private readonly agents = new Map<string, Agent>();
  private readonly tasks = new Map<string, SpecialistTask>();
  private readonly facts = new Map<string, string>();
  readonly results = new Map<string, SpecialistResult>();

  constructor(readonly task: TaskRunContext, private readonly deps: SpecialistRunnerDeps) {}

  restore(results: SpecialistResult[]): void {
    for (const result of results) {
      if (result.taskId !== this.task.id || !result.assignment) continue;
      this.results.set(result.id, result); this.tasks.set(result.id, result.assignment);
      if (result.status === 'completed') this.task.completed.add(result.id);
      if (result.history) {
        const agent = new Agent({ model: { id: 'auto', name: 'auto', provider: 'hosted' }, systemPrompt: specialistPrompt(result.role, this.deps.context(result.role)),
          tools: this.scopedTools(result.assignment), streamFn: this.stream(result.id, result.role), reasoning: this.deps.effort, contextWindow: this.deps.contextWindow, convertToLlm });
        agent.setMessages(result.history); this.agents.set(result.id, agent);
      }
    }
  }

  stream(id: string, role: SpecialistRole | 'coordinator'): StreamFn {
    const inner = this.deps.stream(id, role, (input, output) => {
      const usage = this.task.agentUsage(id); usage.input += input; usage.output += output;
    });
    return (context, options) => { this.task.takeCall(id); return inner(context, options); };
  }

  private scopedTools(assignment: SpecialistTask): AgentTool[] {
    const definition = SPECIALISTS[assignment.role];
    return this.deps.tools(assignment).filter((tool) => definition.tools.includes(tool.name)).map((tool) => ({
      ...tool,
      execute: async (id, args, signal, update) => {
        this.task.assertActive();
        const mutation = MUTATIONS.has(tool.name);
        const values = args as { path?: string; outputs?: string[]; scenePath?: string };
        if (mutation) {
          if (this.task.needsRepair) return text('Verification failed. The coordinator must begin a bounded repair round before further changes.', true);
          const paths = tool.name === 'unity_author' ? [...(values.outputs ?? []), values.scenePath ?? ''] : [values.path ?? ''];
          if (!paths.length || paths.some((p) => !taskPathAllowed(p, assignment.targets, this.task.workspacePath))) return text('Refused: output lies outside this specialist’s assigned targets.', true);
          if (assignment.role === 'gameplay-verification' && paths.some((p) => !/^Assets\/Tests\//.test(p))) return text('Verification specialists may write only test/probe files.', true);
          if (assignment.role !== 'gameplay-verification' && paths.some((p) => p.replace(this.task.workspacePath + '/', '').startsWith('Assets/Tests/'))) return text('Independent tests are outside implementation permissions.', true);
        }
        const action = async () => {
          this.task.assertActive();
          const result = await tool.execute(`${assignment.id}:${id}`, args, signal, update);
          return result;
        };
        return mutation || ENGINE.has(tool.name) ? this.task.exclusive(action) : action();
      },
    }));
  }

  async run(assignment: SpecialistTask): Promise<SpecialistResult> {
    this.task.assertActive();
    if (!this.task.criteria.length) throw new Error('Set acceptance criteria before delegating.');
    const previous = this.tasks.get(assignment.id);
    if (previous && (previous.role !== assignment.role || JSON.stringify(previous.targets) !== JSON.stringify(assignment.targets))) throw new Error('An existing specialist ID cannot change role or targets.');
    if (assignment.dependencies.some((d) => !this.task.completed.has(d))) throw new Error('Specialist dependencies are not completed.');
    if (!SPECIALISTS[assignment.role].readOnly && !assignment.targets.length) throw new Error('Assign explicit write targets.');
    if (assignment.role === 'level-design') this.task.requiresAuthoredLevel = true;
    if (!assignment.acceptanceCriteria.length) throw new Error('A specialist needs explicit acceptance criteria.');
    if (['level-design', 'ui-building', 'presentation'].includes(assignment.role)) {
      this.task.requirements.add('scene-persistence'); this.task.requirements.add('visual-review');
    }
    if (['gameplay', 'gameplay-verification', 'level-design', 'ui-building', 'presentation'].includes(assignment.role)) this.task.requirements.add('gameplay');
    this.tasks.set(assignment.id, assignment);
    this.task.completed.delete(assignment.id);
    const result: SpecialistResult = {
      id: assignment.id, role: assignment.role, objective: assignment.objective, status: 'running',
      summary: '', changedArtifacts: [], evidence: [], modelCalls: 0, inputTokens: 0, outputTokens: 0,
      assignment, taskId: this.task.id,
    };
    this.results.set(result.id, result);
    const publish = () => {
      const u = this.task.agentUsage(assignment.id);
      result.modelCalls = u.calls; result.inputTokens = u.input; result.outputTokens = u.output;
      this.deps.onProgress({ ...result });
    };
    publish();
    let agent = this.agents.get(assignment.id);
    if (!agent) {
      this.facts.set(assignment.id, this.deps.context(assignment.role));
      agent = new Agent({ model: { id: 'auto', name: 'auto', provider: 'hosted' },
        systemPrompt: specialistPrompt(assignment.role, this.facts.get(assignment.id)!),
        tools: this.scopedTools(assignment), streamFn: this.stream(assignment.id, assignment.role),
        reasoning: this.deps.effort, contextWindow: this.deps.contextWindow, convertToLlm });
      this.agents.set(assignment.id, agent);
    }
    const runningAgent = agent;
    const abort = () => runningAgent.abort();
    this.task.abort.signal.addEventListener('abort', abort, { once: true });
    const unsubscribe = agent.subscribe((event) => {
      this.deps.onEvent?.(assignment.id, event);
      if (event.type === 'tool_execution_start') { result.activity = event.toolName; publish(); }
      if (event.type === 'message_end') { result.history = agent.getMessages(); publish(); }
    });
    const before = this.task.revision;
    try {
      const currentFacts = this.deps.context(assignment.role);
      const factsUpdate = currentFacts !== this.facts.get(assignment.id) ? currentFacts : undefined;
      this.facts.set(assignment.id, currentFacts);
      await agent.prompt(JSON.stringify({ assignment, originalAcceptance: this.task.criteria, revision: this.task.revision,
        originalRequest: assignment.role === 'independent-review' || assignment.role === 'gameplay-verification' ? this.task.originalRequest : undefined,
        changedProjectFacts: factsUpdate,
        dependencyResults: assignment.dependencies.map((id) => { const r = this.results.get(id); return r && { id: r.id, summary: r.summary, changedArtifacts: r.changedArtifacts, evidence: r.evidence }; }), evidence: this.task.requiredResults() }));
      const last = [...agent.getMessages()].reverse().find((m) => m.role === 'assistant');
      result.summary = last?.role === 'assistant' ? last.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') : 'No handoff returned.';
      result.status = this.task.abort.signal.aborted ? 'cancelled' : last?.role === 'assistant' && last.stopReason === 'stop' ? 'completed' : 'failed';
      if (result.status === 'completed') this.task.completed.add(assignment.id);
    } catch (error) {
      result.status = this.task.abort.signal.aborted ? 'cancelled' : 'failed';
      result.summary = String(error);
    } finally {
      unsubscribe(); this.task.abort.signal.removeEventListener('abort', abort);
      result.changedArtifacts = [...this.task.changedAt].filter(([, revision]) => revision > before).map(([path]) => path);
      result.evidence = this.task.requiredResults();
      result.history = agent.getMessages(); result.activity = undefined; publish();
    }
    return result;
  }

  tools(): AgentTool[] {
    return [
      { name: 'set_acceptance', label: 'set acceptance criteria', description: 'Declare original task outcomes and required evidence before delegating. Cannot weaken criteria after work starts.',
        parameters: Type.Object({ criteria: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }), required: Type.Array(Type.Union(['compile', 'scene-persistence', 'gameplay', 'visual-review', 'review'].map((v) => Type.Literal(v))), { minItems: 1 }),
          scenes: Type.Optional(Type.Array(Type.Object({ scenePath: Type.String({ pattern: '^Assets/[^\\\\]+$', minLength: 8 }), root: Type.String({ minLength: 1 }), requireRepresentativeLevel: Type.Boolean() }), { maxItems: 32 })) }),
        execute: async (_id, raw) => {
          if (this.task.criteria.length) return text('Acceptance is already fixed for this task.', true);
          const args = raw as { criteria: string[]; required: EvidenceKind[]; scenes?: SceneTarget[] };
          this.task.criteria.push(...args.criteria); args.required.forEach((k) => this.task.requirements.add(k));
          (args.scenes ?? []).forEach((target) => this.task.requireScene(target));
          this.task.requirements.add('compile'); this.task.requirements.add('review');
          this.task.onChange();
          return text({ criteria: this.task.criteria, required: [...this.task.requirements], scenes: [...this.task.requiredScenes.values()] });
        } },
      { name: 'delegate_tasks', label: 'run specialists', timeoutMs: Number.POSITIVE_INFINITY,
        description: 'Execute focused specialist assignments. Dependencies must be completed. Up to two read-only reviews may run together; all writers run sequentially. Reuse an ID to continue its private history.',
        parameters: Type.Object({ tasks: Type.Array(Type.Object({ id: Type.String({ pattern: '^[A-Za-z0-9_-]{1,48}$' }), role: Type.Union(SPECIALIST_ROLES.map((r) => Type.Literal(r))), objective: Type.String({ minLength: 1, maxLength: 8000 }), targets: Type.Array(Type.String({ maxLength: 512 }), { maxItems: 32 }), dependencies: Type.Array(Type.String(), { maxItems: 12 }), acceptanceCriteria: Type.Array(Type.String({ maxLength: 2000 }), { minItems: 1, maxItems: 32 }) }), { minItems: 1, maxItems: 12 }) }),
        execute: async (_id, raw, signal) => {
          const abort = () => this.task.abort.abort();
          if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
          try {
            const { tasks } = raw as { tasks: SpecialistTask[] };
            if (new Set(tasks.map((t) => t.id)).size !== tasks.length) return text('Duplicate specialist IDs in one batch.', true);
            const results: SpecialistResult[] = [];
            for (let i = 0; i < tasks.length;) {
              const current = tasks[i]; const next = tasks[i + 1];
              if (SPECIALISTS[current.role].readOnly && next && SPECIALISTS[next.role].readOnly && !next.dependencies.includes(current.id)) {
                results.push(...await Promise.all([this.run(current), this.run(next)])); i += 2;
              } else { results.push(await this.run(current)); i++; }
            }
            return text(results.map(({ history: _history, ...r }) => r));
          } finally { signal?.removeEventListener('abort', abort); }
        } },
      { name: 'verification_status', label: 'verification evidence', description: 'Get current evidence. Old evidence is invalid after a mutation.', parameters: Type.Object({}),
        execute: async () => text({ revision: this.task.revision, canFinish: this.task.canFinish(), results: this.task.requiredResults(), repairCycles: this.task.repairCycles }) },
      { name: 'begin_repair', label: 'begin repair cycle', description: 'Begin one repair round for all observed failures. Five total; stops after two rounds without progress.', parameters: Type.Object({}),
        execute: async () => {
          const failures = this.task.requiredResults().filter((e) => e.status !== 'passed').map((e) => `${e.kind}:${e.status}:${e.summary}`).sort();
          return text({ allowed: failures.length > 0 && this.task.beginRepair(), cycle: this.task.repairCycles, failures });
        } },
    ];
  }
}
