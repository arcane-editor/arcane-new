import { describe, it, expect } from 'bun:test';
import {
  ERROR_REPORT_MAX_BYTES,
  ERROR_REPORT_MAX_ENTRIES,
  ERROR_REPORT_MAX_FRAMES,
  ERROR_REPORT_MAX_MESSAGE_CHARS,
  ERROR_REPORT_MAX_STORED,
  capStoredEntries,
  buildErrorReport,
  mergeEntries,
  normalizeConsoleEntries,
  normalizeDiagnostics,
  isAskableConsoleEntry,
  type ErrorReportEntry,
} from './error-report';
import type { UnityLogEntry, UnityLogType } from '../../../types/unity';
import type { DiagnosticItem } from '../../../types';

const AT = Date.UTC(2026, 8, 9, 12, 4, 11);

function log(partial: Partial<UnityLogEntry> & { message: string }): UnityLogEntry {
  return {
    stackTrace: '',
    logType: 'Error' as UnityLogType,
    timestamp: 0,
    frameCount: 0,
    mode: 'EditMode',
    ...partial,
  };
}

function diag(partial: Partial<DiagnosticItem> & { message: string }): DiagnosticItem {
  return {
    file: '/ws/Assets/Scripts/PlayerController.cs',
    fileName: 'PlayerController.cs',
    line: 42,
    col: 9,
    severity: 'error',
    ...partial,
  };
}

describe('buildErrorReport — the copy/send invariant', () => {
  /**
   * This is the whole point of a single builder: the text the user pastes into
   * a bug report and the text the model reads are the same bytes. If a second
   * renderer ever appears, this fails.
   */
  it('wraps body in block and never leaks the tag into body', () => {
    const entries = normalizeConsoleEntries([log({ message: 'boom' })]);
    const r = buildErrorReport('unity-console', entries, AT);
    expect(r.block).toContain(r.body);
    expect(r.body).not.toContain('<console-errors');
    expect(r.body).not.toContain('</console-errors>');
    expect(r.block.startsWith('<console-errors ')).toBe(true);
    expect(r.block.endsWith('</console-errors>')).toBe(true);
  });

  it('is deterministic — capturedAt is injected, never read from the clock', () => {
    const entries = normalizeConsoleEntries([log({ message: 'boom' })]);
    expect(buildErrorReport('unity-console', entries, AT).block).toBe(
      buildErrorReport('unity-console', entries, AT).block,
    );
    expect(buildErrorReport('unity-console', entries, AT).block).toContain(
      'captured="2026-09-09T12:04:11.000Z"',
    );
  });

  it('says so rather than emitting an empty block', () => {
    const r = buildErrorReport('unity-console', [], AT);
    expect(r.body).toBe('(no errors captured)');
    expect(r.count).toBe(0);
    expect(r.block).toContain('count="0"');
  });
});

describe('normalizeConsoleEntries', () => {
  it('collapses consecutive duplicates into a ×N count', () => {
    const entries = normalizeConsoleEntries([
      log({ message: 'NullReferenceException' }),
      log({ message: 'NullReferenceException' }),
      log({ message: 'other' }),
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.count).toBe(2);
    expect(entries[1]!.count).toBe(1);
    expect(buildErrorReport('unity-console', entries, AT).body).toContain('×2');
  });

  it('reads frames from parsedFrames, else parses the stack trace', () => {
    const parsed = normalizeConsoleEntries([
      log({
        message: 'a',
        parsedFrames: [
          { className: 'Player', methodName: 'Update', filePath: 'Assets/P.cs', lineNumber: 42 },
        ],
      }),
    ]);
    expect(parsed[0]!.frames).toEqual(['Player.Update (Assets/P.cs:42)']);

    const fromText = normalizeConsoleEntries([
      log({ message: 'b', stackTrace: 'Enemy.Die () (at Assets/E.cs:7)' }),
    ]);
    expect(fromText[0]!.frames).toEqual(['Enemy.Die (Assets/E.cs:7)']);
  });

  it('caps frames', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      className: 'C',
      methodName: `M${i}`,
      filePath: 'Assets/A.cs',
      lineNumber: i,
    }));
    const entries = normalizeConsoleEntries([log({ message: 'a', parsedFrames: many })]);
    expect(entries[0]!.frames).toHaveLength(ERROR_REPORT_MAX_FRAMES);
  });

  it('carries the historical flag through, so the model does not assume recency', () => {
    const entries = normalizeConsoleEntries([log({ message: 'old', historical: true })]);
    expect(entries[0]!.historical).toBe(true);
    expect(buildErrorReport('unity-console', entries, AT).body).toContain('(historical)');
  });

  it('maps log types onto severities', () => {
    const entries = normalizeConsoleEntries([
      log({ message: 'e', logType: 'Exception' }),
      log({ message: 'w', logType: 'Warning' }),
      log({ message: 'l', logType: 'Log' }),
    ]);
    expect(entries.map((e) => e.severity)).toEqual(['error', 'warning', 'info']);
    expect(entries.map((e) => e.origin)).toEqual(['Exception', 'Warning', 'Log']);
  });
});

