// Guards the fix for a real production hazard: `setFileDiagnostics` recomputes
// counts by flattening AND sorting the whole diagnostics map on every call, so
// publishing solution-wide results one file at a time is quadratic — thousands
// of full-map sorts on the main thread, plus one re-render each.
//
// Source-text assertions because the store module transitively touches
// `document` and cannot be imported here (same reason as debug-variables).

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';

const UI = readFileSync('src/stores/ui.ts', 'utf8');
const WD = readFileSync('src/features/lsp/services/workspace-diagnostics.ts', 'utf8');

describe('solution-wide diagnostics publishing', () => {
  it('the store exposes a batch publish action', () => {
    expect(UI).toContain('setManyFileDiagnostics');
  });

  it('the batch action recomputes counts exactly once', () => {
    const start = UI.indexOf('setManyFileDiagnostics: (entries)');
    expect(start).toBeGreaterThan(-1);
    const body = UI.slice(start, UI.indexOf('clearFileDiagnostics:', start));
    // One recompute and one set() for the whole batch — not one per file.
    expect(body.match(/recomputeCounts\(/g) ?? []).toHaveLength(1);
    expect(body.match(/\bset\(\(state\)/g) ?? []).toHaveLength(1);
  });

  it('workspace diagnostics publish via the batch action, never per file', () => {
    expect(WD).toContain('setManyFileDiagnostics');
    // The per-file call inside a loop is the regression this guards against.
    expect(WD).not.toContain('setFileDiagnostics(');
  });
});

describe('asset-usage CodeLens caching', () => {
  const CL = readFileSync('src/features/unity-context/services/usage-codelens.ts', 'utf8');

  it('the lens calls the cached helper, and the raw invoke lives only inside it', () => {
    // Monaco re-runs provideCodeLenses on every model change, and the command
    // reads and parses every asset referencing the script. An uncached call
    // from the lens body re-parses hundreds of assets per keystroke.
    const body = CL.slice(CL.indexOf('async provideCodeLenses('));
    expect(body).toContain('getMethodUsages(');
    expect(body).not.toContain("invoke<MethodUsage[]>");
    // Exactly one raw invoke in the file — the one the cache wraps.
    expect(CL.match(/invoke<MethodUsage\[\]>/g) ?? []).toHaveLength(1);
  });

  it('the cache is invalidated by incremental deltas, not only full rebuilds', () => {
    expect(CL).toContain('indexRevision');
    expect(CL).toContain('methodCache.clear()');
  });
});
