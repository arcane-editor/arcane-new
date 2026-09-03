import type { Monaco } from '@monaco-editor/react';
import type { languages, editor, IRange } from 'monaco-editor';
import { USS_PROPERTIES, USS_PSEUDO } from './data/uss';
import { UXML_ELEMENTS, UXML_ATTRIBUTES } from './data/uxml';

export { UnityUiPanel } from './components/UnityUiPanel';
export { UxmlPreviewEditor, isUxmlFile } from './components/UxmlPreviewEditor';
export { loadUiToolkitSummary } from './services/uxml-assets';
export type { UiToolkitSummary } from './services/uxml-assets';

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

/**
 * Teach Monaco's CSS worker about USS before it validates a `.uss` file.
 *
 * **The bug this fixes, which predates the feature it was written for.**
 * `.uss` is mapped to the `css` language (`utils/language-detect.ts`) and
 * `monaco-workers.ts` routes the real `css.worker` for that label — but nothing
 * ever configured it. Monaco's default `lint.unknownProperties` is `warning`,
 * so every `-unity-font`, `-unity-text-align` and `-unity-slice-left` in every
 * `.uss` file has been showing "Unknown property" under marker owner `css`,
 * while `box-shadow` — which USS genuinely does not support — passed clean.
 * Exactly backwards.
 *
 * **The trade-off, stated because it is real.** `cssDefaults` is global to the
 * `css` language, so a real `.css` file also stops flagging `-unity-*`
 * properties. That is harmless (nobody writes `-unity-font` in CSS) and it is
 * the only lever Monaco offers — the alternative is `validate: false`, which
 * would disable CSS validation outright.
 */
/** The slice of Monaco's CSS defaults we use, in either build's shape. */
interface CssDefaultsLike {
  options?: Record<string, unknown>;
  setOptions(options: Record<string, unknown>): void;
}

/**
 * Find `cssDefaults` in whichever Monaco build is actually running.
 *
 * There are two, and they disagree. The ESM build moved CSS defaults to a
 * TOP-LEVEL `css` namespace and left `monaco.languages.css` as a deprecation
 * stub typed `{ deprecated: true }`. The AMD bundle — which is what actually
 * loads here, since `@monaco-editor/loader` defaults to
 * `cdn.jsdelivr.net/npm/monaco-editor@0.55.1/min/vs` and nothing calls
 * `loader.config` — still exposes the classic `monaco.languages.css` path.
 * Picking one would silently no-op on the other, which is precisely the class
 * of bug being fixed here.
 */
function findCssDefaults(monaco: Monaco): CssDefaultsLike | null {
  const probe = monaco as unknown as {
    css?: { cssDefaults?: CssDefaultsLike };
    languages?: { css?: { cssDefaults?: CssDefaultsLike } };
  };
  const candidate = probe.css?.cssDefaults ?? probe.languages?.css?.cssDefaults;
  return typeof candidate?.setOptions === 'function' ? candidate : null;
}

function configureUssValidation(monaco: Monaco): void {
  const cssDefaults = findCssDefaults(monaco);
  if (!cssDefaults) {
    // Observable rather than silent: if this ever fires, `.uss` files are back
    // to being told `-unity-font` is an unknown property, and nothing else in
    // the app would reveal it.
    console.warn(
      '[uitoolkit] Monaco CSS defaults not found — .uss files will show spurious ' +
      '"Unknown property" warnings for -unity-* properties.',
    );
    return;
  }
  try {
    cssDefaults.setOptions({
      ...cssDefaults.options,
      data: {
        useDefaultDataProvider: true,
        dataProviders: {
          uss: {
            version: 1.1,
            properties: USS_PROPERTIES.map((name) => ({
              name,
              description: name.startsWith('-unity-')
                ? 'Unity Style Sheets (USS) property.'
                : undefined,
            })),
          },
        },
      },
    });
  } catch (err) {
    // A Monaco version without CSS custom data must not take the editor down;
    // the worst case is the pre-existing wrong warnings, which is where we were.
    console.warn('[uitoolkit] could not configure USS validation:', err);
  }
}

export function registerUiToolkit(monaco: Monaco): void {
  if (registered) return;
  registered = true;

  configureUssValidation(monaco);

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
