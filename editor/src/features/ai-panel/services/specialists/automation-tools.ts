import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '../vendor/types';
import type { AuthoringOperation, AutomationReport, GameplayScenario } from '../../../../types/automation';
import type { CompileWaitOutcome } from '../../../unity-bridge';
import type { TaskRunContext } from './task-context';
import type { EvidenceKind, SceneTarget, SpecialistRole } from './contracts';

export interface AutomationDeps {
  protocol: () => number;
  compile: (signal?: AbortSignal) => Promise<CompileWaitOutcome>;
  checkpoint: (paths: string[], id: string) => Promise<void | Record<string, string | null>>;
  author: (operation: AuthoringOperation) => Promise<AutomationReport>;
  authorStatus: (id: string) => Promise<AutomationReport>;
  verifyScene: (path: string, root: string, requireRepresentativeLevel: boolean) => Promise<AutomationReport>;
  play: (id: string, scenario: GameplayScenario) => Promise<AutomationReport>;
  status: (id: string, captures?: boolean) => Promise<AutomationReport>;
  cancel: (id: string) => Promise<AutomationReport>;
  wait: (ms: number, signal?: AbortSignal) => Promise<void>;
  reconcile?: () => Promise<void>;
}
const txt = (value: unknown, isError = false): AgentToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }], isError });
const vector = Type.Object({ x: Type.Number(), y: Type.Number(), z: Type.Number() });
const path = Type.String({ pattern: '^Assets/[^\\\\]+$', minLength: 8 });
const opId = Type.String({ pattern: '^[A-Za-z0-9_-]{1,96}$' });
const scenarioSchema = Type.Object({ id: opId, scenePath: path, seed: Type.Integer(), timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 600 })),
        steps: Type.Array(Type.Object({ kind: Type.Union(['input', 'wait', 'assert', 'capture'].map((k) => Type.Literal(k))), device: Type.Optional(Type.Union(['keyboard', 'mouse', 'gamepad', 'touch'].map((k) => Type.Literal(k)))), control: Type.Optional(Type.String()), value: Type.Optional(Type.Union([Type.Number(), Type.Array(Type.Number())])), frames: Type.Optional(Type.Integer({ minimum: 1, maximum: 36000 })), seconds: Type.Optional(Type.Number({ minimum: 0.01, maximum: 600 })), target: Type.Optional(Type.String()), component: Type.Optional(Type.String()), property: Type.Optional(Type.String()), comparison: Type.Optional(Type.Union(['equals', 'greater', 'less', 'exists'].map((k) => Type.Literal(k)))), expected: Type.Optional(Type.Union([Type.String(), Type.Number(), Type.Boolean()])), label: Type.Optional(Type.String()) }), { minItems: 1, maxItems: 1000 }) });

