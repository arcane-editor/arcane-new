import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isSuccessfulWrite } from '../write-approval-gate';

// `analyzer-gate.ts` itself can't be imported under Bun (it reaches
// `tool-operations.ts` → the workspace store → the theme store → `document`),
// so the wiring is asserted against its source text — same convention as
// `agent-service-wiring.test.ts` and `session-persistence.test.ts`.
const SRC = readFileSync(path.resolve(import.meta.dir, './analyzer-gate.ts'), 'utf8');

describe('isSuccessfulWrite', () => {
  it('is true only for the vendor tools’ literal success prefix', () => {
    expect(isSuccessfulWrite({ content: [{ type: 'text', text: 'Successfully wrote 12 bytes' }] })).toBe(true);
    expect(isSuccessfulWrite({ content: [{ type: 'text', text: 'Successfully edited A.cs' }] })).toBe(true);
  });

  it('is false for every failure shape the write tools produce', () => {
    const failures = [
      'Error writing file: permission denied',
      "Error: 'x' is outside the allowed project area.",
      'Error: invalid arguments for "write", so the tool was NOT executed.',
      'User rejected this edit to Assets/A.cs',
      'Operation aborted',
      '',
    ];
    for (const text of failures) {
      expect(isSuccessfulWrite({ content: [{ type: 'text', text }] })).toBe(false);
    }
  });

  it('is false when the result carries no text at all', () => {
    expect(isSuccessfulWrite({ content: [] })).toBe(false);
  });
});

describe('withUnityAnalyzerGate wiring', () => {
  // The gate guarded on `isRejectedWrite` alone, so any OTHER failed write
  // still got analyzed — and the `write` branch analyzes `params.content`, the
  // content the model PROPOSED rather than anything on disk. It reported
  // analyzer errors as "introduced by this C# write" for a file never written.
  it('returns early unless the write actually landed', () => {
    expect(SRC).toMatch(/if \(!isSuccessfulWrite\(res\)\) return res;/);
  });

  it('still returns early on an explicitly rejected write', () => {
    expect(SRC).toMatch(/if \(isRejectedWrite\(res\)\) return res;/);
  });

  it('uses the shared predicate rather than a private copy that can drift', () => {
    expect(SRC).toContain("import { isRejectedWrite, isSuccessfulWrite } from '../write-approval-gate';");
    expect(SRC).not.toMatch(/function isSuccessfulWrite/);
  });
});
