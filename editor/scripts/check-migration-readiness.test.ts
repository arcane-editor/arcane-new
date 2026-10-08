import { expect, it } from 'bun:test';
import { assessMigrationReadiness, type Gate } from './check-migration-readiness';
const gate: Gate = { id: 'test', title: 'Test workflow', required: true, status: 'implemented', requiredEnvironments: ['windows','macos'], requiredFixtures: ['success','failure'], verification: [] };
const assess = (g: Gate) => assessMigrationReadiness({ schemaVersion: 1, release: '0.4.0', gates: [g] });
it('implemented code and skipped or incomplete evidence cannot make a green release', () => {
  expect(assess(gate).blockers).toHaveLength(1);
  const claimed = { ...gate, status: 'runtime-verified' as const, verification: [{ environment: 'macos', fixture: 'success', result: 'passed' as const, artifact: 'report.json' }] };
  expect(assess(claimed).errors).toHaveLength(1);
  expect(assess({ ...claimed, verification: [{ ...claimed.verification[0], result: 'skipped' }] }).blockers).toHaveLength(1);
});
it('requires every fixture on every declared environment and a traceable artifact', () => {
  const verification = gate.requiredEnvironments.flatMap(environment => gate.requiredFixtures.map(fixture => ({ environment, fixture, result: 'passed' as const, artifact: 'certification.json' })));
  expect(assess({ ...gate, status: 'runtime-verified', verification })).toEqual({ errors: [], blockers: [] });
  expect(assess({ ...gate, status: 'runtime-verified', verification: verification.map(v => ({ ...v, artifact: '' })) }).errors).not.toHaveLength(0);
});
it('does not quietly exempt requested specialist requirements', () => {
  expect(assess({ ...gate, status: 'reference-unsupported' }).errors).toHaveLength(1);
  expect(assess({ ...gate, required: false, status: 'reference-unsupported' }).blockers).toEqual([]);
});
it('a later failed or skipped run invalidates an older pass', () => {
  const verification = gate.requiredEnvironments.flatMap(environment => gate.requiredFixtures.map(fixture => ({ environment, fixture, result: 'passed' as const, artifact: 'certification.json' })));
  expect(assess({ ...gate, status: 'runtime-verified', verification: [...verification, { ...verification[0], result: 'failed' }] }).blockers).toHaveLength(1);
});
