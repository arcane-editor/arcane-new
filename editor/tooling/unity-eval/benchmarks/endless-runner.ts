import type { AutomationReport, GameplayScenario } from '../../../src/types/automation';
import type { TaskRunSnapshot } from '../../../src/features/ai-panel/services/specialists/task-context';

/** Independent acceptance contract. Implementation tools cannot write this file
 * or the corresponding Assets/Tests/UnityIDEAcceptance directory in a fixture.
 * A game-specific observer may report measurements; it must not implement rules.
 */
export const RUNNER_CHECKS = ['movement', 'jump', 'slide', 'collision', 'collection', 'pause-resume', 'restart', 'chunk-continuity', 'seeded-endurance'] as const;
export const RUNNER_SEEDS = [17, 41, 137] as const;
export const RUNNER_BRIEF = `Build an original complete three-lane endless runner prototype for Unity 6.
Author and save a visible representative level and reusable chunk prefabs before Play; use those same prefabs for runtime recycling, without duplicate startup geometry.
Implement lane movement, jump, slide, obstacles, pickups, score, increasing difficulty, camera and feedback. Include start, HUD, pause, game-over and restart flows.
Use the existing input system, render pipeline and UI stack. Original simple art is sufficient, but obstacles, UI and camera framing must be readable.
Before implementing, freeze acceptance for every listed behavior. Independent gameplay verification must cover ${RUNNER_CHECKS.join(', ')} at seeds ${RUNNER_SEEDS.join(', ')}.
Name scenarios <check>-<seed>, for example movement-17. Each scenario must drive actual input and assert outcomes; include rendered capture checkpoints. Each seeded-endurance scenario must run for at least 180 seconds and end with independent continuity, progression and error checks. The complete suite has a ten-minute limit.
Keep acceptance fixtures under Assets/Tests/UnityIDEAcceptance outside implementation write targets. Do not alter independent assertions or replace real input with direct calls to gameplay methods.
Run independent visual review of the actual frames after the final repair, and report anything that remains unverified.`;

export interface RunnerGenerationEvidence {
  generationId: string;
  /** Harness-generated identity of a separately created clean project. */
  freshProjectId: string;
  modelConfiguration: string;
  /** Hashes of external acceptance fixtures before and after generation. */
  acceptanceHashBefore: string;
  acceptanceHashAfter: string;
  task: TaskRunSnapshot;
  runs: { scenario: GameplayScenario; revision: number; report: AutomationReport }[];
  latencyMs: number;
  contextCharacters: number;
}
export function checkRunnerGeneration(result: RunnerGenerationEvidence): string[] {
  const failures: string[] = [];
  if (!result.freshProjectId) failures.push('A fresh project identity is required.');
  if (!result.acceptanceHashBefore || result.acceptanceHashBefore !== result.acceptanceHashAfter) failures.push('Independent acceptance fixtures changed or were not fingerprinted.');
  if (result.task.status !== 'completed') failures.push('The coordinator did not complete its acceptance workflow.');
  for (const kind of ['compile', 'scene-persistence', 'gameplay', 'visual-review', 'review']) {
    const evidence = result.task.evidence.filter((e) => e.kind === kind && e.revision === result.task.revision);
    if (!evidence.length || evidence.some((e) => e.status !== 'passed')) failures.push(`Missing current ${kind} pass.`);
  }
  if (result.task.repairCycles > 5) failures.push('Exceeded five repair cycles.');
  for (const seed of RUNNER_SEEDS) for (const check of RUNNER_CHECKS) {
    const id = `${check}-${seed}`;
    const run = result.runs.findLast((r) => r.scenario.id === id && r.scenario.seed === seed && r.revision === result.task.revision);
    if (!run) { failures.push(`${id}: not run at the final revision.`); continue; }
    if (run.report.status !== 'passed' || !run.report.cleanupComplete) failures.push(`${id}: failed, unsupported or incomplete cleanup.`);
    if (!run.scenario.steps.some((s) => s.kind === 'input') || !run.scenario.steps.some((s) => s.kind === 'assert')) failures.push(`${id}: not input-driven assertion coverage.`);
    if (!run.report.observations?.length || run.report.observations.some((o) => !o.passed)) failures.push(`${id}: missing or failed observations.`);
    if (run.report.consoleErrors?.length) failures.push(`${id}: runtime errors.`);
    if (check === 'seeded-endurance') {
      const duration = run.scenario.steps.reduce((n, s) => n + (s.kind === 'wait' ? s.seconds ?? 0 : 0), 0);
      if (duration < 180 || (run.report.elapsedSeconds ?? 0) < 180) failures.push(`${id}: less than three minutes of gameplay.`);
    }
  }
  if (!result.runs.some((r) => r.revision === result.task.revision && r.report.captures?.some((c) => c.data.length > 0))) failures.push('No actual rendered visual evidence.');
  return failures;
}
export function checkRunnerBenchmark(results: RunnerGenerationEvidence[]) {
  const failures = results.flatMap((r) => checkRunnerGeneration(r).map((f) => `${r.generationId}: ${f}`));
  if (results.length !== 3 || new Set(results.map((r) => r.freshProjectId)).size !== 3) failures.push('Three separate fresh generations are required.');
  if (new Set(results.map((r) => r.modelConfiguration)).size !== 1) failures.push('Compare runs using the same model configuration.');
  return { passed: failures.length === 0, failures, metrics: results.map((r) => ({ generationId: r.generationId, calls: r.task.calls,
    inputTokens: r.task.usage.reduce((n, [, u]) => n + u.input, 0), outputTokens: r.task.usage.reduce((n, [, u]) => n + u.output, 0),
    repairCycles: r.task.repairCycles, latencyMs: r.latencyMs, contextCharacters: r.contextCharacters })) };
}
