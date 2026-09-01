// The dangerous cases here are both silent: applying an `unchanged` report
// would WIPE a file's diagnostics, and applying a report for an open document
// would clobber fresher per-keystroke results with a stale snapshot.

import { describe, it, expect } from 'bun:test';
import {
  toDiagnosticItems,
  selectApplicableReports,
  MAX_ITEMS_PER_FILE,
  type RawWorkspaceReport,
} from './workspace-diagnostics';

describe('toDiagnosticItems', () => {
  it('returns [] for missing or empty item lists', () => {
    expect(toDiagnosticItems('file:///A.cs', undefined)).toEqual([]);
    expect(toDiagnosticItems('file:///A.cs', [])).toEqual([]);
  });

  it('converts 0-based LSP positions to the 1-based pair the panel shows', () => {
    const items = toDiagnosticItems('file:///proj/Assets/A.cs', [
      {
        range: { start: { line: 9, character: 4 } },
        severity: 1,
        code: 'CS0103',
        message: "The name 'foo' does not exist",
      },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].line).toBe(10);
    expect(items[0].col).toBe(5);
    expect(items[0].severity).toBe('error');
    expect(items[0].fileName).toBe('A.cs');
    expect(items[0].source).toBe('lsp');
  });

  it('maps every severity, defaulting an absent one to info', () => {
    const sev = (s?: number) =>
      toDiagnosticItems('file:///A.cs', [
        { range: { start: { line: 0, character: 0 } }, severity: s, message: 'm' },
      ])[0].severity;
    expect(sev(1)).toBe('error');
    expect(sev(2)).toBe('warning');
    expect(sev(3)).toBe('info');
    expect(sev(4)).toBe('hint');
    expect(sev(undefined)).toBe('info');
    expect(sev(99)).toBe('info');
  });
});

describe('selectApplicableReports', () => {
  const report = (uri: string, extra: Partial<RawWorkspaceReport> = {}): RawWorkspaceReport => ({
    uri,
    kind: 'full',
    items: [],
    ...extra,
  });

  // 'unchanged' carries NO items. Applying it would clear that file's
  // diagnostics and report a clean project that isn't.
  it('drops unchanged reports rather than clearing those files', () => {
    const out = selectApplicableReports(
      [report('file:///A.cs'), report('file:///B.cs', { kind: 'unchanged' })],
      new Set(),
    );
    expect(out.map((r) => r.uri)).toEqual(['file:///A.cs']);
  });

  // The per-document pull re-runs on every keystroke and is strictly fresher.
  it('skips documents that are currently open', () => {
    const out = selectApplicableReports(
      [report('file:///A.cs'), report('file:///Open.cs')],
      new Set(['file:///Open.cs']),
    );
    expect(out.map((r) => r.uri)).toEqual(['file:///A.cs']);
  });

  it('drops reports with no uri', () => {
    expect(selectApplicableReports([report('')], new Set())).toEqual([]);
  });
});

describe('per-file diagnostic cap', () => {
  const many = (n: number, severity: number) =>
    Array.from({ length: n }, (_, i) => ({
      range: { start: { line: i, character: 0 } },
      severity,
      message: `m${i}`,
    }));

  it('keeps everything below the cap untouched', () => {
    expect(toDiagnosticItems('file:///A.cs', many(10, 1))).toHaveLength(10);
  });

  // The file cap alone does not bound memory: one generated file can carry
  // tens of thousands of diagnostics, and the panel renders every one.
  it('truncates a pathological file to the cap', () => {
    const out = toDiagnosticItems('file:///A.cs', many(MAX_ITEMS_PER_FILE + 5000, 2));
    expect(out).toHaveLength(MAX_ITEMS_PER_FILE);
  });

  // Truncation must not silently drop the errors and keep the hints.
  it('keeps errors when it truncates, not whatever came first', () => {
    const warnings = many(MAX_ITEMS_PER_FILE, 2);
    const errors = many(3, 1).map((d, i) => ({ ...d, message: `err${i}` }));
    const out = toDiagnosticItems('file:///A.cs', [...warnings, ...errors]);
    expect(out).toHaveLength(MAX_ITEMS_PER_FILE);
    expect(out.filter((d) => d.severity === 'error')).toHaveLength(3);
  });
});
