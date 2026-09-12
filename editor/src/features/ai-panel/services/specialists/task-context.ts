import type { EvidenceKind, SceneTarget, VerificationEvidence } from './contracts';

// Resource arbitration is shared per workspace; execution state is never global.
const workspaceLeases = new Map<string, Promise<void>>();

export interface TaskRunSnapshot {
  id: string; workspacePath: string; maxCalls: number; calls: number; revision: number; repairCycles: number;
  status: 'running' | 'completed' | 'stopped' | 'interrupted';
  criteria: string[]; requirements: EvidenceKind[]; evidence: VerificationEvidence[]; touchedFiles: string[];
  usage: [string, { calls: number; input: number; output: number }][];
  operations: [string, { revision: number; payload: string }][]; scenarios: [string, string][];
  noProgress: number;
  previousProgress?: number;
  requiresAuthoredLevel?: boolean;
  requiredScenes?: SceneTarget[];
  originalRequest?: string;
}

/** Explicit ownership: no ambient current task/agent, even across awaits. */
export class TaskRunContext {
  readonly abort = new AbortController();
  readonly touchedFiles = new Set<string>();
  readonly evidence = new Map<string, VerificationEvidence>();
  readonly completed = new Set<string>();
  readonly requirements = new Set<EvidenceKind>();
  readonly criteria: string[] = [];
  readonly usage = new Map<string, { calls: number; input: number; output: number }>();
  readonly tools = new Map<string, { calls: Map<string, number>; revision: number }>();
  readonly changedAt = new Map<string, number>();
  readonly operations = new Map<string, { revision: number; payload: string }>();
  readonly scenarios = new Map<string, string>();
  readonly requiredScenes = new Map<string, SceneTarget>();
  suiteDeadline = 0;
  suiteRevision = -1;
  needsRepair = false;
  requiresAuthoredLevel = false;
  originalRequest = '';
  revision = 0;
  calls = 0;
  repairCycles = 0;
  private previousProgress: number | undefined;
  private noProgress = 0;
  onChange: () => void = () => {};

  constructor(readonly id: string, readonly workspacePath: string, readonly maxCalls: number) {}

  takeCall(agentId: string): void {
    this.assertActive();
    if (this.calls >= this.maxCalls) throw new Error('Task model-call budget exhausted. All specialists share this limit.');
    this.calls++;
    this.agentUsage(agentId).calls++;
    this.onChange();
  }

  agentUsage(id: string) {
    let value = this.usage.get(id);
    if (!value) { value = { calls: 0, input: 0, output: 0 }; this.usage.set(id, value); }
    return value;
  }

  assertActive(): void {
    if (this.abort.signal.aborted) throw new Error('Task cancelled');
  }

