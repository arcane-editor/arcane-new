import { describe, expect, it } from 'bun:test';
import { normalizeVerifiedCard } from './verified-card-data';

describe('persisted verification card validation', () => {
  it('rejects null and malformed check results without claiming success', () => {
    const card = normalizeVerifiedCard({ files: 1, touchedFiles: ['Assets/Player.cs'], uiToolkit: null,
      input: { problems: 'none' }, guids: { missing: null }, analyzers: [], layout: false,
      tests: { failures: [null] }, console: { items: null } });
    for (const key of ['uiToolkit', 'input', 'guids', 'analyzers', 'layout', 'tests', 'console'] as const) expect(card[key]).toBe('skipped');
    expect(card.touchedFiles).toEqual(['Assets/Player.cs']);
  });
  it('preserves valid evidence and reports an unreadable requirement as not run', () => {
    const card = normalizeVerifiedCard({ files: 0, touchedFiles: [], compile: 'clean', requiredEvidence: [null] });
    expect(card.compile).toBe('clean');
    expect(card.requiredEvidence?.[0].status).toBe('not-run');
  });
  it('supports missing legacy fields and is idempotent', () => {
    const card = normalizeVerifiedCard({ files: 1, touchedFiles: ['A.cs'], compile: 'clean' });
    expect(card.uiToolkit).toBe('skipped');
    expect(normalizeVerifiedCard(card)).toBe(card);
  });
});
