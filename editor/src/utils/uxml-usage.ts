// "What happens when I click this?" — the behaviour a project's C# attaches to
// a UI Toolkit element.
//
// The asset knows an element is a Button. It cannot know what the Button does,
// because that lives in C# and is joined to the asset by a bare string. Unity's
// UI Builder cannot show it (no code index) and a language server cannot show it
// (no asset semantics). This is the join.
//
// Modelled on `unity-input/services/action-refs.ts`, which does the same shape
// of work for input actions: find the string literals, bind whatever locals they
// were assigned to, then attribute the callbacks to the right element.
//
// A leaf module: no imports, so it loads under Bun's DOM-less test runtime.

export type UsageKind =
  /** `root.Q<Button>("play")` — reaching the element. */
  | 'query'
  /** `btn.clicked += Go` — a Button's own event. */
  | 'clicked'
  /** `el.RegisterCallback<ClickEvent>(Go)` — the general event path. */
  | 'callback'
  /** `field.RegisterValueChangedCallback(Go)`. */
  | 'value-changed'
  /** `el.style.display = …`, `el.SetEnabled(…)` — the element is mutated. */
  | 'mutation';

export interface ElementUsage {
  elementName: string;
  kind: UsageKind;
  /** `clicked`, `ClickEvent`, `SetEnabled` … — what is being attached or called. */
  event: string | null;
  /** The method that runs, when one is named. */
  handler: string | null;
  /** Line of the handler's own declaration, when it is in this file. */
  handlerLine: number | null;
  filePath: string;
  /** 1-based. */
  line: number;
  column: number;
  snippet: string;
}

const QUERY_RE = /\.\s*(?:Q|Query)\s*(?:<\s*([\w.]+)\s*>)?\s*\(\s*"((?:[^"\\]|\\.)*)"/g;
/** `var play = root.Q<Button>("play-button")` — binds a local to an element. */
const ASSIGN_RE =
  /\b(?:var|[\w.<>]+)\s+(\w+)\s*=\s*[^;\n]*?\.\s*(?:Q|Query)\s*(?:<[^<>()]*>)?\s*\(\s*"((?:[^"\\]|\\.)*)"/g;
