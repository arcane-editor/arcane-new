import { it, expect } from 'bun:test';
import { checkRunnerGeneration, checkRunnerBenchmark, type RunnerGenerationEvidence } from './endless-runner';
import { TaskRunContext } from '../../../src/features/ai-panel/services/specialists/task-context';
it('does not accept clean compilation as a verified game', () => {
  const task = new TaskRunContext('test', '/game', 100);
  task.record({ id: 'compile', kind: 'compile', revision: 0, status: 'passed', summary: 'Compiled', artifacts: [] });
  const report: RunnerGenerationEvidence = { generationId: 'one', freshProjectId: 'fresh-one', modelConfiguration: 'same',
    acceptanceHashBefore: 'original', acceptanceHashAfter: 'original', task: task.snapshot('completed'), runs: [], latencyMs: 1, contextCharacters: 1 };
  expect(checkRunnerGeneration(report)).toContain('Missing current gameplay pass.');
  expect(checkRunnerGeneration(report)).toContain('seeded-endurance-137: not run at the final revision.');
  expect(checkRunnerBenchmark([report, report, report]).passed).toBe(false);
  report.acceptanceHashAfter = 'modified'; expect(checkRunnerGeneration(report).some((f) => f.includes('fixtures changed'))).toBe(true);
});
