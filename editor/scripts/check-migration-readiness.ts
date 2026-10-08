import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
export interface Gate {
  id: string; title: string; required: boolean;
  status: 'implemented' | 'runtime-verified' | 'incomplete' | 'reference-unsupported';
  requiredEnvironments: string[]; requiredFixtures: string[];
  verification: { environment: string; fixture: string; result: 'passed' | 'failed' | 'skipped'; artifact: string }[];
}
export interface Ledger { schemaVersion: number; release: string; gates: Gate[] }
export function assessMigrationReadiness(ledger: Ledger): { errors: string[]; blockers: string[] } {
  const errors: string[] = [], blockers: string[] = [], ids = new Set<string>();
  if (ledger.schemaVersion !== 1 || ledger.release !== '0.4.0' || !Array.isArray(ledger.gates) || !ledger.gates.length) {
    return { errors: ['Invalid or empty 0.4.0 capability ledger'], blockers: [] };
  }
  for (const gate of ledger.gates) {
    if (!gate || typeof gate !== 'object') { errors.push('Invalid gate record'); continue; }
    if (typeof gate.id !== 'string' || !gate.id || ids.has(gate.id)) errors.push(`Duplicate or missing gate ID: ${gate.id}`);
    ids.add(gate.id);
    if (typeof gate.required !== 'boolean' || typeof gate.title !== 'string' || !gate.title.trim()) errors.push(`${gate.id}: missing requirement flag or title`);
    if (!['implemented','runtime-verified','incomplete','reference-unsupported'].includes(gate.status)) errors.push(`${gate.id}: invalid evidence state`);
    if (gate.required && gate.status === 'reference-unsupported') errors.push(`${gate.id}: a requested requirement cannot be exempted as reference-unsupported`);
    if (!Array.isArray(gate.requiredEnvironments) || !Array.isArray(gate.requiredFixtures) || !Array.isArray(gate.verification)) {
      errors.push(`${gate.id}: missing environment/fixture/evidence inventory`); continue;
    }
    for (const values of [gate.requiredEnvironments, gate.requiredFixtures]) {
      if (values.some(v => typeof v !== 'string' || !v.trim()) || new Set(values).size !== values.length) errors.push(`${gate.id}: invalid or duplicate environment/fixture`);
    }
    for (const evidence of gate.verification) {
      if (!evidence || !gate.requiredEnvironments.includes(evidence.environment) || !gate.requiredFixtures.includes(evidence.fixture) ||
        !['passed','failed','skipped'].includes(evidence.result) || typeof evidence.artifact !== 'string' || !evidence.artifact.trim()) {
        errors.push(`${gate.id}: invalid verification record`);
      }
    }
    const needsEvidence = gate.required || gate.status === 'runtime-verified';
    const complete = gate.requiredEnvironments.length > 0 && gate.requiredFixtures.length > 0 &&
      gate.requiredEnvironments.every(environment => gate.requiredFixtures.every(fixture => {
        // Entries are appended chronologically. A later failure or skip must
        // invalidate an older pass for the same environment and fixture.
        const latest = [...gate.verification].reverse().find(v => v?.environment === environment && v?.fixture === fixture);
        return latest?.result === 'passed' && typeof latest.artifact === 'string' && !!latest.artifact.trim();
      }));
    if (gate.status === 'runtime-verified' && !complete) errors.push(`${gate.id}: runtime-verified requires passing evidence for every declared environment and fixture`);
    if (needsEvidence && (gate.status !== 'runtime-verified' || !complete)) blockers.push(`${gate.id}: ${gate.title}`);
  }
  return { errors, blockers };
}
if (import.meta.main) {
  const ledger = JSON.parse(readFileSync(resolve(import.meta.dir, '../../docs/implementation/unityide-040-capabilities.json'), 'utf8')) as Ledger;
  const { errors, blockers } = assessMigrationReadiness(ledger);
  for (const error of errors) console.error(error);
  if (errors.length) process.exit(1);
  if (process.argv.includes('--validate')) console.log(`Capability ledger valid: ${ledger.gates.length} gates, ${blockers.length} release blockers.`);
  else {
    for (const blocker of blockers) console.error(`UNVERIFIED ${blocker}`);
    console.log(blockers.length ? `NOT READY: ${blockers.length} required gates remain open.` : 'READY: every required gate has declared passing evidence.');
    process.exitCode = blockers.length ? 1 : 0;
  }
}
