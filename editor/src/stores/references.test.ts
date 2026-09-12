import { describe, it, expect, beforeEach } from 'bun:test';
import { groupHits, attachPreviews, useReferencesStore, type ReferenceLine } from './references';
import type { ReferenceHit } from '../features/lsp';

const hit = (path: string, line: number, column: number): ReferenceHit => ({ path, line, column });

describe('query staleness', () => {
  beforeEach(() => {
    useReferencesStore.getState().reset();
  });

  it('ignores results reported against a superseded query', async () => {
    // The user hits Find Usages on `Foo`, then on `Bar` before Foo answers.
    const fooToken = useReferencesStore.getState().begin('Foo');
    const barToken = useReferencesStore.getState().begin('Bar');

    await useReferencesStore.getState().showResults(fooToken, 'Foo', []);
    expect(useReferencesStore.getState().symbol).toBe('Bar');
    expect(useReferencesStore.getState().status).toBe('loading');

    await useReferencesStore.getState().showResults(barToken, 'Bar', []);
    expect(useReferencesStore.getState().status).toBe('ready');
  });

  it('ignores a failure reported against a superseded query', () => {
    const fooToken = useReferencesStore.getState().begin('Foo');
    useReferencesStore.getState().begin('Bar');

    useReferencesStore.getState().fail(fooToken, 'Foo', 'server died');
    // A stale error must not replace the live query's loading state.
    expect(useReferencesStore.getState().status).toBe('loading');
    expect(useReferencesStore.getState().symbol).toBe('Bar');
  });

  it('reports an error distinctly from an empty result', async () => {
    // These must never look the same: only one of them means the symbol is
    // safe to delete.
    const token = useReferencesStore.getState().begin('Foo');
    useReferencesStore.getState().fail(token, 'Foo', 'no language server');
    expect(useReferencesStore.getState().status).toBe('error');
    expect(useReferencesStore.getState().error).toBe('no language server');

    const next = useReferencesStore.getState().begin('Foo');
    await useReferencesStore.getState().showResults(next, 'Foo', []);
    expect(useReferencesStore.getState().status).toBe('ready');
    expect(useReferencesStore.getState().error).toBeNull();
  });
});

describe('attachPreviews', () => {
  const files = [
    { path: '/p/A.cs', content: 'class A {\n    private Foo foo;\n}\n' },
    { path: '/p/B.cs', content: 'var x = Foo.Bar();\n' },
  ];

  it('attaches the trimmed source line each hit sits on', () => {
    const [row] = attachPreviews([hit('/p/A.cs', 2, 13)], files, 'Foo');
    expect(row.preview).toBe('private Foo foo;');
  });

  it('re-bases the match column onto the trimmed preview', () => {
    // Column 13 on the raw line is column 9 once four spaces of indent go.
    const [row] = attachPreviews([hit('/p/A.cs', 2, 13)], files, 'Foo');
    expect(row.preview.slice(row.previewMatchStart, row.previewMatchStart + row.previewMatchLength))
      .toBe('Foo');
  });

  it('falls back to a text search when the served column disagrees with disk', () => {
    // An unsaved buffer or a stale index puts the column somewhere useless;
    // the highlight should still land on the symbol rather than mid-token.
    const [row] = attachPreviews([hit('/p/A.cs', 2, 99)], files, 'Foo');
    expect(row.previewMatchStart).toBe('private '.length);
    expect(row.previewMatchLength).toBe(3);
  });

  it('reports no highlight rather than a wrong one when the symbol is absent', () => {
    const [row] = attachPreviews([hit('/p/B.cs', 1, 1)], files, 'Nope');
    expect(row.previewMatchStart).toBe(-1);
    expect(row.previewMatchLength).toBe(0);
  });

  it('survives a file that could not be read', () => {
    // Previews are a nicety; losing them must not lose the hit.
    const [row] = attachPreviews([hit('/p/missing.cs', 4, 2)], files, 'Foo');
    expect(row.preview).toBe('');
    expect(row.line).toBe(4);
  });
});

describe('groupHits', () => {
  const line = (path: string, l: number, c = 1): ReferenceLine => ({
    path,
    line: l,
    column: c,
    preview: '',
    previewMatchStart: -1,
    previewMatchLength: 0,
  });

  it('groups by file and keeps first-seen file order', () => {
    const groups = groupHits([
      line('/p/B.cs', 3),
      line('/p/A.cs', 1),
      line('/p/B.cs', 9),
    ]);
    expect(groups.map((g) => g.path)).toEqual(['/p/B.cs', '/p/A.cs']);
    expect(groups[0].hits).toHaveLength(2);
  });

  it('sorts hits within a file by position, not arrival order', () => {
    const groups = groupHits([line('/p/A.cs', 9), line('/p/A.cs', 2, 40), line('/p/A.cs', 2)]);
    expect(groups[0].hits.map((h) => `${h.line}:${h.column}`)).toEqual(['2:1', '2:40', '9:1']);
  });

  it('names each group by its basename', () => {
    const [group] = groupHits([line('/deep/nested/Thing.cs', 1)]);
    expect(group.name).toBe('Thing.cs');
  });

  it('returns nothing for no hits', () => {
    expect(groupHits([])).toEqual([]);
  });
});
