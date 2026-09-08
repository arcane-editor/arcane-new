import { describe, expect, it } from 'bun:test';
import {
  filterStaticSuggestions,
  isAfterDot,
  labelText,
  mapCompletionItemKind,
  mapCompletionList,
  mergeResolvedItem,
  shouldOfferLifecycleSnippets,
  toLspCompletionTriggerKind,
  toMonacoCompletionItem,
  type LspCompletionItem,
  type MonacoCompletionEnums,
  type MonacoRange,
} from './completion-mapping';
import { serverProfile } from './server-profiles';

// What these protect: every field below decides something the user sees — the
// icon, what the item replaces, whether it expands as a snippet or lands as
// literal text — and getting one wrong looks like a bad server rather than a
// client bug. None of this had a test before; the mapping lived inline in the
// provider registration, where it was unreachable without a full Monaco stub.

/**
 * Monaco's real enum values (`monaco.languages.CompletionItemKind`). Hardcoded
 * rather than imported: the bare `monaco-editor` entry point does not load
 * outside a browser, and these numbers are API — they only change in a major
 * Monaco release, which is a change worth failing on.
 */
const KINDS: Record<string, number> = {
  Method: 0, Function: 1, Constructor: 2, Field: 3, Variable: 4, Class: 5,
  Struct: 6, Interface: 7, Module: 8, Property: 9, Event: 10, Operator: 11,
  Unit: 12, Value: 13, Constant: 14, Enum: 15, EnumMember: 16, Keyword: 17,
  Text: 18, Color: 19, File: 20, Reference: 21, Customcolor: 22, Folder: 23,
  TypeParameter: 24, User: 25, Issue: 26, Snippet: 27,
};

const ENUMS: MonacoCompletionEnums = {
  kinds: KINDS,
  insertAsSnippet: 4,
  deprecatedTag: 1,
};

const WORD_RANGE: MonacoRange = {
  startLineNumber: 7,
  startColumn: 9,
  endLineNumber: 7,
  endColumn: 12,
};

const CSHARP = serverProfile('csharp');
const DEFAULT = serverProfile('typescript');

function item(overrides: Partial<LspCompletionItem> = {}): LspCompletionItem {
  return { label: 'main', ...overrides };
}

describe('mapCompletionItemKind', () => {
  it('maps every LSP kind to its Monaco counterpart', () => {
    // The two enums do not share numbering: LSP Method is 2, Monaco's is 0.
    const expected: Record<number, number> = {
      1: KINDS.Text, 2: KINDS.Method, 3: KINDS.Function, 4: KINDS.Constructor,
      5: KINDS.Field, 6: KINDS.Variable, 7: KINDS.Class, 8: KINDS.Interface,
      9: KINDS.Module, 10: KINDS.Property, 11: KINDS.Unit, 12: KINDS.Value,
      13: KINDS.Enum, 14: KINDS.Keyword, 15: KINDS.Snippet, 16: KINDS.Color,
      17: KINDS.File, 18: KINDS.Reference, 19: KINDS.Folder, 20: KINDS.EnumMember,
      21: KINDS.Constant, 22: KINDS.Struct, 23: KINDS.Event, 24: KINDS.Operator,
      25: KINDS.TypeParameter,
    };
    for (const [lsp, monaco] of Object.entries(expected)) {
      expect(mapCompletionItemKind(Number(lsp), KINDS)).toBe(monaco);
    }
  });

  it('keeps an item whose kind it does not recognise', () => {
    // Losing the icon is acceptable; losing the completion is not.
    expect(mapCompletionItemKind(99, KINDS)).toBe(KINDS.Text);
    expect(mapCompletionItemKind(undefined, KINDS)).toBe(KINDS.Text);
  });

  it('maps the kinds C# members actually arrive as', () => {
    // Property/Field/Constant/EnumMember are most of a Unity API surface —
    // `Camera.main` is a Property.
    expect(mapCompletionItemKind(10, KINDS)).toBe(KINDS.Property);
    expect(mapCompletionItemKind(5, KINDS)).toBe(KINDS.Field);
    expect(mapCompletionItemKind(21, KINDS)).toBe(KINDS.Constant);
    expect(mapCompletionItemKind(20, KINDS)).toBe(KINDS.EnumMember);
  });
});

describe('toLspCompletionTriggerKind', () => {
  it('shifts Monaco 0-based trigger kinds onto LSP 1-based ones', () => {
    expect(toLspCompletionTriggerKind(0)).toBe(1); // Invoke
    expect(toLspCompletionTriggerKind(1)).toBe(2); // TriggerCharacter
    expect(toLspCompletionTriggerKind(2)).toBe(3); // ForIncompleteCompletions
  });

  it('treats an unknown trigger kind as an explicit invoke', () => {
    expect(toLspCompletionTriggerKind(7)).toBe(1);
  });
});

