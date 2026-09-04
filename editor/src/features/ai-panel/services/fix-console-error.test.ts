import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// `fix-console-error.ts` cannot be imported under Bun: it reaches
// `stores/ai.ts` and `stores/workspace.ts`, both DOM-bound (Global Constraint
// 4). The prompt text it produces is pinned byte-for-byte in
// `prompts/console-repair.test.ts` against the pure builder; what this file
// pins is that `fix-console-error.ts` actually DELEGATES to that builder
// rather than keeping a second copy of the prompt that could drift.
const SRC = readFileSync(path.resolve(import.meta.dir, './fix-console-error.ts'), 'utf8');

describe('fix-console-error.ts — prompt assembly is not duplicated (Task 13)', () => {
  it('imports the shared builder instead of assembling the prompt itself', () => {
    expect(SRC).toContain("import { buildFixPrompt } from './prompts/console-repair';");
    expect(SRC).toContain('await buildFixPrompt(entry, tauriRegionDeps())');
  });

  it('keeps no copy of the prompt text, the region markup or the context window', () => {
    // Every literal the old in-file assembly owned. If any of these reappear
    // here, there are two prompts again and only one of them is pinned.
    expect(SRC).not.toContain('Fix this Unity console');
    expect(SRC).not.toContain('<region path=');
    expect(SRC).not.toContain('No in-project stack frames resolved');
    expect(SRC).not.toContain('CONTEXT_LINES');
    expect(SRC).not.toContain('parseStackTrace');
  });

  it('shares the production region reader with the console check rather than re-declaring it', () => {
    expect(SRC).toContain("import { tauriRegionDeps } from './console-check-io';");
    expect(SRC).toContain('buildFixPrompt(entry, tauriRegionDeps())');
    // The reader itself lives in the io module; two copies would be two ways to
    // resolve a project-relative frame path.
    expect(SRC).not.toContain("invoke<string>('read_file'");
    const IO = readFileSync(path.resolve(import.meta.dir, './console-check-io.ts'), 'utf8');
    expect(IO).toContain("readFile: (path) => invoke<string>('read_file', { path }),");
    expect(IO).toContain('workspacePath: useWorkspaceStore.getState().workspacePath,');
  });

  // `buildRegions` grew a `dedupe` option for the console check's repair
  // prompt. It must stay OFF here: the pre-extraction code emitted one region
  // per frame, recursion included, and that prompt is byte-pinned.
  it('does not turn on region de-duplication, which would change the pinned prompt', () => {
    expect(SRC).not.toMatch(/dedupe:\s*true/);
  });

  it('still sends at the user\'s current effort in agent mode, never a hardcoded tier', () => {
    expect(SRC).toContain('const effort = useAiStore.getState().effort;');
    expect(SRC).toContain("sendMessage(prompt, { mode: 'agent', effort })");
  });
});
