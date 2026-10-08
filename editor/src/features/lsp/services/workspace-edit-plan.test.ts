import { describe, expect, it } from 'bun:test';
import { normalizeWorkspaceEdit, applyEditsToText, documentIdentity } from './workspace-edit-plan';
const edit = (start: number, end: number, newText: string) => ({ range: { start: { line: 0, character: start }, end: { line: 0, character: end } }, newText });

describe('workspace change preflight', () => {
  it('combines Windows URI aliases and preserves version preconditions', () => {
    const plan = normalizeWorkspaceEdit({ documentChanges: [
      { textDocument: { uri: 'file:///C:/Game/Player.cs', version: 7 }, edits: [edit(0, 1, 'A')] },
      { textDocument: { uri: 'file:///c%3A/game/Player.cs', version: 7 }, edits: [edit(1, 2, 'B')] },
    ] });
    expect(plan).toHaveLength(1);
    expect(plan[0].version).toBe(7);
    expect(plan[0].edits).toHaveLength(2);
    expect(documentIdentity('file://SERVER/Share/A.cs')).toBe(documentIdentity('//server/share/a.cs'));
  });
  it('rejects conflicting versions and unsupported operations before any text apply', () => {
    expect(() => normalizeWorkspaceEdit({ documentChanges: [
      { textDocument: { uri: 'file:///A.cs', version: 1 }, edits: [] },
      { textDocument: { uri: 'file:///A.cs', version: 2 }, edits: [] },
    ] })).toThrow('Conflicting document versions');
    for (const kind of ['create', 'rename', 'delete'] as const) {
      expect(() => normalizeWorkspaceEdit({ documentChanges: [
        { textDocument: { uri: 'file:///A.cs' }, edits: [edit(0, 0, 'change')] }, { kind },
      ] })).toThrow('not supported');
    }
    expect(() => normalizeWorkspaceEdit({ changes: { 'csharp:/metadata/A.cs': [] } })).toThrow('read-only');
  });
  it('respects even empty documentChanges over changes', () => {
    expect(normalizeWorkspaceEdit({ documentChanges: [], changes: { 'file:///A.cs': [edit(0, 0, 'bad')] } })).toEqual([]);
  });
  it('rejects overlaps, reversed ranges, and invalid positions', () => {
    expect(() => applyEditsToText('abcd', [edit(0, 3, 'A'), edit(2, 4, 'B')])).toThrow('overlap');
    expect(() => applyEditsToText('abcd', [edit(3, 1, 'A')])).toThrow('reversed');
    expect(() => applyEditsToText('abcd', [edit(-1, 1, 'A')])).toThrow('invalid');
  });
  it('preserves ordered inserts, CRLF, UTF-16 positions and untouched bytes', () => {
    expect(applyEditsToText('🌍x\r\nnext', [edit(2, 3, 'y')])).toBe('🌍y\r\nnext');
    expect(applyEditsToText('x', [edit(0, 0, 'A'), edit(0, 0, 'B')])).toBe('ABx');
    expect(applyEditsToText('abcdef', [edit(0, 1, 'A'), edit(4, 6, 'Z')])).toBe('AbcdZ');
  });
});