describe('toMonacoCompletionItem', () => {
  it('falls back to the word range when the server sends no edit', () => {
    expect(toMonacoCompletionItem(item(), WORD_RANGE, ENUMS).range).toEqual(WORD_RANGE);
  });

  it('converts a textEdit range from 0-based to 1-based', () => {
    const mapped = toMonacoCompletionItem(
      item({
        textEdit: {
          range: { start: { line: 6, character: 8 }, end: { line: 6, character: 11 } },
          newText: 'main',
        },
      }),
      WORD_RANGE,
      ENUMS,
    );
    expect(mapped.range).toEqual({
      startLineNumber: 7,
      startColumn: 9,
      endLineNumber: 7,
      endColumn: 12,
    });
  });

  it('carries an insert/replace edit through as both ranges', () => {
    const mapped = toMonacoCompletionItem(
      item({
        textEdit: {
          insert: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } },
          replace: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
          newText: 'main',
        },
      }),
      WORD_RANGE,
      ENUMS,
    );
    expect(mapped.range).toEqual({
      insert: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 3 },
      replace: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 6 },
    });
  });

  it('prefers the edit text over insertText and the label', () => {
    const edit = {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      newText: 'fromEdit',
    };
    expect(
      toMonacoCompletionItem(
        item({ textEdit: edit, insertText: 'fromInsert' }),
        WORD_RANGE,
        ENUMS,
      ).insertText,
    ).toBe('fromEdit');
    expect(
      toMonacoCompletionItem(item({ insertText: 'fromInsert' }), WORD_RANGE, ENUMS)
        .insertText,
    ).toBe('fromInsert');
    expect(toMonacoCompletionItem(item(), WORD_RANGE, ENUMS).insertText).toBe('main');
  });

  it('marks snippet items as snippets and leaves plain text alone', () => {
    // Without this a snippet's placeholders are inserted as literal characters.
    expect(
      toMonacoCompletionItem(item({ insertTextFormat: 2 }), WORD_RANGE, ENUMS)
        .insertTextRules,
    ).toBe(ENUMS.insertAsSnippet);
    expect(
      toMonacoCompletionItem(item({ insertTextFormat: 1 }), WORD_RANGE, ENUMS)
        .insertTextRules,
    ).toBeUndefined();
    expect(
      toMonacoCompletionItem(item(), WORD_RANGE, ENUMS).insertTextRules,
    ).toBeUndefined();
  });

  it('normalises both documentation shapes', () => {
    expect(
      toMonacoCompletionItem(item({ documentation: 'plain' }), WORD_RANGE, ENUMS)
        .documentation,
    ).toEqual({ value: 'plain' });
    expect(
      toMonacoCompletionItem(
        item({ documentation: { kind: 'markdown', value: 'rich' } }),
        WORD_RANGE,
        ENUMS,
      ).documentation,
    ).toEqual({ value: 'rich' });
    expect(toMonacoCompletionItem(item(), WORD_RANGE, ENUMS).documentation).toBeUndefined();
  });

  it('keeps a rich label object rather than flattening it to a string', () => {
    // Monaco renders `detail`/`description` beside the name — for C# that is
    // the member signature and its namespace.
    const mapped = toMonacoCompletionItem(
      item({ label: { label: 'main', detail: ' { get; }', description: 'UnityEngine' } }),
      WORD_RANGE,
      ENUMS,
    );
    expect(mapped.label).toEqual({
      label: 'main',
      detail: ' { get; }',
      description: 'UnityEngine',
    });
    expect(labelText(mapped.label)).toBe('main');
  });

  it('passes sort, filter and detail through untouched', () => {
    const mapped = toMonacoCompletionItem(
      item({ sortText: '0__main', filterText: 'main', detail: 'static Camera main' }),
      WORD_RANGE,
      ENUMS,
    );
    expect(mapped.sortText).toBe('0__main');
    expect(mapped.filterText).toBe('main');
    expect(mapped.detail).toBe('static Camera main');
  });

  it('marks a deprecated item however the server flagged it', () => {
    expect(toMonacoCompletionItem(item({ tags: [1] }), WORD_RANGE, ENUMS).tags).toEqual([
      ENUMS.deprecatedTag,
    ]);
    expect(
      toMonacoCompletionItem(item({ deprecated: true }), WORD_RANGE, ENUMS).tags,
    ).toEqual([ENUMS.deprecatedTag]);
    expect(toMonacoCompletionItem(item(), WORD_RANGE, ENUMS).tags).toBeUndefined();
  });

  it('carries additionalTextEdits, which is where the using directive lives', () => {
    // A Roslyn server completes a type from a namespace the file has not
    // imported and sends the `using` as an additional edit. Dropping it
    // inserts the identifier alone — code that does not compile.
    const mapped = toMonacoCompletionItem(
      item({
        additionalTextEdits: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            newText: 'using UnityEngine;\n',
          },
        ],
      }),
      WORD_RANGE,
      ENUMS,
    );
    expect(mapped.additionalTextEdits).toEqual([
      {
        range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
        text: 'using UnityEngine;\n',
      },
    ]);
  });

  it('keeps the raw item so resolve can hand it back', () => {
    // `data` is opaque; a server given a rebuilt item cannot look up what it
    // cached against it, and resolve silently returns nothing.
    const raw = item({ data: { cacheId: 42 } });
    expect(toMonacoCompletionItem(raw, WORD_RANGE, ENUMS)._lsp).toBe(raw);
  });

  it('folds a hoisted data field back into the item resolve receives', () => {
    // A server that puts `data` in `itemDefaults` — which the client
    // advertises support for — would otherwise get back an item with no
    // `data` at all and be unable to resolve it.
    const mapped = toMonacoCompletionItem(item(), WORD_RANGE, ENUMS, {
      data: { cacheId: 7 },
    });
    expect(mapped._lsp?.data).toEqual({ cacheId: 7 });
  });

  it('lets an item keep its own data over the default', () => {
    const mapped = toMonacoCompletionItem(item({ data: 'mine' }), WORD_RANGE, ENUMS, {
      data: 'default',
    });
    expect(mapped._lsp?.data).toBe('mine');
  });

  describe('itemDefaults', () => {
    // The client advertises support for these, and advertising is a promise: a
    // server may then hoist the fields out of every item and send them once.

    it('applies a default edit range to an item with no edit of its own', () => {
      const mapped = toMonacoCompletionItem(item(), WORD_RANGE, ENUMS, {
        editRange: {
          start: { line: 2, character: 4 },
          end: { line: 2, character: 8 },
        },
      });
      expect(mapped.range).toEqual({
        startLineNumber: 3,
        startColumn: 5,
        endLineNumber: 3,
        endColumn: 9,
      });
    });

    it('applies a default insertTextFormat, so snippets stay snippets', () => {
      expect(
        toMonacoCompletionItem(item(), WORD_RANGE, ENUMS, { insertTextFormat: 2 })
          .insertTextRules,
      ).toBe(ENUMS.insertAsSnippet);
    });

    it('applies default commit characters', () => {
      expect(
        toMonacoCompletionItem(item(), WORD_RANGE, ENUMS, { commitCharacters: ['.', ';'] })
          .commitCharacters,
      ).toEqual(['.', ';']);
    });

    it('lets the item override every default', () => {
      const mapped = toMonacoCompletionItem(
        item({
          insertTextFormat: 1,
          commitCharacters: [','],
          textEdit: {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            newText: 'x',
          },
        }),
        WORD_RANGE,
        ENUMS,
        {
          insertTextFormat: 2,
          commitCharacters: ['.'],
          editRange: { start: { line: 9, character: 9 }, end: { line: 9, character: 9 } },
        },
      );
      expect(mapped.insertTextRules).toBeUndefined();
      expect(mapped.commitCharacters).toEqual([',']);
      expect(mapped.range).toEqual({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: 2,
      });
    });
  });
});

