import type { Monaco } from '@monaco-editor/react';
import { LIFECYCLE_METHOD_NAMES, UNITY_LIFECYCLE_METHODS } from './lifecycle-db';
import { UNITY_API_NAMES } from '../../../data/unity-api-names';

export type UnityDecorationKind = 'lifecycle' | 'engine-type' | 'inspector-attribute';

export interface UnityDecoration {
  /** 1-based, matching Monaco. */
  line: number;
  /** 1-based, matching Monaco. */
  startColumn: number;
  endColumn: number;
  kind: UnityDecorationKind;
  hover?: string;
}

// Attributes that put a field in the Inspector. [Header] and [Range] only
// render when the field itself is serialized, but they always accompany one,
// so marking them keeps the block visually contiguous.
const INSPECTOR_ATTRS =
  /\[\s*(SerializeField|Header|Range|Tooltip|Space|TextArea|Multiline|HideInInspector)\b/g;

// A method declaration: optional modifiers, then a return type, then a name.
// Regex, not a parser — see the note on false positives below.
const METHOD_DECL =
  /(?:(?:private|protected|public|internal|static|virtual|override|sealed|abstract)\s+)*(?:void|IEnumerator)\s+(\w+)\s*\(/g;

const IDENTIFIER = /\b([A-Z]\w*)\b/g;

// `kind: 'type'` only — the list also carries methods and properties, and C#
// method names are capitalised, so an unfiltered set would paint
// `GetComponent` as a type.
//
// This list is a fallback COMPLETION list, not an exhaustive Unity type index:
// `CharacterController`, for one, is absent. Engine-type colouring therefore
// has false negatives — a real Unity type that is missing here renders as a
// user type. That is a quiet, acceptable degradation for a highlight; widening
// it means growing the data file, not changing this function.
const ENGINE_NAMES: ReadonlySet<string> = new Set(
  UNITY_API_NAMES.filter((n) => n.kind === 'type').map((n) => n.name),
);

/**
 * Classify the Unity-meaningful spans in a C# source file.
 *
 * Pure and synchronous so it can be unit-tested without Monaco or a DOM, and
 * so the editor never flickers waiting on a language server.
 *
 * KNOWN LIMITATION: this is regex-based, not a parser. A user-defined
 * `void Update()` on a class that does not derive from MonoBehaviour is
 * coloured as a lifecycle method. That is acceptable for a highlight; it would
 * not be acceptable for a diagnostic.
 */
export function computeUnityDecorations(text: string): UnityDecoration[] {
  const out: UnityDecoration[] = [];

  text.split('\n').forEach((lineText, i) => {
    const line = i + 1;

    INSPECTOR_ATTRS.lastIndex = 0;
    for (let m = INSPECTOR_ATTRS.exec(lineText); m; m = INSPECTOR_ATTRS.exec(lineText)) {
      out.push({
        line,
        startColumn: m.index + 1,
        endColumn: m.index + m[0].length + 1,
        kind: 'inspector-attribute',
      });
    }

    METHOD_DECL.lastIndex = 0;
    for (let m = METHOD_DECL.exec(lineText); m; m = METHOD_DECL.exec(lineText)) {
      if (!LIFECYCLE_METHOD_NAMES.has(m[1])) continue;
      const info = UNITY_LIFECYCLE_METHODS.find((x) => x.name === m[1]);
      const start = m.index + m[0].lastIndexOf(m[1]);
      out.push({
        line,
        startColumn: start + 1,
        endColumn: start + m[1].length + 1,
        kind: 'lifecycle',
        hover: `**Unity ${info?.category ?? 'Lifecycle'}**: \`${m[1]}\`\n\n${info?.description ?? ''}`,
      });
    }

    IDENTIFIER.lastIndex = 0;
    for (let m = IDENTIFIER.exec(lineText); m; m = IDENTIFIER.exec(lineText)) {
      if (!ENGINE_NAMES.has(m[1])) continue;
      const startColumn = m.index + 1;
      // A lifecycle mark on the same span wins — it is the more specific fact.
      if (out.some((d) => d.line === line && d.startColumn === startColumn)) continue;
      out.push({
        line,
        startColumn,
        endColumn: m.index + m[1].length + 1,
        kind: 'engine-type',
      });
    }
  });

  return out;
}

// ─── attach layer ────────────────────────────────────────────────────

type MonacoEditor = import('monaco-editor').editor.IStandaloneCodeEditor;
type Model = import('monaco-editor').editor.ITextModel;

interface State {
  collection: import('monaco-editor').editor.IEditorDecorationsCollection;
  contentDispose: import('monaco-editor').IDisposable;
  modelDispose: import('monaco-editor').IDisposable;
  scheduled: ReturnType<typeof setTimeout> | null;
}

// Per-editor, so a diff view or split editor cannot clobber its neighbour.
const STATES = new WeakMap<MonacoEditor, State>();

const CLASS_BY_KIND: Record<UnityDecorationKind, string> = {
  'lifecycle': 'unity-lifecycle-name',
  'engine-type': 'unity-engine-type-name',
  'inspector-attribute': 'unity-inspector-attr',
};

function refresh(editor: MonacoEditor, monaco: Monaco, state: State): void {
  const model = editor.getModel();
  if (!model || !model.uri.toString().endsWith('.cs')) {
    state.collection.set([]);
    return;
  }
  state.collection.set(
    computeUnityDecorations(model.getValue()).map((d) => ({
      range: new monaco.Range(d.line, d.startColumn, d.line, d.endColumn),
      options: {
        inlineClassName: CLASS_BY_KIND[d.kind],
        ...(d.kind === 'lifecycle'
          ? {
              glyphMarginClassName: 'unity-lifecycle-glyph',
              glyphMarginHoverMessage: { value: d.hover ?? '' },
            }
          : {}),
        ...(d.kind === 'inspector-attribute'
          ? { isWholeLine: true, className: 'unity-inspector-line' }
          : {}),
      },
    })),
  );
}

export function attachUnityDecorations(editor: MonacoEditor, monaco: Monaco): void {
  if (STATES.has(editor)) return;
  const state: State = {
    collection: editor.createDecorationsCollection([]),
    contentDispose: { dispose: () => {} },
    modelDispose: { dispose: () => {} },
    scheduled: null,
  };

  const schedule = () => {
    if (state.scheduled) clearTimeout(state.scheduled);
    state.scheduled = setTimeout(() => refresh(editor, monaco, state), 150);
  };

  function bindModel(model: Model | null) {
    state.contentDispose.dispose();
    if (!model) {
      state.collection.set([]);
      return;
    }
    state.contentDispose = model.onDidChangeContent(schedule);
    refresh(editor, monaco, state);
  }

  bindModel(editor.getModel());
  // The editor instance is reused across file switches — it just swaps its
  // model — so without this the decorations would be from the previous file.
  state.modelDispose = editor.onDidChangeModel(() => bindModel(editor.getModel()));
  editor.onDidDispose(() => disposeUnityDecorations(editor));
  STATES.set(editor, state);
}

export function disposeUnityDecorations(editor: MonacoEditor): void {
  const state = STATES.get(editor);
  if (!state) return;
  if (state.scheduled) clearTimeout(state.scheduled);
  state.contentDispose.dispose();
  state.modelDispose.dispose();
  state.collection.clear();
  STATES.delete(editor);
}
