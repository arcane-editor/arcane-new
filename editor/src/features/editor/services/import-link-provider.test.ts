import { describe, it, expect, beforeEach, mock } from 'bun:test';

// import-link-provider.ts pulls in `useWorkspaceStore`, which (transitively,
// via the editor/theme/git/... barrels it imports) touches `document` at
// module-eval time — fine in the real Tauri webview, fatal under plain
// `bun test` (no DOM). Mock both the workspace store and the Tauri `invoke`
// bridge *before* dynamically importing the module under test, so its real
// import graph is never loaded. Static imports are hoisted above these
// statements, so the mocks must be registered first and the module under
// test imported via a dynamic `import()` afterwards (same pattern as
// features/ai-panel/services/arcane-stream.test.ts).
type WorkspaceListener = (state: { workspacePath: string | null }) => void;

let workspaceState: { workspacePath: string | null } = { workspacePath: '/ws' };
let workspaceListeners: WorkspaceListener[] = [];

mock.module('../../../stores/workspace', () => ({
  useWorkspaceStore: {
    getState: () => workspaceState,
    subscribe: (fn: WorkspaceListener) => {
      workspaceListeners.push(fn);
      return () => {
        workspaceListeners = workspaceListeners.filter((l) => l !== fn);
      };
    },
  },
}));

function setWorkspacePath(path: string | null): void {
  workspaceState = { workspacePath: path };
  for (const listener of workspaceListeners) listener(workspaceState);
}

let invokeCalls: Array<{ cmd: string; path: string }> = [];
let existingPaths = new Set<string>();

mock.module('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args: { path: string }) => {
    invokeCalls.push({ cmd, path: args.path });
    if (cmd === 'path_exists') return existingPaths.has(args.path);
    throw new Error(`unexpected invoke command: ${cmd}`);
  },
}));

const { extractSpecifiers, buildCandidateSpecifiers, resolveSpecifier } = await import(
  './import-link-provider'
);

/** Column of the first char of `needle` within `line` (1-based, Monaco-style). */
function colOf(line: string, needle: string): number {
  const idx = line.indexOf(needle);
  if (idx < 0) throw new Error(`"${needle}" not found in "${line}"`);
  return idx + 1;
}

describe('extractSpecifiers', () => {
  it('finds a static "from" import with single quotes', () => {
    const line = "import Foo from './foo';";
    const result = extractSpecifiers(line);
    expect(result).toEqual([
      { spec: './foo', startCol: colOf(line, './foo'), endCol: colOf(line, './foo') + './foo'.length },
    ]);
  });

  it('finds a static "from" import with double quotes', () => {
    const line = 'import Foo from "../bar";';
    const result = extractSpecifiers(line);
    expect(result).toEqual([
      { spec: '../bar', startCol: colOf(line, '../bar'), endCol: colOf(line, '../bar') + '../bar'.length },
    ]);
  });

  it('finds a named/destructured import "from" clause', () => {
    const line = "import { useFoo } from './hooks/useFoo';";
    const result = extractSpecifiers(line);
    expect(result).toEqual([
      {
        spec: './hooks/useFoo',
        startCol: colOf(line, './hooks/useFoo'),
        endCol: colOf(line, './hooks/useFoo') + './hooks/useFoo'.length,
      },
    ]);
  });

  it('finds a type-only "from" import', () => {
    const line = "import type { Foo } from './types';";
    const result = extractSpecifiers(line);
    expect(result).toEqual([
      { spec: './types', startCol: colOf(line, './types'), endCol: colOf(line, './types') + './types'.length },
    ]);
  });

  it('finds a re-export "from" clause', () => {
    const line = "export * from './bar';";
    const result = extractSpecifiers(line);
    expect(result.map((s) => s.spec)).toEqual(['./bar']);
  });

  it('finds a dynamic import()', () => {
    const line = "const mod = await import('./lazy');";
    const result = extractSpecifiers(line);
    expect(result).toEqual([
      { spec: './lazy', startCol: colOf(line, './lazy'), endCol: colOf(line, './lazy') + './lazy'.length },
    ]);
  });

  it('finds a require() call', () => {
    const line = "const foo = require('./req');";
    const result = extractSpecifiers(line);
    expect(result).toEqual([
      { spec: './req', startCol: colOf(line, './req'), endCol: colOf(line, './req') + './req'.length },
    ]);
  });

  it('finds a side-effect import (no "from")', () => {
    const line = "import './side-effect';";
    const result = extractSpecifiers(line);
    expect(result).toEqual([
      {
        spec: './side-effect',
        startCol: colOf(line, './side-effect'),
        endCol: colOf(line, './side-effect') + './side-effect'.length,
      },
    ]);
  });

  it('does not double-count a side-effect import as a dynamic import', () => {
    const line = "import './side-effect';";
    const result = extractSpecifiers(line);
    expect(result.length).toBe(1);
  });

  it('does not confuse a value import with a side-effect import', () => {
    const line = "import Foo from './foo';";
    const result = extractSpecifiers(line);
    // Only the "from" clause should match, not a bogus "import 'Foo'"-shaped match.
    expect(result.length).toBe(1);
    expect(result[0].spec).toBe('./foo');
  });

  it('skips bare (npm package) specifiers', () => {
    const line = "import React from 'react';";
    expect(extractSpecifiers(line)).toEqual([]);
  });

  it('skips tsconfig path-alias specifiers', () => {
    const line = "import { cn } from '@/utils';";
    expect(extractSpecifiers(line)).toEqual([]);
  });

  it('skips a bare require()', () => {
    const line = "const path = require('path');";
    expect(extractSpecifiers(line)).toEqual([]);
  });

  it('finds multiple specifiers on one line in left-to-right order', () => {
    const line = "import './side-effect'; import Foo from './foo';";
    const result = extractSpecifiers(line);
    expect(result.map((s) => s.spec)).toEqual(['./side-effect', './foo']);
    // Ordered by ascending column.
    expect(result[0].startCol).toBeLessThan(result[1].startCol);
  });

  it('returns an empty array for a line with no imports', () => {
    expect(extractSpecifiers('const x = 1;')).toEqual([]);
  });

  it('returns an empty array for an empty line', () => {
    expect(extractSpecifiers('')).toEqual([]);
  });

  it('skips a pathologically long line (e.g. a minified bundle) rather than scanning it', () => {
    const padding = 'x'.repeat(6000);
    const line = `import Foo from './foo'; ${padding}`;
    expect(extractSpecifiers(line)).toEqual([]);
  });
});

