import type { VerifiedCardData } from './verified-pass';

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const counts = (value: unknown, keys: string[]) => record(value) && keys.every((key) => count(value[key]));
const strings = (value: unknown) => Array.isArray(value) && value.every((v) => typeof v === 'string');
const degradation = (value: unknown) => ['no-bridge', 'editor-asleep', 'reconnected', 'old-package', 'protocol-unknown'].includes(String(value));

/** Runtime migration for persisted cards. Missing or invalid evidence is skipped,
 * never promoted to a passing result. Also used at the rendering boundary. */
export function normalizeVerifiedCard(value: unknown): VerifiedCardData {
  const input = record(value) ? value : {};
  const output: Record<string, unknown> = { ...input };
  const field = (key: string, valid: (v: unknown) => boolean, fallback: unknown = 'skipped') => {
    if (!valid(input[key])) output[key] = fallback;
  };
  const status = (v: unknown, allowed: string[], check: (v: unknown) => boolean) => allowed.includes(String(v)) || check(v);
  field('files', count, 0);
  field('touchedFiles', strings, []);
  field('analyzers', (v) => status(v, ['skipped'], (v) => counts(v, ['errors'])));
  field('compile', (v) => status(v, ['skipped', 'clean'], (v) => counts(v, ['errors'])));
  field('guids', (v) => status(v, ['skipped', 'intact'], (v) => record(v) && strings(v.missing)));
  field('uiToolkit', (v) => status(v, ['skipped', 'clean'], (v) => counts(v, ['problems', 'queriesResolved', 'queriesTotal'])));
  field('scriptableObjects', (v) => status(v, ['skipped', 'clean'], (v) => counts(v, ['drift'])));
  field('input', (v) => status(v, ['skipped', 'clean'], (v) => counts(v, ['problems'])));
  field('layout', (v) => status(v, ['skipped'], (v) => counts(v, ['documents', 'elements', 'problems']) && record(v) && (v.unstyled === undefined || count(v.unstyled))));
  field('console', (v) => status(v, ['skipped', 'clean'], (v) => record(v) && (
    degradation(v.unknown) || (v.repairAttempted === true && degradation(v.recheck)) || (
      counts(v, ['newErrors', 'external', 'fixed', 'notReobserved', 'remaining']) && typeof v.repaired === 'boolean' && typeof v.streamOnly === 'boolean'
      && Array.isArray(v.items) && v.items.every((i) => record(i) && typeof i.firstLine === 'string' && typeof i.logType === 'string' && (i.location === null || typeof i.location === 'string') && count(i.count) && typeof i.external === 'boolean')
    ))));
  field('tests', (v) => status(v, ['skipped'], (v) => record(v) && (typeof v.unfinished === 'string' || (
    typeof v.mode === 'string' && counts(v, ['passed', 'failed', 'skipped']) && Array.isArray(v.failures)
    && v.failures.every((f) => record(f) && typeof f.fullName === 'string' && typeof f.message === 'string')
  ))));
  if (!record(input.repair) || input.repair.attempted !== true || !['console', 'compile', 'tests', 'mixed'].includes(String(input.repair.trigger))) delete output.repair;
  if (input.requiredEvidence !== undefined && (!Array.isArray(input.requiredEvidence) || !input.requiredEvidence.every((e) => record(e) && typeof e.id === 'string' && typeof e.kind === 'string' && typeof e.summary === 'string' && ['passed', 'failed', 'not-run', 'unsupported'].includes(String(e.status))))) {
    // Retain an explicit non-passing requirement when saved required evidence
    // is unreadable, rather than dropping it and allowing a green verdict.
    output.requiredEvidence = [{ id: 'unreadable', kind: 'review', status: 'not-run', revision: 0, artifacts: [], summary: 'Saved verification evidence could not be read.' }];
  }
  return Object.keys(output).length === Object.keys(input).length && Object.keys(output).every((key) => output[key] === input[key])
    ? input as unknown as VerifiedCardData : output as unknown as VerifiedCardData;
}
