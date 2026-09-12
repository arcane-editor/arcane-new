// Unit coverage for the PURE mappers only. The `register*` half is
// Monaco-coupled and needs a full stub to exercise, which is why the mapping
// logic was extracted in the first place — the same split `diagnostics.test.ts`
// makes.

import { describe, it, expect } from 'bun:test';
import {
  toMonacoSymbolKind,
  lspSymbolsToMonaco,
  lspEditsToMonaco,
  toWorkspaceSymbolHits,
  readSemanticLegend,
  MIN_SYMBOL_QUERY_LENGTH,
  lspInlayHintsToMonaco,
  type LspDocumentSymbol,
  type LspSymbolInformation,
} from './symbol-providers';

const range = (line: number) => ({
  start: { line, character: 0 },
  end: { line, character: 5 },
});

describe('toMonacoSymbolKind', () => {
  it('shifts the 1-based LSP kind down to Monaco 0-based', () => {
    expect(toMonacoSymbolKind(1)).toBe(0); // File
    expect(toMonacoSymbolKind(5)).toBe(4); // Class
    expect(toMonacoSymbolKind(12)).toBe(11); // Function
    expect(toMonacoSymbolKind(26)).toBe(25); // TypeParameter
  });

  // A negative kind is not a harmless number: Monaco indexes its icon table
  // with it and renders a blank glyph, so every symbol in the outline loses
  // its icon rather than the one bad entry.
  it('falls back to Variable for out-of-range or non-integer kinds', () => {
    expect(toMonacoSymbolKind(0)).toBe(12);
    expect(toMonacoSymbolKind(27)).toBe(12);
    expect(toMonacoSymbolKind(-3)).toBe(12);
    expect(toMonacoSymbolKind(1.5)).toBe(12);
    expect(toMonacoSymbolKind(NaN)).toBe(12);
  });
});

describe('lspSymbolsToMonaco', () => {
  it('returns [] for null, undefined and non-arrays', () => {
    expect(lspSymbolsToMonaco(null)).toEqual([]);
    expect(lspSymbolsToMonaco(undefined)).toEqual([]);
    expect(lspSymbolsToMonaco({} as never)).toEqual([]);
  });

  it('converts hierarchical DocumentSymbols and recurses into children', () => {
    const input: LspDocumentSymbol[] = [
      {
        name: 'PlayerController',
        kind: 5, // Class
        detail: 'class',
        range: range(0),
        selectionRange: range(0),
        children: [
          { name: 'Update', kind: 6, range: range(3), selectionRange: range(3) },
        ],
      },
    ];
    const out = lspSymbolsToMonaco(input);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('PlayerController');
    expect(out[0].kind).toBe(4);
    expect(out[0].children).toHaveLength(1);
    expect(out[0].children![0].name).toBe('Update');
    expect(out[0].children![0].kind).toBe(5);
    // LSP ranges are 0-based, Monaco's are 1-based.
    expect(out[0].range.startLineNumber).toBe(1);
  });

  it('converts flat SymbolInformation, reusing range as selectionRange', () => {
    const input: LspSymbolInformation[] = [
      {
        name: 'speed',
        kind: 8, // Field
        containerName: 'PlayerController',
        location: { uri: 'file:///P.cs', range: range(7) },
      },
    ];
    const out = lspSymbolsToMonaco(input);
    expect(out[0].kind).toBe(7);
    expect(out[0].detail).toBe('PlayerController');
    // Monaco drops any entry whose selectionRange is not inside range, so for
    // the flat shape (which has no selectionRange) they must be identical.
    expect(out[0].selectionRange).toEqual(out[0].range);
    expect(out[0].children).toBeUndefined();
  });

  it('defaults detail to an empty string when the server omits it', () => {
    const out = lspSymbolsToMonaco([
      { name: 'X', kind: 5, range: range(0), selectionRange: range(0) },
    ]);
    expect(out[0].detail).toBe('');
  });
});

