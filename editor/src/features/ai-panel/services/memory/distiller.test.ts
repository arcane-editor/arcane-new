import { describe, it, expect } from 'bun:test';
import { buildDistillerPrompt, parseDistillerReply, distillSend } from './distiller';
import { loadEntries, readTaskContext } from './memory-store';
import type { MemoryFs } from './memory-types';

function memFs(): MemoryFs {
  const files = new Map<string, string>();
  return {
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

describe('memory distiller', () => {
  it('prompt embeds and truncates the session inputs', () => {
    const prompt = buildDistillerPrompt({
      userPrompt: 'u'.repeat(2000),
      finalAssistantText: 'a'.repeat(5000),
      touchedFiles: ['Assets/A.cs'],
    });
    expect(prompt).toContain('Assets/A.cs');
    expect(prompt).toContain('u'.repeat(1000));
    expect(prompt).not.toContain('u'.repeat(1001));
    expect(prompt).toContain('"facts"');
  });

  it('parses a valid reply, dropping junk facts and capping at 2', () => {
    const out = parseDistillerReply(`Sure! Here you go:
{"facts": [
  {"category": "decision", "title": "Use Addressables", "body": "Chosen for memory."},
  {"category": "nonsense", "title": "bad", "body": "bad"},
  {"category": "gotcha", "title": "Meta files", "body": "Never hand-author."},
  {"category": "gotcha", "title": "Extra", "body": "beyond cap"}
], "taskContext": "Building coin pickup."}`)!;
    // Junk is dropped first, THEN the cap applies: decision + first gotcha.
    expect(out.facts.map((f) => f.title)).toEqual(['Use Addressables', 'Meta files']);
    expect(out.taskContext).toBe('Building coin pickup.');
  });

  it('returns null on malformed replies', () => {
    expect(parseDistillerReply('no json at all')).toBeNull();
    expect(parseDistillerReply('{broken')).toBeNull();
  });

  it('distillSend writes facts + task context through the store', async () => {
    const fs = memFs();
    await distillSend(
      { userPrompt: 'add coins', finalAssistantText: 'done', touchedFiles: [] },
      {
        request: async () =>
          '{"facts": [{"category": "convention", "title": "Coins live under Assets/Coins", "body": "Team layout."}], "taskContext": "Coin pickup done; VFX remains."}',
        fs,
        workspacePath: '/ws',
        today: () => '2026-08-15',
      },
    );
    const entries = await loadEntries(fs, '/ws');
    expect(entries.length).toBe(1);
    expect(entries[0].category).toBe('convention');
    expect(await readTaskContext(fs, '/ws')).toContain('VFX remains');
  });

  it('distillSend swallows request failures', async () => {
    const fs = memFs();
    await distillSend(
      { userPrompt: 'x', finalAssistantText: 'y', touchedFiles: [] },
      {
        request: async () => {
          throw new Error('network');
        },
        fs,
        workspacePath: '/ws',
      },
    );
    expect(await loadEntries(fs, '/ws')).toEqual([]);
  });
});
