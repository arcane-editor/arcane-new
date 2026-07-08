// Unit coverage for the PURE mapping helpers only. `requestFileDiagnostics`
// itself is LSP-client-coupled (talks to `lspManager`/`LspClient`, which talk
// to Tauri) — that side is manual-verification territory, not Bun-unit-test
// territory (see P3.3 report).

import { describe, it, expect } from 'bun:test';
import { mapLspSeverity, toFileDiag } from './diagnostics';

describe('mapLspSeverity', () => {
  it('maps 1-4 to error/warning/info/hint', () => {
    expect(mapLspSeverity(1)).toBe('error');
    expect(mapLspSeverity(2)).toBe('warning');
    expect(mapLspSeverity(3)).toBe('info');
    expect(mapLspSeverity(4)).toBe('hint');
  });

  it('defaults undefined severity to info (LSP omits severity ⇒ implied Error per spec, but we mirror providers.ts and default to info)', () => {
    expect(mapLspSeverity(undefined)).toBe('info');
  });

  it('falls back to info for an out-of-range severity number', () => {
    expect(mapLspSeverity(99)).toBe('info');
  });
});

describe('toFileDiag', () => {
  it('maps range/severity/message/code, converting to a 1-based line', () => {
    const raw = {
      range: { start: { line: 41, character: 3 } },
      severity: 1,
      code: 'CS1061',
      message: "'Rigidbody' does not contain a definition for 'Fly'",
    };
    expect(toFileDiag(raw)).toEqual({
      line: 42,
      severity: 'error',
      message: "'Rigidbody' does not contain a definition for 'Fly'",
      code: 'CS1061',
    });
  });

  it('stringifies a numeric code', () => {
    const raw = { range: { start: { line: 0, character: 0 } }, severity: 2, code: 169, message: 'unused' };
    expect(toFileDiag(raw).code).toBe('169');
  });

  it('omits code when absent', () => {
    const raw = { range: { start: { line: 0, character: 0 } }, severity: 1, message: 'boom' };
    expect(toFileDiag(raw).code).toBeUndefined();
  });
});
