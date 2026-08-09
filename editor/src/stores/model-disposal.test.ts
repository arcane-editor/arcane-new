import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const STORE = readFileSync(path.resolve(import.meta.dir, 'workspace.ts'), 'utf8');

/** The body of the `closeFile` action, up to the next top-level store action. */
function closeFileBody(source: string): string {
  const start = source.indexOf('closeFile: (path: string) => {');
  if (start === -1) throw new Error('closeFile action not found — has it been renamed?');
  const next = source.indexOf('\n  popRecentlyClosed:', start);
  return source.slice(start, next === -1 ? start + 2000 : next);
}

/**
 * Closing a tab left its Monaco model alive, still holding whatever the user
 * had typed — including changes they explicitly discarded at the
 * "Close Anyway" prompt. A later project-wide LSP rename that touched the same
 * file found the orphan via findModelForUri and wrote the whole buffer to disk,
 * reverting the file to the discarded version and clobbering anything Unity or
 * git had written since.
 */
describe('closeFile', () => {
  it('disposes the Monaco model for the closed path', () => {
    expect(closeFileBody(STORE)).toMatch(/disposeModelForPath\(/);
  });

  it('disposes only after telling the language server the document closed', () => {
    const body = closeFileBody(STORE);
    const close = body.indexOf('syncDocumentClose');
    const dispose = body.indexOf('disposeModelForPath');
    expect(close).toBeGreaterThan(-1);
    expect(dispose).toBeGreaterThan(close);
  });
});
