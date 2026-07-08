import { describe, it, expect } from 'bun:test';
import { runRestorePlan, filterAppliedRestoreEntries, type ApplyRestoreDeps } from './apply-restore';
import type { RestorePlanEntry } from './restore-plan';

function fakeDeps(overrides: Partial<ApplyRestoreDeps> = {}): {
  deps: ApplyRestoreDeps;
  calls: { deletePath: string[]; writeFile: string[]; coDeleteMeta: string[] };
} {
  const calls = { deletePath: [] as string[], writeFile: [] as string[], coDeleteMeta: [] as string[] };
  const deps: ApplyRestoreDeps = {
    deletePath: async (path) => {
      calls.deletePath.push(path);
    },
    writeFile: async (path) => {
      calls.writeFile.push(path);
    },
    coDeleteMeta: async (path) => {
      calls.coDeleteMeta.push(path);
    },
    ...overrides,
  };
  return { deps, calls };
}

describe('runRestorePlan', () => {
  it('returns empty applied/failed for an empty plan', async () => {
    const { deps } = fakeDeps();
    expect(await runRestorePlan([], deps)).toEqual({ applied: [], failed: [] });
  });

  it('applies a write entry via writeFile and reports it as applied', async () => {
    const { deps, calls } = fakeDeps();
    const plan: RestorePlanEntry[] = [{ path: '/a', action: 'write', content: 'hello' }];

    const result = await runRestorePlan(plan, deps);

    expect(result).toEqual({ applied: ['/a'], failed: [] });
    expect(calls.writeFile).toEqual(['/a']);
  });

  it('applies a delete entry via deletePath + coDeleteMeta and reports it as applied', async () => {
    const { deps, calls } = fakeDeps();
    const plan: RestorePlanEntry[] = [{ path: '/a', action: 'delete' }];

    const result = await runRestorePlan(plan, deps);

    expect(result).toEqual({ applied: ['/a'], failed: [] });
    expect(calls.deletePath).toEqual(['/a']);
    expect(calls.coDeleteMeta).toEqual(['/a']);
  });

  it('a failing write entry lands in `failed`, not `applied` — and processing continues to later entries', async () => {
    const { deps, calls } = fakeDeps({
      writeFile: async (path) => {
        if (path === '/bad') throw new Error('disk full');
        calls.writeFile.push(path);
      },
    });
    const plan: RestorePlanEntry[] = [
      { path: '/bad', action: 'write', content: 'x' },
      { path: '/good', action: 'write', content: 'y' },
    ];

    const result = await runRestorePlan(plan, deps);

    expect(result.failed).toEqual(['/bad']);
    expect(result.applied).toEqual(['/good']);
  });

  it('a failing delete lands in `failed` and does NOT call coDeleteMeta', async () => {
    const { deps, calls } = fakeDeps({
      deletePath: async () => {
        throw new Error('permission denied');
      },
    });
    const plan: RestorePlanEntry[] = [{ path: '/a', action: 'delete' }];

    const result = await runRestorePlan(plan, deps);

    expect(result).toEqual({ applied: [], failed: ['/a'] });
    expect(calls.coDeleteMeta).toEqual([]);
  });

  it('a failing coDeleteMeta does NOT mark the path as failed (best-effort side channel)', async () => {
    const { deps, calls } = fakeDeps({
      coDeleteMeta: async () => {
        throw new Error('meta not found');
      },
    });
    const plan: RestorePlanEntry[] = [{ path: '/a', action: 'delete' }];

    const result = await runRestorePlan(plan, deps);

    expect(result).toEqual({ applied: ['/a'], failed: [] });
    expect(calls.deletePath).toEqual(['/a']);
  });
});

describe('filterAppliedRestoreEntries', () => {
  it('returns [] for an empty plan', () => {
    expect(filterAppliedRestoreEntries([], ['/a'])).toEqual([]);
  });

  it('keeps only entries whose path is in `applied`', () => {
    const plan: RestorePlanEntry[] = [
      { path: '/a', action: 'write', content: 'x' },
      { path: '/b', action: 'delete' },
    ];

    expect(filterAppliedRestoreEntries(plan, ['/a'])).toEqual([{ path: '/a', action: 'write', content: 'x' }]);
  });

  it('excludes a failed delete entirely — so a caller like refreshAfterRestore never sees it and cannot close its tab', () => {
    const plan: RestorePlanEntry[] = [{ path: '/failed-delete', action: 'delete' }];

    expect(filterAppliedRestoreEntries(plan, [])).toEqual([]);
  });

  it('returns [] when nothing applied', () => {
    const plan: RestorePlanEntry[] = [{ path: '/a', action: 'write', content: 'x' }];
    expect(filterAppliedRestoreEntries(plan, [])).toEqual([]);
  });
});