describe('isAskableConsoleEntry', () => {
  /**
   * Debug.Log chatter is the majority of a play session and dilutes the ask;
   * the IDE's own bridge chatter is never the project's bug.
   */
  it('takes errors, drops logs and bridge chatter', () => {
    expect(isAskableConsoleEntry(log({ message: 'x', logType: 'Error' }))).toBe(true);
    expect(isAskableConsoleEntry(log({ message: 'x', logType: 'Exception' }))).toBe(true);
    expect(isAskableConsoleEntry(log({ message: 'x', logType: 'Assert' }))).toBe(true);
    expect(isAskableConsoleEntry(log({ message: 'x', logType: 'CompileError' }))).toBe(true);
    expect(isAskableConsoleEntry(log({ message: 'x', logType: 'Log' }))).toBe(false);
    expect(isAskableConsoleEntry(log({ message: 'x', logType: 'Warning' }))).toBe(false);
    expect(isAskableConsoleEntry(log({ message: '[UnityIDEBridge] hello', logType: 'Error' }))).toBe(
      false,
    );
  });
});

describe('normalizeDiagnostics', () => {
  it('makes paths workspace-relative and keeps the code', () => {
    const entries = normalizeDiagnostics([diag({ message: 'nope', code: 'CS0029', source: 'lsp' })], '/ws');
    expect(entries[0]!.relPath).toBe('Assets/Scripts/PlayerController.cs');
    expect(entries[0]!.code).toBe('CS0029');
    expect(entries[0]!.origin).toBe('lsp');
  });

  it('groups by file under a # header and renders code, severity and location', () => {
    const body = buildErrorReport(
      'problems',
      normalizeDiagnostics(
        [
          diag({ message: 'first', code: 'CS0029', source: 'lsp' }),
          diag({ message: 'second', line: 51, col: 5, severity: 'warning', code: 'UNT0001', source: 'unity-analyzer' }),
          diag({
            message: 'third',
            file: '/ws/Assets/Scripts/Enemy.cs',
            fileName: 'Enemy.cs',
            line: 3,
            col: 1,
          }),
        ],
        '/ws',
      ),
      AT,
    ).body;

    expect(body).toContain('# Assets/Scripts/PlayerController.cs');
    expect(body).toContain('# Assets/Scripts/Enemy.cs');
    expect(body).toContain('42:9  error  CS0029  first  (lsp)');
    expect(body).toContain('51:5  warning  UNT0001  second  (unity-analyzer)');
    // Only one header per file, however many rows it has.
    expect(body.match(/# Assets\/Scripts\/PlayerController\.cs/g)).toHaveLength(1);
  });

  it('degrades to no code when the diagnostic has none', () => {
    const body = buildErrorReport('problems', normalizeDiagnostics([diag({ message: 'bare' })], '/ws'), AT).body;
    expect(body).toContain('42:9  error  bare');
  });

  it('is order-independent — the same set renders identically', () => {
    const a = [diag({ message: 'a' }), diag({ message: 'b', file: '/ws/Z.cs', fileName: 'Z.cs' })];
    const b = [a[1]!, a[0]!];
    expect(buildErrorReport('problems', normalizeDiagnostics(a, '/ws'), AT).body).toBe(
      buildErrorReport('problems', normalizeDiagnostics(b, '/ws'), AT).body,
    );
  });
});

describe('caps', () => {
  function manyConsole(n: number, size = 20): ErrorReportEntry[] {
    return normalizeConsoleEntries(
      Array.from({ length: n }, (_, i) => log({ message: `e${i} ${'x'.repeat(size)}` })),
    );
  }

  it('keeps the newest MAX_ENTRIES and reports the rest as omitted', () => {
    const r = buildErrorReport('unity-console', manyConsole(ERROR_REPORT_MAX_ENTRIES + 10), AT);
    expect(r.count).toBe(ERROR_REPORT_MAX_ENTRIES);
    expect(r.omitted).toBe(10);
    // Newest kept, oldest dropped.
    expect(r.body).toContain(`e${ERROR_REPORT_MAX_ENTRIES + 9} `);
    expect(r.body).not.toContain('e0 ');
    expect(r.body).toContain('10 more entries omitted');
    expect(r.block).toContain('omitted="10"');
  });

  it('caps a single oversized message', () => {
    const entries = normalizeConsoleEntries([log({ message: 'M'.repeat(5000) })]);
    expect(entries[0]!.message.length).toBe(ERROR_REPORT_MAX_MESSAGE_CHARS + 1); // + the ellipsis
    expect(entries[0]!.message.endsWith('…')).toBe(true);
  });

  /**
   * Whole entries, never a byte cut: half a stack trace read as if it were
   * whole is worse than a short block.
   */
  it('drops whole entries from the oldest end to fit the byte cap', () => {
    const r = buildErrorReport('unity-console', manyConsole(40, 500), AT);
    expect(new TextEncoder().encode(r.body).length).toBeLessThanOrEqual(ERROR_REPORT_MAX_BYTES);
    expect(r.omitted).toBeGreaterThan(0);
    expect(r.count).toBeLessThan(40);
    // Every kept entry is present in full — no entry was cut in half.
    for (const line of r.body.split('\n')) {
      if (line.startsWith('[Error]')) expect(line.length).toBeGreaterThan(500);
    }
  });

  it('byte-truncates a lone entry that cannot fit, and still closes the block', () => {
    const huge = normalizeConsoleEntries([log({ message: 'x'.repeat(50) })]);
    huge[0]!.frames = [' '.repeat(ERROR_REPORT_MAX_BYTES * 2)];
    const r = buildErrorReport('unity-console', huge, AT);
    expect(r.count).toBe(1);
    expect(r.body).toContain('…(entry truncated)');
    expect(r.block.endsWith('</console-errors>')).toBe(true);
    expect(new TextEncoder().encode(r.body).length).toBeLessThanOrEqual(ERROR_REPORT_MAX_BYTES + 64);
  });
});

describe('label', () => {
  const err = (n: number) => normalizeDiagnostics(
    Array.from({ length: n }, (_, i) => diag({ message: `m${i}`, line: i + 1 })),
    '/ws',
  );

  it('counts and pluralises', () => {
    expect(buildErrorReport('problems', err(1), AT).label).toBe('1 error');
    expect(buildErrorReport('problems', err(3), AT).label).toBe('3 errors');
  });

  it('says "problems" when the set is not all errors', () => {
    const mixed = normalizeDiagnostics(
      [diag({ message: 'a' }), diag({ message: 'b', line: 2, severity: 'warning' })],
      '/ws',
    );
    expect(buildErrorReport('problems', mixed, AT).label).toBe('2 problems');
  });

  it('states the truncation in the label too', () => {
    const r = buildErrorReport('problems', err(ERROR_REPORT_MAX_ENTRIES + 5), AT);
    expect(r.label).toBe(`${ERROR_REPORT_MAX_ENTRIES} of ${ERROR_REPORT_MAX_ENTRIES + 5} errors`);
  });
});

describe('mergeEntries', () => {
  /**
   * This is what stands in for row multi-select: clicking Ask AI on three rows
   * yields one chip reading "3 errors", not three chips.
   */
  it('appends and dedupes by identity, preserving order', () => {
    const a = normalizeDiagnostics([diag({ message: 'a' })], '/ws');
    const b = normalizeDiagnostics([diag({ message: 'b', line: 7 })], '/ws');
    const merged = mergeEntries(a, b);
    expect(merged).toHaveLength(2);
    expect(merged.map((e) => e.message)).toEqual(['a', 'b']);
    expect(mergeEntries(merged, a)).toHaveLength(2);
  });
});

describe('capStoredEntries', () => {
  /**
   * A chip stores more than it sends so it can say "50 of 138", but a broken
   * project has thousands of diagnostics and every one of them would be
   * written into the persisted session.
   */
  const many = (n: number): ErrorReportEntry[] =>
    Array.from({ length: n }, (_, i) => ({ severity: 'error' as const, message: `m${i}` }));

  it('leaves a normal selection alone', () => {
    const entries = many(120);
    expect(capStoredEntries('problems', entries)).toBe(entries);
  });

  it('bounds a huge one, keeping the end each source renders from', () => {
    const entries = many(ERROR_REPORT_MAX_STORED + 40);
    const problems = capStoredEntries('problems', entries);
    const console = capStoredEntries('unity-console', entries);
    expect(problems).toHaveLength(ERROR_REPORT_MAX_STORED);
    expect(console).toHaveLength(ERROR_REPORT_MAX_STORED);
    expect(problems[0]!.message).toBe('m0');
    expect(console.at(-1)!.message).toBe(`m${ERROR_REPORT_MAX_STORED + 39}`);
  });

  it('still leaves room for the report to report its own truncation', () => {
    const r = buildErrorReport('problems', capStoredEntries('problems', many(2000)), AT);
    expect(r.count).toBe(ERROR_REPORT_MAX_ENTRIES);
    expect(r.omitted).toBe(ERROR_REPORT_MAX_STORED - ERROR_REPORT_MAX_ENTRIES);
    expect(r.label).toContain(`of ${ERROR_REPORT_MAX_STORED}`);
  });
});
