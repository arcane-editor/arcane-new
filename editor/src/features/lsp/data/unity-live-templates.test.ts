// A malformed snippet body is a silent failure: Monaco inserts the literal
// text including the `${1:...}` markers, so the user gets garbage instead of
// tab stops. These assert the shape rather than the prose.

import { describe, it, expect } from 'bun:test';
import { UNITY_LIVE_TEMPLATES } from './unity-live-templates';

describe('UNITY_LIVE_TEMPLATES', () => {
  it('ships the two abbreviations Unity developers use most', () => {
    const names = UNITY_LIVE_TEMPLATES.map((t) => t.name);
    expect(names).toContain('sfield');
    expect(names).toContain('sprop');
  });

  it('has unique names, so one cannot shadow another in the list', () => {
    const names = UNITY_LIVE_TEMPLATES.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives every template a final caret stop', () => {
    // Without `$0` the caret lands at the end of the LAST placeholder, which
    // leaves the user inside the declaration they just finished.
    for (const t of UNITY_LIVE_TEMPLATES) {
      expect(t.body).toContain('$0');
    }
  });

  it('numbers placeholders from 1 with no gaps', () => {
    for (const t of UNITY_LIVE_TEMPLATES) {
      const nums = [...t.body.matchAll(/\$\{(\d+):/g)].map((m) => Number(m[1]));
      if (nums.length === 0) continue;
      const unique = [...new Set(nums)].sort((a, b) => a - b);
      expect(unique[0]).toBe(1);
      // Tab order skipping a number strands a stop the user can never reach.
      expect(unique).toEqual(unique.map((_, i) => i + 1));
    }
  });

  it('reuses one placeholder for the type in sprop so both sites stay in sync', () => {
    const sprop = UNITY_LIVE_TEMPLATES.find((t) => t.name === 'sprop')!;
    // The field and the accessor must share ${1}, or editing the type updates
    // only one of the two lines.
    expect([...sprop.body.matchAll(/\$\{1:/g)]).toHaveLength(2);
  });

  it('describes every template, since the list is a discovery surface', () => {
    for (const t of UNITY_LIVE_TEMPLATES) {
      expect(t.detail.length).toBeGreaterThan(0);
      expect(t.documentation.length).toBeGreaterThan(0);
    }
  });
});
