import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// `memory-cache.ts` can't be imported under Bun (it reaches the workspace store
// → the theme store → `document`), so the wiring is asserted against its source
// — same convention as `agent-service-wiring.test.ts`.
const SRC = readFileSync(path.resolve(import.meta.dir, './memory-cache.ts'), 'utf8');

describe('memory-cache workspace subscriber', () => {
  // The subscriber has no selector, so it fires on EVERY workspace-store
  // mutation — including the `editedPaths` churn of ordinary typing. Combined
  // with `primeMemory` clearing its in-flight guard in `finally`, that re-scanned
  // the memory directory and re-read every entry while the user typed.
  it('only re-primes when the workspace path actually changed', () => {
    expect(SRC).toMatch(/state\.workspacePath === prev\.workspacePath\) return;/);
  });

  it('takes the previous state, without which the change cannot be detected', () => {
    expect(SRC).toMatch(/useWorkspaceStore\.subscribe\(\(state, prev\) =>/);
  });

  // The guard belongs in the SUBSCRIBER, not in primeMemory: distillation
  // re-primes the same workspace on purpose, and a cached-workspace early
  // return inside primeMemory would silently make that a no-op.
  it('does not add a cached-workspace early return inside primeMemory', () => {
    const body = SRC.slice(SRC.indexOf('export async function primeMemory'), SRC.indexOf('getMemoryDigestSync'));
    expect(body).not.toMatch(/cachedWorkspace === workspacePath\) return/);
  });
});