const CLICKED_RE = /\b(\w+)\s*\.\s*clicked\s*\+=\s*([\w.]+)/g;
const REGISTER_RE = /\b(\w+)\s*\.\s*RegisterCallback\s*<\s*(\w+)\s*>\s*\(\s*([\w.]+)/g;
const VALUE_RE = /\b(\w+)\s*\.\s*RegisterValueChangedCallback\s*\(\s*([\w.]+)/g;
const MUTATE_RE = /\b(\w+)\s*\.\s*(SetEnabled|AddToClassList|RemoveFromClassList|ToggleInClassList|Focus|Blur)\s*\(/g;
const METHOD_RE = /\b(?:void|async\s+void|IEnumerator)\s+(\w+)\s*\(/g;

/** Byte offset -> 1-based line/column, plus the trimmed source line. */
function locate(text: string, offset: number) {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  let lineEnd = text.indexOf('\n', lineStart);
  if (lineEnd === -1) lineEnd = text.length;
  return {
    line,
    column: offset - lineStart + 1,
    snippet: text.slice(lineStart, lineEnd).trim(),
  };
}

/**
 * Every behaviour this file attaches to one of `names`.
 *
 * Matching runs on `code` — the comment/string-blanked view, which preserves
 * offsets — and the literal values are read back out of `text` at the same
 * offsets, so a call inside a comment never counts.
 */
export function findElementUsages(
  filePath: string,
  code: string,
  text: string,
  names: readonly string[],
): ElementUsage[] {
  if (names.length === 0) return [];
  const known = new Set(names);
  const out: ElementUsage[] = [];

  /** Local variable -> the element it was assigned from. */
  const elementOfLocal = new Map<string, string>();
  /** Method name -> the line it is declared on, for "go to handler". */
  const methodLines = new Map<string, number>();

  METHOD_RE.lastIndex = 0;
  for (let m = METHOD_RE.exec(code); m !== null; m = METHOD_RE.exec(code)) {
    methodLines.set(m[1], locate(text, m.index).line);
  }

  const push = (
    offset: number,
    elementName: string,
    kind: UsageKind,
    event: string | null,
    handler: string | null,
  ) => {
    const { line, column, snippet } = locate(text, offset);
    out.push({
      elementName,
      kind,
      event,
      handler,
      handlerLine: handler ? methodLines.get(handler) ?? null : null,
      filePath,
      line,
      column,
      snippet,
    });
  };

  ASSIGN_RE.lastIndex = 0;
  for (let m = ASSIGN_RE.exec(code); m !== null; m = ASSIGN_RE.exec(code)) {
    const open = m.index + m[0].indexOf('"') + 1;
    const name = text.slice(open, open + m[2].length);
    if (known.has(name)) elementOfLocal.set(m[1], name);
  }

  // Queries, plus anything chained directly onto them. The chained form is by
  // far the most common: `root.Q<Button>("play").clicked += Go;` never touches
  // a local, so binding locals alone would miss it entirely.
  QUERY_RE.lastIndex = 0;
  for (let m = QUERY_RE.exec(code); m !== null; m = QUERY_RE.exec(code)) {
    const start = m.index + m[0].indexOf('"') + 1;
    const name = text.slice(start, start + m[2].length);
    if (!known.has(name)) continue;

    const after = code.slice(m.index + m[0].length, m.index + m[0].length + 160);
    const clicked = /^\s*"?\s*\)\s*\.\s*clicked\s*\+=\s*([\w.]+)/.exec(after);
    const registered = /^\s*"?\s*\)\s*\.\s*RegisterCallback\s*<\s*(\w+)\s*>\s*\(\s*([\w.]+)/.exec(after);
    const valued = /^\s*"?\s*\)\s*\.\s*RegisterValueChangedCallback\s*\(\s*([\w.]+)/.exec(after);
    // `root.Q<Button>("x").SetEnabled(true)` — chained like the others, and
    // just as much a thing that happens to the element.
    const mutated = /^\s*"?\s*\)\s*\.\s*(SetEnabled|AddToClassList|RemoveFromClassList|ToggleInClassList|Focus|Blur)\s*\(/.exec(after);

    if (clicked) push(start, name, 'clicked', 'clicked', clicked[1]);
    else if (registered) push(start, name, 'callback', registered[1], registered[2]);
    else if (valued) push(start, name, 'value-changed', 'ValueChanged', valued[1]);
    else if (mutated) push(start, name, 'mutation', mutated[1], null);
    else push(start, name, 'query', null, null);
  }

  // The same events, reached through a local bound earlier.
  const viaLocal: Array<[RegExp, (m: RegExpExecArray) => [UsageKind, string, string]]> = [
    [CLICKED_RE, (m) => ['clicked', 'clicked', m[2]]],
    [REGISTER_RE, (m) => ['callback', m[2], m[3]]],
    [VALUE_RE, (m) => ['value-changed', 'ValueChanged', m[2]]],
  ];
  for (const [re, read] of viaLocal) {
    re.lastIndex = 0;
    for (let m = re.exec(code); m !== null; m = re.exec(code)) {
      const element = elementOfLocal.get(m[1]);
      if (!element) continue;
      const [kind, event, handler] = read(m);
      push(m.index, element, kind, event, handler);
    }
  }

  MUTATE_RE.lastIndex = 0;
  for (let m = MUTATE_RE.exec(code); m !== null; m = MUTATE_RE.exec(code)) {
    const element = elementOfLocal.get(m[1]);
    if (!element) continue;
    push(m.index, element, 'mutation', m[2], null);
  }

  return out.sort((a, b) => a.line - b.line || a.column - b.column);
}

/** Human phrasing for one usage, for the inspector row. */
export function describeUsage(u: ElementUsage): string {
  switch (u.kind) {
    case 'clicked':
      return `on click → ${u.handler}()`;
    case 'callback':
      return `on ${u.event} → ${u.handler}()`;
    case 'value-changed':
      return `on value changed → ${u.handler}()`;
    case 'mutation':
      return `${u.event}()`;
    case 'query':
      return 'looked up, no behaviour attached here';
  }
}
