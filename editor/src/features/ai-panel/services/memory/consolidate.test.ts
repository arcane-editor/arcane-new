import { describe, it, expect } from 'bun:test';
import {
  parseConsolidationPlan,
  applyConsolidationPlan,
  maybeConsolidate,
  CONSOLIDATION_THRESHOLD,
} from './consolidate';
import { loadEntries, upsertEntry } from './memory-store';
import { memoryDir, type MemoryFs } from './memory-types';

function memFs(): MemoryFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async read(path) {
      const v = files.get(path);
      if (v === undefined) throw new Error('ENOENT');
      return v;
    },
    async write(path, content) {
      files.set(path, content);
    },
    async list(dir) {
      const prefix = `${dir}/`;
      return [...files.keys()].filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length));
    },
    async remove(path) {
      files.delete(path);
    },
    async mkdirp() {},
  };
}

const WS = '/ws';
const today = () => '2026-08-15';

describe('memory consolidation', () => {
  it('parses a plan, dropping unknown slugs and empty plans', () => {
    const valid = new Set(['a', 'b', 'c']);
    const plan = parseConsolidationPlan(
      '{"merge": [{"into": {"category": "gotcha", "title": "T", "body": "B"}, "remove": ["a", "zzz"]}], "delete": ["c", "nope"]}',
      valid,
    )!;
    expect(plan.merge[0].remove).toEqual(['a']);
    expect(plan.delete).toEqual(['c']);

    expect(parseConsolidationPlan('{"merge": [], "delete": []}', valid)).toBeNull();
    expect(parseConsolidationPlan('garbage', valid)).toBeNull();
    // a merge whose removes are all unknown is dropped entirely
    expect(
      parseConsolidationPlan(
        '{"merge": [{"into": {"category": "gotcha", "title": "T", "body": "B"}, "remove": ["zzz"]}], "delete": []}',
        valid,
      ),
    ).toBeNull();
  });

  it('applies deletes and merges through the store', async () => {
    const fs = memFs();
    await upsertEntry(fs, WS, { category: 'gotcha', title: 'Shader quirk alpha', body: 'a' }, today);
    await upsertEntry(fs, WS, { category: 'gotcha', title: 'Shader quirk beta', body: 'b' }, today);
    await upsertEntry(fs, WS, { category: 'gotcha', title: 'Old finished migration task', body: 'c' }, today);
    const slugs = (await loadEntries(fs, WS)).map((e) => e.slug);

    await applyConsolidationPlan(
      fs,
      WS,
      {
        merge: [
          {
            into: { category: 'gotcha', title: 'Shader alpha quirks combined', body: 'a+b' },
            remove: slugs.filter((s) => s.includes('shader')),
          },
        ],
        delete: slugs.filter((s) => s.includes('migration')),
      },
      today,
    );

    const after = await loadEntries(fs, WS);
    expect(after.length).toBe(1);
    expect(after[0].title).toBe('Shader alpha quirks combined');
  });

  it('maybeConsolidate only fires past the threshold and survives garbage replies', async () => {
    const fs = memFs();
    let calls = 0;
    const request = async () => {
      calls++;
      return 'not json';
    };
    // Below threshold → no call.
    await upsertEntry(fs, WS, { category: 'decision', title: 'Solo entry', body: 'x' }, today);
    await maybeConsolidate({ fs, workspacePath: WS, request, today });
    expect(calls).toBe(0);

    // Push one category past the threshold with distinct titles.
    const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa',
      'lambda', 'omicron', 'sigma', 'tau', 'upsilon', 'phi', 'chi', 'psi', 'omega', 'nova',
      'pulsar', 'quasar', 'nebula', 'comet', 'meteor'];
    for (let i = 0; i <= CONSOLIDATION_THRESHOLD; i++) {
      await upsertEntry(fs, WS, { category: 'gotcha', title: `Quirk ${words[i]} subsystem`, body: 'b' }, today);
    }
    await maybeConsolidate({ fs, workspacePath: WS, request, today });
    expect(calls).toBe(1); // fired for gotcha only; garbage reply changed nothing
    expect((await loadEntries(fs, WS)).length).toBe(CONSOLIDATION_THRESHOLD + 2);
  });
});

describe('memory dir helper', () => {
  it('lives under Library/UnityIDE', () => {
    expect(memoryDir('/ws')).toBe('/ws/Library/UnityIDE/memory');
  });
});