  /** Hold until the operation actually settles, including after cancellation. */
  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const key = this.workspacePath.replace(/\\/g, '/').replace(/\/$/, '');
    const preceding = workspaceLeases.get(key);
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    workspaceLeases.set(key, next);
    try { await preceding; this.assertActive(); return await fn(); }
    finally { release(); if (workspaceLeases.get(key) === next) workspaceLeases.delete(key); }
  }

  changed(path: string): void {
    this.touchedFiles.add(path);
    this.revision++;
    this.changedAt.set(path, this.revision);
    this.onChange();
  }

  record(item: VerificationEvidence): void {
    this.evidence.set(item.id, item);
    if (item.status === 'failed') this.needsRepair = true;
    this.onChange();
  }

  requireScene(target: SceneTarget): void {
    const normalized = {
      scenePath: target.scenePath.replace(/\\/g, '/'),
      root: target.root,
      requireRepresentativeLevel: target.requireRepresentativeLevel === true,
    };
    this.requiredScenes.set(`${normalized.scenePath}#${normalized.root}`, normalized);
    this.requirements.add('scene-persistence');
    if (normalized.requireRepresentativeLevel) this.requiresAuthoredLevel = true;
    this.onChange();
  }

  sceneRequiresRepresentativeLevel(scenePath: string, root: string): boolean {
    const normalizedPath = scenePath.replace(/\\/g, '/');
    const scoped = this.requiredScenes.get(`${normalizedPath}#${root}`);
    if (scoped) return scoped.requireRepresentativeLevel === true;
    // Compatibility for a resumed protocol-5 task that predates per-root
    // acceptance. New tasks carry the decision on each scene target.
    return this.requiredScenes.size === 0 && this.requiresAuthoredLevel;
  }

  requiredResults(): VerificationEvidence[] {
    return [...this.requirements].flatMap((kind) => {
      const matches = [...this.evidence.values()].filter((e) => e.kind === kind && e.revision === this.revision);
      if (kind === 'scene-persistence' && this.requiredScenes.size > 0) {
        return [...this.requiredScenes].map(([key, target]) => {
          const scoped = matches.filter((e) => e.sceneTarget?.scenePath === target.scenePath && e.sceneTarget.root === target.root);
          return scoped.find((e) => e.status === 'failed') ?? scoped.find((e) => e.status !== 'passed') ?? scoped.at(-1) ?? {
            id: `scene-persistence:${key}`, kind, status: 'not-run' as const, revision: this.revision,
            summary: `Required authored scene root needs current persistence evidence: ${target.scenePath}#${target.root}`,
            artifacts: [], sceneTarget: target,
          };
        });
      }
      const failed = matches.find((e) => e.status === 'failed');
      if (kind === 'gameplay') {
        const missing = [...this.scenarios.keys()].filter((id) => !matches.some((e) => e.scenarioId === id && e.status === 'passed'));
        if (!failed && missing.length) return [{ id: kind, kind, status: 'not-run', revision: this.revision, summary: `Required scenarios need current passing evidence: ${missing.join(', ')}`, artifacts: [] }];
      }
      return [failed ?? matches.find((e) => e.status !== 'passed') ?? matches.at(-1) ?? {
        id: kind, kind, status: 'not-run', revision: this.revision,
        summary: 'Required evidence is missing or predates the latest project change.', artifacts: [],
      }];
    });
  }

  canFinish(): boolean {
    return this.criteria.length > 0 && this.requiredResults().every((e) => e.status === 'passed');
  }

  /** Once per repair round, not once per specialist or individual failure. */
  beginRepair(): boolean {
    if (this.abort.signal.aborted || this.calls >= this.maxCalls || this.repairCycles >= 5) return false;
    // Wording changes, fresh operation IDs and new revisions are not progress.
    // Count confirmed checks and input-driven assertions at this revision.
    const current = [...this.evidence.values()].filter((e) => e.revision === this.revision && this.requirements.has(e.kind));
    const progress = this.requiredResults().filter((e) => e.status === 'passed').length + [...this.scenarios.keys()].reduce((score, id) => {
      const results = current.filter((e) => e.kind === 'gameplay' && e.scenarioId === id);
      return score + Math.max(0, ...results.map((e) => (e.assertions?.passed ?? 0) + (e.status === 'passed' ? 1 : 0)));
    }, 0);
    this.noProgress = this.previousProgress !== undefined && progress <= this.previousProgress ? this.noProgress + 1 : 0;
    this.previousProgress = progress;
    if (this.noProgress >= 2) return false;
    this.repairCycles++;
    this.needsRepair = false;
    this.onChange();
    return true;
  }

  operation(id: string, payload: unknown): void {
    const serialized = JSON.stringify(payload);
    const prior = this.operations.get(id);
    if (prior && (prior.revision !== this.revision || prior.payload !== serialized)) throw new Error('Operation ID belongs to different content or a stale revision. Query its status; use a new ID for new work.');
    this.operations.set(id, { revision: this.revision, payload: serialized });
  }

  gameplayDeadline(): number {
    if (this.suiteRevision !== this.revision) { this.suiteRevision = this.revision; this.suiteDeadline = Date.now() + 600_000; }
    return this.suiteDeadline;
  }

  snapshot(status: TaskRunSnapshot['status']): TaskRunSnapshot {
    return { id: this.id, workspacePath: this.workspacePath, maxCalls: this.maxCalls, calls: this.calls, revision: this.revision,
      repairCycles: this.repairCycles, status, criteria: [...this.criteria], requirements: [...this.requirements],
      evidence: [...this.evidence.values()], touchedFiles: [...this.touchedFiles], usage: [...this.usage],
      operations: [...this.operations], scenarios: [...this.scenarios], previousProgress: this.previousProgress, noProgress: this.noProgress, requiresAuthoredLevel: this.requiresAuthoredLevel,
      requiredScenes: [...this.requiredScenes.values()], originalRequest: this.originalRequest };
  }

  static restore(saved: TaskRunSnapshot): TaskRunContext {
    const task = new TaskRunContext(saved.id, saved.workspacePath, saved.maxCalls);
    task.requiresAuthoredLevel = saved.requiresAuthoredLevel ?? false;
    (saved.requiredScenes ?? []).forEach((target) => task.requiredScenes.set(`${target.scenePath}#${target.root}`, target));
    task.originalRequest = saved.originalRequest ?? '';
    task.calls = saved.calls; task.repairCycles = saved.repairCycles;
    // Offline edits and Unity reloads make all former evidence stale.
    task.revision = saved.revision + 1;
    task.noProgress = saved.noProgress;
    task.previousProgress = saved.previousProgress;
    task.criteria.push(...saved.criteria); saved.requirements.forEach((k) => task.requirements.add(k));
    saved.evidence.forEach((e) => task.evidence.set(e.id, e)); saved.touchedFiles.forEach((p) => task.touchedFiles.add(p));
    saved.usage.forEach(([id, u]) => task.usage.set(id, { ...u })); saved.operations.forEach(([id, o]) => task.operations.set(id, o));
    saved.scenarios.forEach(([id, s]) => task.scenarios.set(id, s));
    return task;
  }
}

export function taskPathAllowed(path: string, targets: readonly string[], workspace: string): boolean {
  const normalize = (p: string) => p.replace(/\\/g, '/').replace(/\/$/, '');
  const base = normalize(workspace);
  let relative = normalize(path);
  if (relative.startsWith(base + '/')) relative = relative.slice(base.length + 1);
  if (relative.startsWith('/') || /^[A-Za-z]:/.test(relative)) return false;
  const segments: string[] = [];
  for (const segment of relative.split('/')) {
    if (segment === '..') { if (!segments.length) return false; segments.pop(); }
    else if (segment && segment !== '.') segments.push(segment);
  }
  relative = segments.join('/');
  if (!relative.startsWith('Assets/')) return false;
  // Acceptance fixtures are owned by the harness, never implementation agents.
  if (/^Assets\/Tests\/UnityIDEAcceptance(?:\/|$)/i.test(relative)) return false;
  return targets.some((t) => {
    const target = normalize(t).replace(/^\.\//, '');
    return !target.includes('..') && (relative === target || relative.startsWith(target + '/'));
  });
}
