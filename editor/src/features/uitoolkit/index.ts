import type { Monaco } from '@monaco-editor/react';
import type { languages, editor, IRange } from 'monaco-editor';
import { USS_PROPERTIES, USS_PSEUDO } from './data/uss';
import { UXML_ELEMENTS, UXML_ATTRIBUTES } from './data/uxml';

// UI Toolkit support (F-3.2 T7.3). Highlighting is delegated to Monaco's mature
// built-in `css` (USS) and `xml` (UXML) languages — `.uss`/`.uxml` are mapped to
// them in language-detect. Here we layer Unity-specific COMPLETIONS on top,
// scoped by file extension so nothing leaks into real CSS/XML documents.

let registered = false;
const disposers: Array<() => void> = [];

function wordRange(model: editor.ITextModel, position: { lineNumber: number; column: number }): IRange {
  const w = model.getWordUntilPosition(position);
  return {
    startLineNumber: position.lineNumber,
    endLineNumber: position.lineNumber,
    startColumn: w.startColumn,
    endColumn: w.endColumn,
  };
}

function isExt(model: editor.ITextModel, ext: string): boolean {
  return model.uri.path.toLowerCase().endsWith(ext);
}

export function registerUiToolkit(monaco: Monaco): void {
  if (registered) return;
  registered = true;

  // USS → contributes onto the `css` language, scoped to .uss files.
  const ussProvider: languages.CompletionItemProvider = {
    triggerCharacters: ['-', ':'],
    provideCompletionItems(model, position) {
      if (!isExt(model, '.uss')) return { suggestions: [] };
      const range = wordRange(model, position);
      const props = USS_PROPERTIES.map((p) => ({
        label: p,
        kind: monaco.languages.CompletionItemKind.Property,
        insertText: `${p}: `,
        range,
        detail: 'USS property',
      }));
      const pseudo = USS_PSEUDO.map((p) => ({
        label: p,
        kind: monaco.languages.CompletionItemKind.Keyword,
        insertText: p,
        range,
        detail: 'USS state',
      }));
      return { suggestions: [...props, ...pseudo] };
    },
  };

  // UXML → contributes onto the `xml` language, scoped to .uxml files.
  const uxmlProvider: languages.CompletionItemProvider = {
    triggerCharacters: ['<', ' '],
    provideCompletionItems(model, position) {
      if (!isExt(model, '.uxml')) return { suggestions: [] };
      const range = wordRange(model, position);
      const elements = UXML_ELEMENTS.map((e) => ({
        label: e,
        kind: monaco.languages.CompletionItemKind.Class,
        insertText: e,
        range,
        detail: 'UI Toolkit element',
      }));
      const attrs = UXML_ATTRIBUTES.map((a) => ({
        label: a,
        kind: monaco.languages.CompletionItemKind.Property,
        insertText: `${a}=""`,
        range,
        detail: 'UXML attribute',
      }));
      return { suggestions: [...elements, ...attrs] };
    },
  };

  disposers.push(
    monaco.languages.registerCompletionItemProvider('css', ussProvider).dispose,
    monaco.languages.registerCompletionItemProvider('xml', uxmlProvider).dispose,
  );
}

export function disposeUiToolkit(): void {
  for (const d of disposers.splice(0)) d();
  registered = false;
}
