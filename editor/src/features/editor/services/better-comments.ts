import type { Monaco } from '@monaco-editor/react';
import type { editor as MonacoEditorNs, IDisposable } from 'monaco-editor';
import { useSettingsStore } from '../../../stores/settings';

const COMMENT_TOKEN = 1;
const STRING_TOKEN = 2;

interface LineTokens {
  getCount(): number;
  getStartOffset(i: number): number;
  getEndOffset(i: number): number;
  getStandardTokenType(i: number): number;
}
interface ModelWithTokens {
  getLineTokens(lineNumber: number): LineTokens;
}

const TAG_PATTERNS: Array<{ regex: RegExp; className: string }> = [
  { regex: /^[!]\s/, className: 'bc-important' },
  { regex: /^[?]\s/, className: 'bc-question' },
  { regex: /^[*]\s(?!\/)/, className: 'bc-highlight' },
  { regex: /^\/\/\s?/, className: 'bc-strikethrough' },
  { regex: /^todo\b/i, className: 'bc-todo' },
  { regex: /^fixme\b/i, className: 'bc-fixme' },
  { regex: /^hack\b/i, className: 'bc-hack' },
  { regex: /^note\b/i, className: 'bc-note' },
];

const COMMENT_PREFIX_RE = /^\s*(\/\/+|#+|\/\*+|\*+)\s?/;

interface BetterCommentsState {
  collection: MonacoEditorNs.IEditorDecorationsCollection;
  contentDispose: IDisposable;
  modelDispose: IDisposable;
  settingsUnsub: () => void;
  scheduled: ReturnType<typeof setTimeout> | null;
}

const STATES = new WeakMap<MonacoEditorNs.IStandaloneCodeEditor, BetterCommentsState>();

function classifyTag(payload: string): string | null {
  const t = payload.trim();
  if (!t) return null;
  for (const { regex, className } of TAG_PATTERNS) {
    if (regex.test(t)) return className;
  }
  return null;
}

function lineFirstTokenIsComment(
  model: MonacoEditorNs.ITextModel,
  lineNumber: number,
  prefixCol: number
): boolean {
  try {
    const tokens = (model as unknown as ModelWithTokens).getLineTokens(lineNumber);
    const count = tokens.getCount();
    for (let i = 0; i < count; i++) {
      const start = tokens.getStartOffset(i);
      const end = tokens.getEndOffset(i);
      if (prefixCol >= start && prefixCol < end) {
        const type = tokens.getStandardTokenType(i);
        return type === COMMENT_TOKEN;
      }
    }
  } catch {
    return true;
  }
  return false;
}

function lineHasUnterminatedString(
  model: MonacoEditorNs.ITextModel,
  lineNumber: number
): boolean {
  try {
    const tokens = (model as unknown as ModelWithTokens).getLineTokens(lineNumber);
    const count = tokens.getCount();
    if (count === 0) return false;
    return tokens.getStandardTokenType(count - 1) === STRING_TOKEN;
  } catch {
    return false;
  }
}

function buildDecorations(
  model: MonacoEditorNs.ITextModel,
  monaco: Monaco
): MonacoEditorNs.IModelDeltaDecoration[] {
  const result: MonacoEditorNs.IModelDeltaDecoration[] = [];
  const lineCount = model.getLineCount();
  if (lineCount > 50_000) return result;

  for (let line = 1; line <= lineCount; line++) {
    const text = model.getLineContent(line);
    const m = COMMENT_PREFIX_RE.exec(text);
    if (!m) continue;
    const prefixEnd = m[0].length;
    const prefixCol = m.index + (m[0].length - m[0].trimStart().length);
    if (!lineFirstTokenIsComment(model, line, prefixCol)) continue;
    if (lineHasUnterminatedString(model, line)) continue;

    const payload = text.slice(prefixEnd);
    const className = classifyTag(payload);
    if (!className) continue;

    result.push({
      range: new monaco.Range(line, 1, line, text.length + 1),
      options: {
        inlineClassName: `bc-line ${className}`,
        isWholeLine: false,
      },
    });
  }
  return result;
}

function refresh(
  editor: MonacoEditorNs.IStandaloneCodeEditor,
  monaco: Monaco,
  state: BetterCommentsState
) {
  const model = editor.getModel();
  if (!model) {
    state.collection.set([]);
    return;
  }
  if (!useSettingsStore.getState().settings['editor.betterComments']) {
    state.collection.set([]);
    return;
  }
  state.collection.set(buildDecorations(model, monaco));
}

function scheduleRefresh(
  editor: MonacoEditorNs.IStandaloneCodeEditor,
  monaco: Monaco,
  state: BetterCommentsState
) {
  if (state.scheduled) clearTimeout(state.scheduled);
  state.scheduled = setTimeout(() => {
    state.scheduled = null;
    refresh(editor, monaco, state);
  }, 150);
}

export function registerBetterComments(
  editor: MonacoEditorNs.IStandaloneCodeEditor,
  monaco: Monaco
): void {
  if (STATES.has(editor)) return;
  const collection = editor.createDecorationsCollection([]);

  const state: BetterCommentsState = {
    collection,
    contentDispose: { dispose: () => {} },
    modelDispose: { dispose: () => {} },
    settingsUnsub: () => {},
    scheduled: null,
  };

  function bindModel(model: MonacoEditorNs.ITextModel | null) {
    state.contentDispose.dispose();
    if (!model) {
      collection.set([]);
      return;
    }
    state.contentDispose = model.onDidChangeContent(() => scheduleRefresh(editor, monaco, state));
    refresh(editor, monaco, state);
  }

  bindModel(editor.getModel());
  state.modelDispose = editor.onDidChangeModel(() => bindModel(editor.getModel()));
  state.settingsUnsub = useSettingsStore.subscribe(() => refresh(editor, monaco, state));

  editor.onDidDispose(() => disposeBetterComments(editor));
  STATES.set(editor, state);
}

export function disposeBetterComments(editor: MonacoEditorNs.IStandaloneCodeEditor): void {
  const state = STATES.get(editor);
  if (!state) return;
  if (state.scheduled) clearTimeout(state.scheduled);
  state.contentDispose.dispose();
  state.modelDispose.dispose();
  state.settingsUnsub();
  state.collection.clear();
  STATES.delete(editor);
}
