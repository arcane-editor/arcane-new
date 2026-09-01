// Coverage for the one piece of `setVariable` that can be wrong silently:
// which cached row gets rewritten. The request/response half needs a live
// adapter and is live-verification territory (SPEC §0.5).

import { describe, it, expect } from 'bun:test';
import { applySetVariable } from './debug-variables';
import type { VariableNode } from './debug-variables';

const rows = (): VariableNode[] => [
  { name: 'health', value: '100', type: 'int', variablesReference: 0 },
  { name: 'speed', value: '5.5', type: 'float', variablesReference: 0 },
];

describe('applySetVariable', () => {
  it('rewrites only the named row in the named container', () => {
    const before = new Map([[7, rows()]]);
    const after = applySetVariable(before, 7, 'health', { value: '0' });
    expect(after.get(7)!.map((r) => [r.name, r.value])).toEqual([
      ['health', '0'],
      ['speed', '5.5'],
    ]);
  });

  // The adapter echoes the value as the RUNTIME parsed it, which can differ
  // from what was typed. Showing the typed text would be a lie.
  it('takes the adapter echo as authoritative, not the typed text', () => {
    const after = applySetVariable(new Map([[7, rows()]]), 7, 'health', {
      value: '0',
      type: 'int',
    });
    expect(after.get(7)![0].value).toBe('0');
  });

  it('adopts a new variablesReference when the value becomes expandable', () => {
    const after = applySetVariable(new Map([[7, rows()]]), 7, 'health', {
      value: 'Vector3(1,2,3)',
      variablesReference: 42,
    });
    expect(after.get(7)![0].variablesReference).toBe(42);
  });

  it('keeps the previous type when the adapter omits one', () => {
    const after = applySetVariable(new Map([[7, rows()]]), 7, 'speed', { value: '9' });
    expect(after.get(7)![1].type).toBe('float');
  });

  it('returns the SAME map when the container is not cached', () => {
    const before = new Map([[7, rows()]]);
    const after = applySetVariable(before, 999, 'health', { value: '0' });
    // Identity, not just equality — an unknown container must not create an
    // entry, and must not churn the store into a re-render.
    expect(after).toBe(before);
  });

  it('does not mutate the input map', () => {
    const before = new Map([[7, rows()]]);
    applySetVariable(before, 7, 'health', { value: '0' });
    expect(before.get(7)![0].value).toBe('100');
  });
});
