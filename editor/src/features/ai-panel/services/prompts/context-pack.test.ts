import { describe, it, expect } from 'bun:test';
import { buildContextPackText, CONTEXT_PACK_BUDGETS, type AssemblyInfo } from './context-pack';

function asm(name: string, references: string[] = [], isEditorOnly = false): AssemblyInfo {
  return { name, references, isEditorOnly };
}

describe('context pack (spec §3)', () => {
  it('renders assemblies ranked by inbound references, deterministically', () => {
    const inputs = {
      assemblies: [
        asm('Game.Editor', ['Game.Core'], true),
        asm('Game.Core', []),
        asm('Game.UI', ['Game.Core']),
      ],
      keyFiles: [],
      memoryDigest: null,
    };
    const a = buildContextPackText(inputs, 4096)!;
    const b = buildContextPackText(inputs, 4096)!;
    expect(a).toBe(b); // byte-identical across builds
    // Game.Core is referenced twice → listed first.
    const coreIdx = a.indexOf('- Game.Core');
    expect(coreIdx).toBeGreaterThan(-1);
    expect(coreIdx).toBeLessThan(a.indexOf('- Game.Editor (editor-only)'));
    expect(a).toContain('→ refs: Game.Core');
  });

  it('dedupes, sorts, and caps key files', () => {
    const out = buildContextPackText(
      {
        assemblies: [],
        keyFiles: ['b.cs', 'a.cs', 'b.cs'],
        memoryDigest: null,
      },
      4096,
    )!;
    expect(out).toContain('## Key files');
    expect(out.indexOf('- a.cs')).toBeLessThan(out.indexOf('- b.cs'));
    expect(out.match(/- b\.cs/g)?.length).toBe(1);
  });

  it('includes the memory digest section when present', () => {
    const out = buildContextPackText(
      { assemblies: [], keyFiles: [], memoryDigest: '## Project memory\n- prefers UniTask' },
      4096,
    )!;
    expect(out).toContain('prefers UniTask');
  });

  it('returns null with nothing to say', () => {
    expect(buildContextPackText({ assemblies: [], keyFiles: [], memoryDigest: null }, 4096)).toBeNull();
  });

  it('truncates at a line boundary within the budget', () => {
    const assemblies = Array.from({ length: 15 }, (_, i) => asm(`Assembly.Number${i}.WithALongName`, []));
    const out = buildContextPackText({ assemblies, keyFiles: [], memoryDigest: null }, 200)!;
    expect(out.length).toBeLessThanOrEqual(201); // budget + ellipsis line
    expect(out.endsWith('…')).toBe(true);
    // No half-line: every content line is complete.
    const lines = out.split('\n');
    expect(lines[lines.length - 1]).toBe('…');
  });

  it('budget table covers every effort tier', () => {
    expect(CONTEXT_PACK_BUDGETS.low).toBeLessThan(CONTEXT_PACK_BUDGETS.mid);
    expect(CONTEXT_PACK_BUDGETS.mid).toBeLessThan(CONTEXT_PACK_BUDGETS.high);
  });
});