describe('mapCompletionList', () => {
  it('maps a bare array and a CompletionList identically', () => {
    const items = [item({ label: 'a' }), item({ label: 'b' })];
    const fromArray = mapCompletionList(items, WORD_RANGE, ENUMS, DEFAULT);
    const fromList = mapCompletionList(
      { isIncomplete: false, items },
      WORD_RANGE,
      ENUMS,
      DEFAULT,
    );
    expect(fromArray.suggestions).toEqual(fromList.suggestions);
  });

  it('treats a null response as no suggestions rather than an error', () => {
    expect(mapCompletionList(null, WORD_RANGE, ENUMS, DEFAULT)).toEqual({
      suggestions: [],
      incomplete: false,
    });
  });

  it('honours isIncomplete for a server that reports it truthfully', () => {
    expect(
      mapCompletionList({ isIncomplete: true, items: [] }, WORD_RANGE, ENUMS, DEFAULT)
        .incomplete,
    ).toBe(true);
  });

  it('ignores isIncomplete for csharp-ls, which sets it unconditionally', () => {
    // csharp-ls hardcodes `IsIncomplete = true` and filters nothing, so
    // honouring it re-runs Roslyn over the whole document on every keystroke
    // and re-ships thousands of items. Monaco filters a complete list locally.
    expect(
      mapCompletionList({ isIncomplete: true, items: [] }, WORD_RANGE, ENUMS, CSHARP)
        .incomplete,
    ).toBe(false);
  });

  it('passes itemDefaults from the list down to every item', () => {
    const { suggestions } = mapCompletionList(
      {
        isIncomplete: false,
        items: [item({ label: 'a' }), item({ label: 'b' })],
        itemDefaults: { insertTextFormat: 2 },
      },
      WORD_RANGE,
      ENUMS,
      DEFAULT,
    );
    expect(suggestions.map((s) => s.insertTextRules)).toEqual([
      ENUMS.insertAsSnippet,
      ENUMS.insertAsSnippet,
    ]);
  });
});