describe('toWorkspaceSymbolHits', () => {
  const fromUri = (u: string) => decodeURIComponent(u.replace('file://', ''));

  it('returns [] for null, undefined and non-arrays', () => {
    expect(toWorkspaceSymbolHits(null, fromUri)).toEqual([]);
    expect(toWorkspaceSymbolHits(undefined, fromUri)).toEqual([]);
    expect(toWorkspaceSymbolHits({} as never, fromUri)).toEqual([]);
  });

  it('converts LSP 0-based positions to the 1-based pair the editor navigates with', () => {
    const hits = toWorkspaceSymbolHits(
      [
        {
          name: 'PlayerController',
          kind: 5,
          containerName: 'Game',
          location: {
            uri: 'file:///proj/Assets/PlayerController.cs',
            range: { start: { line: 11, character: 4 }, end: { line: 11, character: 20 } },
          },
        },
      ],
      fromUri,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({
      name: 'PlayerController',
      kind: 4,
      containerName: 'Game',
      path: '/proj/Assets/PlayerController.cs',
      line: 12,
      column: 5,
    });
  });

  it('decodes percent-escapes so paths with spaces resolve', () => {
    const hits = toWorkspaceSymbolHits(
      [
        {
          name: 'Boot',
          kind: 5,
          location: {
            uri: 'file:///Users/x/Arcane%20Demo/Assets/Boot.cs',
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
          },
        },
      ],
      fromUri,
    );
    expect(hits[0].path).toBe('/Users/x/Arcane Demo/Assets/Boot.cs');
    expect(hits[0].containerName).toBe('');
  });

  // A row whose URI cannot be resolved would render fine and then do nothing
  // on Enter — worse than not showing it, because the user retries it.
  it('drops entries with no resolvable path or no range', () => {
    const hits = toWorkspaceSymbolHits(
      [
        { name: 'A', kind: 5, location: { uri: '', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } } },
        { name: 'B', kind: 5, location: undefined as never },
        { name: 'C', kind: 5, location: { uri: 'file:///ok.cs', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } } },
      ],
      fromUri,
    );
    expect(hits.map((h) => h.name)).toEqual(['C']);
  });
});

describe('readSemanticLegend', () => {
  it('returns null when the server advertises no semantic tokens', () => {
    expect(readSemanticLegend(null)).toBeNull();
    expect(readSemanticLegend({})).toBeNull();
    expect(readSemanticLegend({ semanticTokensProvider: true })).toBeNull();
  });

  // Registering with an empty legend would decode every token index against a
  // zero-length table, colouring nothing while looking like it works.
  it('returns null for a legend with no token types', () => {
    expect(
      readSemanticLegend({ semanticTokensProvider: { legend: { tokenTypes: [] } } }),
    ).toBeNull();
  });

  it('reads the legend the server actually advertised', () => {
    const legend = readSemanticLegend({
      semanticTokensProvider: {
        legend: {
          tokenTypes: ['class', 'method', 'property'],
          tokenModifiers: ['static', 'readonly'],
        },
      },
    });
    expect(legend).toEqual({
      tokenTypes: ['class', 'method', 'property'],
      tokenModifiers: ['static', 'readonly'],
    });
  });

  it('tolerates a missing tokenModifiers list', () => {
    const legend = readSemanticLegend({
      semanticTokensProvider: { legend: { tokenTypes: ['class'] } },
    });
    expect(legend).toEqual({ tokenTypes: ['class'], tokenModifiers: [] });
  });
});

describe('lspEditsToMonaco', () => {
  it('returns [] for null and undefined', () => {
    expect(lspEditsToMonaco(null)).toEqual([]);
    expect(lspEditsToMonaco(undefined)).toEqual([]);
  });

  it('maps newText to text and converts the range to 1-based', () => {
    const out = lspEditsToMonaco([{ range: range(2), newText: '    ' }]);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe('    ');
    expect(out[0].range.startLineNumber).toBe(3);
    expect(out[0].range.startColumn).toBe(1);
  });
});

describe('lspInlayHintsToMonaco', () => {
  it('returns [] for null and undefined', () => {
    expect(lspInlayHintsToMonaco(null)).toEqual([]);
    expect(lspInlayHintsToMonaco(undefined)).toEqual([]);
  });

  it('converts a plain string label and shifts the position to 1-based', () => {
    const out = lspInlayHintsToMonaco([
      { position: { line: 4, character: 12 }, label: 'count:', kind: 2 },
    ]);
    expect(out[0].label).toBe('count:');
    expect(out[0].position).toEqual({ lineNumber: 5, column: 13 });
    expect(out[0].kind).toBe(2);
  });

  // Servers use the array form to attach per-part tooltips. Dropping it would
  // render nothing at all for those hints, silently.
  it('joins an array-of-parts label', () => {
    const out = lspInlayHintsToMonaco([
      {
        position: { line: 0, character: 0 },
        label: [{ value: 'IEnumerable' }, { value: '<' }, { value: 'int' }, { value: '>' }],
        kind: 1,
      },
    ]);
    expect(out[0].label).toBe('IEnumerable<int>');
    expect(out[0].kind).toBe(1);
  });

  it('defaults an unknown kind to Parameter rather than dropping the hint', () => {
    const out = lspInlayHintsToMonaco([
      { position: { line: 0, character: 0 }, label: 'x' },
    ]);
    expect(out[0].kind).toBe(2);
  });
});

describe('MIN_SYMBOL_QUERY_LENGTH', () => {
  // LSP has no limit parameter on workspace/symbol, so the query length is the
  // only lever on response size. A one-character query against a large solution
  // asks the server to materialise nearly every symbol it knows.
  it('is at least 2, so a single character cannot ask for the whole solution', () => {
    expect(MIN_SYMBOL_QUERY_LENGTH).toBeGreaterThanOrEqual(2);
  });
});
