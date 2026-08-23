import { describe, it, expect } from 'bun:test';
import { parseFileRef } from './file-ref';

describe('parseFileRef — accepts real file references', () => {
  it('takes a workspace-relative path', () => {
    expect(parseFileRef('src/features/ai-panel/components/ChatInput.tsx')).toEqual({
      path: 'src/features/ai-panel/components/ChatInput.tsx',
    });
  });

  it('takes a bare filename with a known extension', () => {
    expect(parseFileRef('ChatInput.tsx')).toEqual({ path: 'ChatInput.tsx' });
    expect(parseFileRef('wrangler.toml')).toEqual({ path: 'wrangler.toml' });
  });

  it('takes Unity asset extensions, which is most of what this project edits', () => {
    for (const p of ['Assets/Player.prefab', 'Assets/Main.unity', 'Assets/Lit.shader']) {
      expect(parseFileRef(p)?.path).toBe(p);
    }
  });

  it('takes relative prefixes and alias paths', () => {
    expect(parseFileRef('./stage-file.ts')?.path).toBe('./stage-file.ts');
    expect(parseFileRef('../../stores/ai.ts')?.path).toBe('../../stores/ai.ts');
    expect(parseFileRef('@/components/Card.tsx')?.path).toBe('@/components/Card.tsx');
  });

  it('takes an absolute path', () => {
    expect(parseFileRef('/Users/x/p/Assets/A.cs')?.path).toBe('/Users/x/p/Assets/A.cs');
  });
});

describe('parseFileRef — line and column suffixes', () => {
  it('splits `path:line` and `path:line:column`', () => {
    expect(parseFileRef('DataTable.tsx:189')).toEqual({ path: 'DataTable.tsx', line: 189 });
    expect(parseFileRef('DataTable.tsx:189:12')).toEqual({
      path: 'DataTable.tsx',
      line: 189,
      column: 12,
    });
  });

  it('splits the `#L12` form', () => {
    expect(parseFileRef('src/App.tsx#L42')).toEqual({ path: 'src/App.tsx', line: 42 });
  });

  it('ignores a nonsense line number rather than dropping the whole ref', () => {
    expect(parseFileRef('App.tsx:0')).toEqual({ path: 'App.tsx' });
    expect(parseFileRef('App.tsx:-3')).toEqual({ path: 'App.tsx' });
  });
});

describe('parseFileRef — rejects everything else', () => {
  /**
   * False positives are the entire risk of this feature. Assistant prose is
   * dense with inline code that is NOT a path, and turning `useState` into a
   * clickable file chip that opens nothing is worse than rendering no chips at
   * all.
   */
  it('rejects bare identifiers and expressions', () => {
    for (const s of ['useState', 'foo', 'AgentKind', 'a.b', 'obj.method()', 'Math.max(1, 2)']) {
      expect(parseFileRef(s)).toBeNull();
    }
  });

  it('rejects a dotted name whose suffix is not a file extension', () => {
    // `window.location` and `props.children` are the common shape here.
    expect(parseFileRef('window.location')).toBeNull();
    expect(parseFileRef('props.children')).toBeNull();
  });

  it('rejects URLs', () => {
    expect(parseFileRef('https://example.com/a.ts')).toBeNull();
    expect(parseFileRef('mailto:a@b.com')).toBeNull();
  });

  it('rejects shell flags, globs and anything with whitespace', () => {
    for (const s of ['--noEmit', 'src/**/*.ts', 'bun run verify', 'a b.ts', '']) {
      expect(parseFileRef(s)).toBeNull();
    }
  });

  it('rejects a directory with no extension', () => {
    // Conservative on purpose: opening a directory is not a thing openFile does.
    expect(parseFileRef('src/features/ai-panel')).toBeNull();
  });

  it('rejects absurdly long input without scanning it', () => {
    expect(parseFileRef('a/'.repeat(500) + 'b.ts')).toBeNull();
  });
});