describe('mergeResolvedItem', () => {
  const base = toMonacoCompletionItem(item({ detail: 'original' }), WORD_RANGE, ENUMS);

  it('adds the documentation the server computed on demand', () => {
    const merged = mergeResolvedItem(base, item({ documentation: 'The main camera.' }));
    expect(merged.documentation).toEqual({ value: 'The main camera.' });
  });

  it('keeps what is already on screen when resolve answers with less', () => {
    // A resolve that returns a barer item must not blank the widget.
    expect(mergeResolvedItem(base, item()).detail).toBe('original');
    expect(mergeResolvedItem(base, null).detail).toBe('original');
    expect(mergeResolvedItem(base, undefined)).toBe(base);
  });

  it('takes additionalTextEdits computed lazily on resolve', () => {
    // The case that makes this worth doing: a server that sends docs eagerly
    // and the import edit only when asked.
    const merged = mergeResolvedItem(
      base,
      item({
        additionalTextEdits: [
          {
            range: { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } },
            newText: 'using System.Collections;\n',
          },
        ],
      }),
    );
    expect(merged.additionalTextEdits).toEqual([
      {
        range: { startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 1 },
        text: 'using System.Collections;\n',
      },
    ]);
  });

  it('does not disturb the fields resolve has no say over', () => {
    const merged = mergeResolvedItem(base, item({ detail: 'resolved', label: 'other' }));
    expect(merged.detail).toBe('resolved');
    expect(merged.label).toBe('main');
    expect(merged.range).toEqual(WORD_RANGE);
  });
});

describe('isAfterDot', () => {
  it('recognises a member-access position', () => {
    expect(isAfterDot('        transform.')).toBe(true);
    expect(isAfterDot('        Camera.')).toBe(true);
    expect(isAfterDot('        Camera. ')).toBe(true);
  });

  it('does not fire once a member name is being typed', () => {
    expect(isAfterDot('        Camera.ma')).toBe(false);
    expect(isAfterDot('        var x = 1')).toBe(false);
    expect(isAfterDot('')).toBe(false);
  });
});

describe('shouldOfferLifecycleSnippets', () => {
  it('offers them at a bare member position', () => {
    expect(shouldOfferLifecycleSnippets('    ')).toBe(true);
    expect(shouldOfferLifecycleSnippets('    Upd')).toBe(true);
    expect(shouldOfferLifecycleSnippets('')).toBe(true);
  });

  it('withholds them once modifiers or a return type are typed', () => {
    // The snippet carries its own `private void`, so accepting it here would
    // produce `private void private void Update()`.
    expect(shouldOfferLifecycleSnippets('    private void ')).toBe(false);
    expect(shouldOfferLifecycleSnippets('    private ')).toBe(false);
    expect(shouldOfferLifecycleSnippets('    protected override ')).toBe(false);
  });

  it('withholds them after a dot, where a method cannot be declared', () => {
    // This is the regression: 31 snippets sorted above every real member,
    // in every completion list in the file, including `transform.|`.
    expect(shouldOfferLifecycleSnippets('        transform.')).toBe(false);
  });

  it('withholds them mid-expression', () => {
    expect(shouldOfferLifecycleSnippets('        var x = Upd')).toBe(false);
    expect(shouldOfferLifecycleSnippets('        DoThing(Upd')).toBe(false);
    expect(shouldOfferLifecycleSnippets('        return ')).toBe(false);
  });
});

describe('filterStaticSuggestions', () => {
  const statics = [{ label: 'Transform' }, { label: 'Vector3' }, { label: 'Rigidbody' }];

  it('drops names the language server already offered', () => {
    expect(filterStaticSuggestions(statics, new Set(['Vector3']))).toEqual([
      { label: 'Transform' },
      { label: 'Rigidbody' },
    ]);
  });

  it('keeps everything when the server has offered nothing', () => {
    // The fallbacks exist precisely for that window.
    expect(filterStaticSuggestions(statics, new Set())).toEqual(statics);
  });
});