describe('buildCandidateSpecifiers', () => {
  it('orders candidates: as-is, then extensions, then index files', () => {
    expect(buildCandidateSpecifiers('./foo')).toEqual([
      './foo',
      './foo.ts',
      './foo.tsx',
      './foo.js',
      './foo.jsx',
      './foo.mjs',
      './foo.cjs',
      './foo/index.ts',
      './foo/index.tsx',
      './foo/index.js',
      './foo/index.jsx',
    ]);
  });

  it('preserves the ../ prefix', () => {
    const candidates = buildCandidateSpecifiers('../shared/util');
    expect(candidates[0]).toBe('../shared/util');
    expect(candidates).toContain('../shared/util.ts');
    expect(candidates).toContain('../shared/util/index.ts');
  });

  it('still tries the literal spec first when it already has an extension', () => {
    const candidates = buildCandidateSpecifiers('./foo.ts');
    expect(candidates[0]).toBe('./foo.ts');
  });

  it('returns no candidates for a bare specifier', () => {
    expect(buildCandidateSpecifiers('react')).toEqual([]);
  });

  it('returns no candidates for a scoped/bare specifier', () => {
    expect(buildCandidateSpecifiers('@scope/pkg')).toEqual([]);
  });

  it('returns no candidates for a tsconfig path alias', () => {
    expect(buildCandidateSpecifiers('@/utils')).toEqual([]);
  });
});

describe('resolveSpecifier', () => {
  beforeEach(() => {
    invokeCalls = [];
    existingPaths = new Set();
    workspaceState = { workspacePath: '/ws' };
    // resolveSpecifier's cache is module-scoped and would otherwise leak
    // resolutions across tests; force a workspace-path "change" so the
    // subscription (registered as a side effect of the first resolve call
    // below) clears it. Harmless before the subscription exists too.
    setWorkspacePath(`/ws-reset-${Math.random()}`);
    setWorkspacePath('/ws');
  });

  it('resolves the literal spec when it exists', async () => {
    existingPaths.add('/ws/src/foo.ts');
    const target = await resolveSpecifier('/ws/src/current.ts', './foo.ts');
    expect(target).toBe('/ws/src/foo.ts');
  });

  it('falls through candidates in order until one exists', async () => {
    existingPaths.add('/ws/src/foo.tsx');
    const target = await resolveSpecifier('/ws/src/current.ts', './foo');
    expect(target).toBe('/ws/src/foo.tsx');
    // Probed "as-is" and ".ts" before landing on ".tsx".
    expect(invokeCalls.map((c) => c.path)).toEqual([
      '/ws/src/foo',
      '/ws/src/foo.ts',
      '/ws/src/foo.tsx',
    ]);
  });

  it('resolves a directory import via /index.ts', async () => {
    existingPaths.add('/ws/src/components/index.ts');
    const target = await resolveSpecifier('/ws/src/current.ts', './components');
    expect(target).toBe('/ws/src/components/index.ts');
  });

  it('normalizes ../ segments against the current file dir', async () => {
    existingPaths.add('/ws/shared/util.ts');
    const target = await resolveSpecifier('/ws/src/current.ts', '../shared/util');
    expect(target).toBe('/ws/shared/util.ts');
  });

  it('returns null when no candidate exists', async () => {
    const target = await resolveSpecifier('/ws/src/current.ts', './missing');
    expect(target).toBeNull();
  });

  it('returns null for a bare specifier without any IPC calls', async () => {
    const target = await resolveSpecifier('/ws/src/current.ts', 'react');
    expect(target).toBeNull();
    expect(invokeCalls).toEqual([]);
  });

  it('caches a resolution and does not re-invoke on a repeat lookup', async () => {
    existingPaths.add('/ws/src/foo.ts');
    await resolveSpecifier('/ws/src/current.ts', './foo.ts');
    const callsAfterFirst = invokeCalls.length;
    const second = await resolveSpecifier('/ws/src/current.ts', './foo.ts');
    expect(second).toBe('/ws/src/foo.ts');
    expect(invokeCalls.length).toBe(callsAfterFirst);
  });

  it('caches a miss and does not re-invoke on a repeat lookup', async () => {
    await resolveSpecifier('/ws/src/current.ts', './missing');
    const callsAfterFirst = invokeCalls.length;
    await resolveSpecifier('/ws/src/current.ts', './missing');
    expect(invokeCalls.length).toBe(callsAfterFirst);
  });

  it('invalidates the cache when the workspace path changes', async () => {
    existingPaths.add('/ws/src/foo.ts');
    await resolveSpecifier('/ws/src/current.ts', './foo.ts');
    const callsAfterFirst = invokeCalls.length;

    setWorkspacePath('/other-ws');

    await resolveSpecifier('/ws/src/current.ts', './foo.ts');
    expect(invokeCalls.length).toBeGreaterThan(callsAfterFirst);
  });
});
