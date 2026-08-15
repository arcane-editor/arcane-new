import { describe, it, expect } from 'bun:test';
import {
  loadEntries,
  upsertEntry,
  buildMemoryDigest,
  searchEntries,
  writeTaskContext,
  readTaskContext,
  parseEntry,
  titlesMatch,
  slugify,
} from './memory-store';
import { MEMORY_CAPS, memoryDir, type MemoryFs } from './memory-types';

/** In-memory MemoryFs for tests. */
function memFs(): MemoryFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async read(path) {
      const v = files.get(path);
      if (v === undefined) throw new Error(`ENOENT ${path}`);
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
    async mkdirp() {
      /* no-op */
    },
  };
}

const WS = '/ws';
const today = () => '2026-08-15';

describe('memory store (spec §4)', () => {
  it('round-trips an entry through frontmatter', async () => {
    const fs = memFs();
    await upsertEntry(fs, WS, { category: 'decision', title: 'Use UniTask over coroutines', body: 'Team standard.' }, today);
    const entries = await loadEntries(fs, WS);
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatchObject({
      category: 'decision',
      title: 'Use UniTask over coroutines',
      body: 'Team standard.',
      created: '2026-08-15',
      timesUsed: 1,
      slug: 'use-unitask-over-coroutines',
    });
  });

  it('dedupes: a matching title updates the entry and bumps salience', async () => {
    const fs = memFs();
    await upsertEntry(fs, WS, { category: 'decision', title: 'Use UniTask over coroutines', body: 'v1' }, today);
    const outcome = await upsertEntry(
      fs, WS,
      { category: 'decision', title: 'use UniTask over Coroutines!', body: 'v2 refined' },
      () => '2026-08-16',
    );
    expect(outcome).toBe('updated');
    const entries = await loadEntries(fs, WS);
    expect(entries.length).toBe(1);
    expect(entries[0].body).toBe('v2 refined');
    expect(entries[0].timesUsed).toBe(2);
    expect(entries[0].lastUsed).toBe('2026-08-16');
  });

  it('at the category cap, replaces a never-recalled incumbent or rejects', async () => {
    const fs = memFs();
    // Distinct word sets per title so dedupe never collapses them.
    const subjects = ['shader', 'prefab', 'input', 'physics', 'audio', 'terrain', 'lighting', 'anim', 'navmesh', 'particle',
      'camera', 'canvas', 'sprite', 'tilemap', 'rigging', 'timeline', 'netcode', 'burst', 'jobs', 'ecs',
      'addressable', 'bundle', 'scene', 'editor', 'gizmo', 'inspector', 'serializer', 'coroutine', 'raycast', 'collider'];
    for (let i = 0; i < MEMORY_CAPS.perCategory; i++) {
      await upsertEntry(fs, WS, { category: 'gotcha', title: `Quirk in ${subjects[i]} subsystem`, body: 'b' }, () => `2026-07-${String((i % 27) + 1).padStart(2, '0')}`);
    }
    // All incumbents have timesUsed=1 → oldest gets replaced.
    const outcome = await upsertEntry(fs, WS, { category: 'gotcha', title: 'Brand new discovery abc', body: 'b' }, today);
    expect(outcome).toBe('replaced');
    const entries = await loadEntries(fs, WS);
    expect(entries.filter((e) => e.category === 'gotcha').length).toBe(MEMORY_CAPS.perCategory);

    // Bump everyone to timesUsed >= 2 → nothing evictable → reject.
    for (const e of await loadEntries(fs, WS)) {
      await upsertEntry(fs, WS, { category: e.category, title: e.title, body: e.body }, today);
    }
    const rejected = await upsertEntry(fs, WS, { category: 'gotcha', title: 'Another different fact qqq', body: 'b' }, today);
    expect(rejected).toBe('rejected-cap');
  });

  it('caps entry body size on write', async () => {
    const fs = memFs();
    await upsertEntry(fs, WS, { category: 'convention', title: 'Big one', body: 'x'.repeat(5000) }, today);
    const entries = await loadEntries(fs, WS);
    expect(entries[0].body.length).toBeLessThanOrEqual(MEMORY_CAPS.entryBytes + 1);
  });

  it('digest ranks by salience, respects the char cap, skips empty stores', async () => {
    const fs = memFs();
    await upsertEntry(fs, WS, { category: 'convention', title: 'Tabs not spaces', body: 'style' }, today);
    await upsertEntry(fs, WS, { category: 'decision', title: 'Addressables for loading', body: 'perf call' }, today);
    const entries = await loadEntries(fs, WS);
    const digest = buildMemoryDigest(entries, 2800, today)!;
    // decision (weight 3) ranks above convention (weight 1)
    expect(digest.indexOf('Addressables')).toBeLessThan(digest.indexOf('Tabs'));
    expect(digest).toContain('## Project memory');

    const tiny = buildMemoryDigest(entries, 60, today);
    expect(tiny).toBeNull(); // header alone doesn't count as a digest

    expect(buildMemoryDigest([], 2800, today)).toBeNull();
  });

  it('searchEntries AND-matches keywords across title and body', async () => {
    const fs = memFs();
    await upsertEntry(fs, WS, { category: 'gotcha', title: 'Prefab GUIDs break on rename', body: 'Use meta files.' }, today);
    const entries = await loadEntries(fs, WS);
    expect(searchEntries(entries, 'prefab guid').length).toBe(1);
    expect(searchEntries(entries, 'prefab shader').length).toBe(0);
    expect(searchEntries(entries, '').length).toBe(0);
  });

  it('task context is overwritten, capped, and excluded from entries', async () => {
    const fs = memFs();
    await writeTaskContext(fs, WS, 'Working on coin pickup.');
    await writeTaskContext(fs, WS, 'y'.repeat(9000));
    const text = (await readTaskContext(fs, WS))!;
    expect(text.length).toBeLessThanOrEqual(MEMORY_CAPS.taskContextBytes + 1);
    expect(text).not.toContain('coin pickup'); // overwritten, not appended
    expect(await loadEntries(fs, WS)).toEqual([]);
    expect(fs.files.has(`${memoryDir(WS)}/task-context.md`)).toBe(true);
  });

  it('parseEntry rejects malformed files instead of throwing', () => {
    expect(parseEntry('x', 'no frontmatter')).toBeNull();
    expect(parseEntry('x', '---\ncategory: nonsense\ntitle: t\n---\nbody')).toBeNull();
  });

  it('titlesMatch: exact slug or strong keyword overlap', () => {
    expect(titlesMatch('Use UniTask', 'use unitask')).toBe(true);
    expect(titlesMatch('Prefab GUIDs break on rename', 'prefab guids break when renaming')).toBe(true);
    expect(titlesMatch('Use UniTask', 'Prefer Addressables')).toBe(false);
    expect(slugify('Hello, World!')).toBe('hello-world');
  });
});