export function createAutomationTools(task: TaskRunContext, role: SpecialistRole | 'coordinator', deps: AutomationDeps): AgentTool[] {
  const inspectedFrames = new Map<string, number>();
  const ensure = () => {
    task.assertActive();
    if (deps.protocol() < 6) throw new Error('Unity authoring and gameplay verification require bridge protocol 6 (package 0.4.0). Update the integration package.');
  };
  const record = (kind: EvidenceKind, report: AutomationReport, revision: number, scenarioId?: string, sceneTarget?: SceneTarget) => {
    task.record({ id: `${kind}:${scenarioId ?? report.operationId}`, kind, revision, scenarioId,
      status: report.status === 'passed' && (kind !== 'gameplay' || report.cleanupComplete === true) ? 'passed' : report.status === 'unsupported' ? 'unsupported' : report.status === 'failed' ? 'failed' : 'not-run',
      summary: report.reason ?? `${report.status}: ${report.observations?.length ?? 0} observations`,
      artifacts: report.outputs ?? [], operationId: report.operationId,
      ...(kind === 'gameplay' ? { assertions: { passed: report.observations?.filter((o) => o.passed).length ?? 0, total: report.observations?.length ?? 0 } } : {}),
      ...(sceneTarget ? { sceneTarget } : {}) });
  };
  const compile = async (signal?: AbortSignal, force = false) => {
    const existing = task.evidence.get('compile');
    if (!force && existing?.revision === task.revision && existing.status === 'passed') return true;
    const revision = task.revision;
    const result = await deps.compile(signal);
    const passed = result.status === 'report' && result.report.success === true && !result.report.errors;
    // A no-op import is not evidence that the current compiler state is clean.
    task.record({ id: 'compile', kind: 'compile', revision, status: passed ? 'passed' : result.status === 'report' ? 'failed' : 'not-run', summary: JSON.stringify(result), artifacts: [] });
    return passed;
  };
  return [
    { name: 'unity_compile', label: 'compile Unity project', description: 'Compile a completed script batch and await a real compiler report.', parameters: Type.Object({}), timeoutMs: 150_000,
      execute: async (_id, _raw, signal) => { ensure(); const passed = await compile(signal, true); return txt(task.evidence.get('compile'), !passed); } },
    { name: 'unity_author', label: 'author saved Unity content', timeoutMs: Number.POSITIVE_INFINITY,
      description: 'Edit-mode authoring. Creates an isolated ownedRoot or edits an existing rootGlobalObjectId, persists scene/prefabs, and verifies reopening. Use stable IDs returned by hierarchy reads for existing objects and duplicate components. Existing-root edits use scoped actions; builders are allowed only for owned roots. Use a fresh operationId for changed inputs and query status before retrying an uncertain request.',
      parameters: Type.Object({ operationId: opId, scenePath: path, ownedRoot: Type.Optional(Type.String({ pattern: '^[^/\\\\]+$', minLength: 1 })), rootGlobalObjectId: Type.Optional(Type.String({ pattern: '^GlobalObjectId_V1-' })), outputs: Type.Array(path, { minItems: 1 }),
        actions: Type.Array(Type.Object({ kind: Type.Union(['object', 'prefab', 'component', 'property', 'savePrefab'].map((k) => Type.Literal(k))), target: Type.String(), targetGlobalObjectId: Type.Optional(Type.String({ pattern: '^GlobalObjectId_V1-' })), parent: Type.Optional(Type.String()), primitive: Type.Optional(Type.Union(['Cube', 'Sphere', 'Capsule', 'Cylinder', 'Plane', 'Quad'].map((k) => Type.Literal(k)))), assetPath: Type.Optional(path), component: Type.Optional(Type.String()), componentGlobalObjectId: Type.Optional(Type.String({ pattern: '^GlobalObjectId_V1-' })), property: Type.Optional(Type.String()), value: Type.Optional(Type.Unknown()), position: Type.Optional(vector), scale: Type.Optional(vector) }), { maxItems: 1000 }),
        builder: Type.Optional(Type.Object({ type: Type.String(), method: Type.String(), parameters: Type.String() })) }),
      execute: async (id, raw, signal) => {
        ensure(); const args = raw as Omit<AuthoringOperation, 'taskId'>;
        if (Boolean(args.ownedRoot) === Boolean(args.rootGlobalObjectId)) return txt('Provide exactly one of ownedRoot or rootGlobalObjectId.', true);
        task.operation(args.operationId, args);
        if (!args.outputs.includes(args.scenePath)) return txt('Declare the scene in outputs.', true);
        const existing = await deps.authorStatus(args.operationId);
        if (existing.status !== 'unsupported') return txt(existing.taskId === task.id ? existing : { ...existing, status: 'interrupted', reason: 'Operation ID belongs to another task. Use a new ID after inspecting its status.' }, existing.taskId !== task.id || existing.status !== 'passed');
        if (!await compile(signal)) return txt('Authoring waits for a confirmed clean compile.', true);
        const expectedAssetHashes = await deps.checkpoint([...args.outputs, ...args.outputs.map((p) => p + '.meta')], id);
        // Invalidate before dispatch, including uncertain outcomes.
        args.outputs.forEach((p) => task.changed(p));
        task.operations.set(args.operationId, { revision: task.revision, payload: JSON.stringify(args) });
        let report: AutomationReport;
        try {
          report = await deps.author({ ...args, taskId: task.id,
            requireAuthoredLevel: task.sceneRequiresRepresentativeLevel(args.scenePath, args.ownedRoot ?? args.rootGlobalObjectId!),
            ...(expectedAssetHashes ? { expectedAssetHashes } : {}) });
        }
        catch (error) {
          return txt({ operationId: args.operationId, status: 'interrupted', reason: `Outcome unknown; query unity_author_status before retrying. ${error}` }, true);
        }
        record('scene-persistence', report, task.revision, undefined, { scenePath: args.scenePath, root: args.ownedRoot ?? args.rootGlobalObjectId! });
        return txt(report, report.status !== 'passed');
      } },
    { name: 'unity_author_status', label: 'authoring operation status', description: 'Recover an authoring operation outcome without repeating the mutation.', parameters: Type.Object({ operationId: opId }),
      execute: async (_id, raw) => { ensure(); return txt(await deps.authorStatus((raw as { operationId: string }).operationId)); } },
    { name: 'unity_verify_scene', label: 'verify saved scene', description: 'Reopen a clean saved scene and verify a specific authored root has persistent, visible Edit Mode content. Refuses dirty scenes.', parameters: Type.Object({ scenePath: path, root: Type.String({ minLength: 1 }) }), timeoutMs: 45_000,
      execute: async (_id, raw) => { ensure(); const revision = task.revision; const target = raw as SceneTarget; const report = await deps.verifyScene(target.scenePath, target.root, task.sceneRequiresRepresentativeLevel(target.scenePath, target.root)); report.operationId = target.scenePath; record('scene-persistence', report, revision, undefined, target); return txt(report, report.status !== 'passed'); } },
    { name: 'unity_register_scenarios', label: 'declare required gameplay suite', description: 'Register the entire acceptance suite before its first run. Definitions are immutable; additional coverage can be appended. Each seed uses a separate scenario ID. Every registered scenario must pass after repairs.',
      parameters: Type.Object({ scenarios: Type.Array(scenarioSchema, { minItems: 1, maxItems: 100 }) }),
      execute: async (_id, raw) => {
        task.assertActive();
        const { scenarios } = raw as { scenarios: GameplayScenario[] };
        if (new Set(scenarios.map((s) => s.id)).size !== scenarios.length) return txt('Duplicate scenario IDs.', true);
        for (const scenario of scenarios) {
          if (!scenario.steps.some((s) => s.kind === 'input') || !scenario.steps.some((s) => s.kind === 'assert')) return txt('Every scenario must drive input and assert an outcome.', true);
          const previous = task.scenarios.get(scenario.id);
          if (previous && previous !== JSON.stringify(scenario)) return txt(`Required scenario ${scenario.id} is fixed and cannot be weakened or replaced.`, true);
        }
        scenarios.forEach((scenario) => task.scenarios.set(scenario.id, JSON.stringify(scenario)));
        task.requirements.add('gameplay'); task.onChange();
        return txt({ requiredScenarios: [...task.scenarios.keys()] });
      } },
    { name: 'unity_playtest', label: 'run gameplay scenario', timeoutMs: 660_000,
      description: 'Run an input-driven Play Mode scenario against a saved scene. Two minute default timeout; up to ten minutes for endurance tests. Waits for assertions, console checks and actual Game-view screenshots. Missing support never passes.',
      parameters: Type.Object({ operationId: opId, scenario: scenarioSchema }),
      execute: async (_id, raw, signal) => {
        ensure(); const args = raw as { operationId: string; scenario: GameplayScenario };
        if (!args.scenario.steps.some((s) => s.kind === 'assert') || !args.scenario.steps.some((s) => s.kind === 'input')) return txt('A gameplay scenario must drive input and assert an outcome.', true);
        const frozen = task.scenarios.get(args.scenario.id);
        const serialized = JSON.stringify(args.scenario);
        if (!frozen) return txt('Register the complete required suite with unity_register_scenarios before running it.', true);
        if (frozen !== serialized) return txt('This scenario is fixed. Add coverage with a new ID; existing required checks cannot be changed or removed.', true);
        task.operation(args.operationId, args.scenario);
        const deadline = task.gameplayDeadline();
        if (Date.now() >= deadline) return txt('Ten-minute suite timeout reached. Do not start more scenarios.', true);
        if (!await compile(signal)) return txt('Playtest waits for a confirmed clean compile.', true);
        const revision = task.revision;
        let report: AutomationReport;
        let owned = false;
        const checkOwner = (value: AutomationReport) => {
          if (value.operationId !== args.operationId || value.taskId && value.taskId !== task.id ||
            ['queued', 'running', 'passed'].includes(value.status) && value.taskId !== task.id) throw new Error('Playtest evidence belongs to another task or has no confirmed owner.');
          owned = value.taskId === task.id;
          return value;
        };
        try {
          try { report = await deps.play(args.operationId, args.scenario); }
          catch {
            // A transport timeout may hide an accepted mutation. Resolve the
            // journal identity before deciding what to do; never replay start.
            report = await deps.status(args.operationId);
            if (report.status === 'unsupported') throw new Error('Playtest acknowledgement was lost and its outcome is unknown. Query status before starting another run.');
          }
          report = checkOwner(report);
          while (report.status === 'queued' || report.status === 'running' || report.cleanupComplete === false) {
            if (Date.now() >= deadline) throw new Error('Gameplay suite timeout');
            await deps.wait(500, signal); task.assertActive();
            let next: AutomationReport;
            try { next = await deps.status(args.operationId); }
            catch { if (signal?.aborted) throw new Error('Cancelled'); continue; /* expected reload; keep polling same ID */ }
            report = checkOwner(next);
          }
          if (report.status === 'passed' || report.status === 'failed') report = checkOwner(await deps.status(args.operationId, true));
        } catch (error) {
          // Cancellation must wait for Unity to release devices and leave owned
          // Play Mode. The workspace lease stays held during this cleanup.
          try {
            if (!owned) {
              const current = await deps.status(args.operationId);
              owned = current.taskId === task.id;
            }
            if (owned) {
              let cleanup = await deps.cancel(args.operationId);
              const until = Date.now() + 30_000;
              while (cleanup.cleanupComplete === false && Date.now() < until) {
                await deps.wait(250); cleanup = await deps.status(args.operationId);
              }
            }
          } catch { /* Interrupted remains unverified; later tasks reconcile. */ }
          report = { operationId: args.operationId, status: signal?.aborted ? 'cancelled' : 'interrupted', reason: String(error) };
        }
        record('gameplay', report, revision, args.scenario.id);
        const result = txt({ ...report, captures: report.captures?.map((c) => ({ label: c.label })) }, report.status !== 'passed' || report.cleanupComplete !== true);
        for (const capture of report.captures ?? []) result.content.push({ type: 'image', data: capture.data, mimeType: capture.mimeType });
        return result;
      } },
    { name: 'unity_playtest_status', label: 'gameplay evidence', description: 'Read a previous run and its actual captured frames. Does not repeat gameplay.', parameters: Type.Object({ operationId: opId }),
      execute: async (_id, raw) => {
        ensure(); const report = await deps.status((raw as { operationId: string }).operationId, true);
        const result = txt({ ...report, captures: report.captures?.map((c) => ({ label: c.label })) });
        for (const c of report.captures ?? []) result.content.push({ type: 'image', data: c.data, mimeType: c.mimeType });
        if (report.captures?.length) inspectedFrames.set(report.operationId, task.revision);
        return result;
      } },
    ...(role === 'independent-review' ? [{ name: 'submit_review', label: 'independent review', description: 'Record independent findings. Visual review must cite a gameplay run whose actual frames you inspected.', parameters: Type.Object({ passed: Type.Boolean(), summary: Type.String({ minLength: 1 }), visual: Type.Optional(Type.Object({ passed: Type.Boolean(), operationId: opId, summary: Type.String({ minLength: 1 }) })) }),
      execute: async (_id: string, raw: unknown) => {
        const args = raw as { passed: boolean; summary: string; visual?: { passed: boolean; operationId: string; summary: string } };
        task.record({ id: 'review', kind: 'review', revision: task.revision, status: args.passed ? 'passed' : 'failed', summary: args.summary, artifacts: [] });
        if (args.visual) {
          const evidence = [...task.evidence.values()].find((e) => e.kind === 'gameplay' && e.operationId === args.visual?.operationId);
          const report = await deps.status(args.visual.operationId, true);
          const seen = inspectedFrames.get(args.visual.operationId) === task.revision && evidence?.revision === task.revision && (report.captures?.length ?? 0) > 0;
          task.record({ id: 'visual-review', kind: 'visual-review', revision: task.revision, status: seen ? args.visual.passed ? 'passed' : 'failed' : 'not-run', summary: seen ? args.visual.summary : 'No current captured frames available.', artifacts: [], operationId: args.visual.operationId });
        }
        return txt(task.requiredResults());
      } } satisfies AgentTool] : []),
  ];
}
