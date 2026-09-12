/**
 * Structural edits to a plan's `## Todos` checklist — add, remove, reorder.
 *
 * `block-edit.ts` next door can rewrite the TEXT of anything already in the
 * document and tick a checkbox; it cannot change what todos exist. That gap is
 * why a plan could only be argued with, never edited: the one thing a reviewer
 * most often wants ("this needs a step before it", "drop this one", "do that
 * first") had no affordance at all.
 *
 * The hard part is that a plan keeps the same information twice, joined by an
 * id: a `- [ ] T<n> <title>` line under `## Todos`, and a `### T<n>: <title>`
 * entry under `## Guide` carrying the detail. `plan-todos.ts` reads the first,
 * `prompts/plan-execution.ts` sends the model to the second, and the executor
 * ticks boxes by that id. Renumbering one half alone would leave the executor
 * reading step 4's instructions while ticking step 3's box.
 *
 * So every edit here moves BOTH halves and then renumbers the ids
 * sequentially. Everything else in the file is preserved byte for byte —
 * these operate on whole lines and never re-serialize the document.
 *
 * Resilience matches `plan-todos.ts`'s contract, and for the same reason:
 * these are hand-edited files, and the worst outcome is mangling something a
 * user wrote. Anything unrecognised is left exactly as it is — a plan with no
 * `## Guide`, a guide entry no todo claims, a checkbox with no `T<n>` id, or
 * no todos at all are all handled by doing less, never by guessing.
 */

/** Same shape `plan-todos.ts` parses, anchored per line. */
const CHECKBOX = /^(\s*[-*]\s+\[[ xX]\]\s+)(?:(T\d+)\s+)?(.*)$/;
/** A guide entry heading: `### T3: Title`, or `### T3 Title`, or bare. */
const GUIDE_HEAD = /^###\s+(T\d+)\b\s*:?\s*(.*)$/;

interface TodoLine {
  /** Index into the document's line array. */
  line: number;
  /** The id as written, or null when the line never had one. */
  id: string | null;
}

interface GuideBlock {
  id: string;
  /** Inclusive first line (the `###` heading). */
  start: number;
  /** Exclusive end — the next heading at any level, or EOF. */
  end: number;
}

function findTodos(lines: string[]): TodoLine[] {
  const out: TodoLine[] = [];
  lines.forEach((text, line) => {
    const m = text.match(CHECKBOX);
    if (m) out.push({ line, id: m[2] ?? null });
  });
  return out;
}

function findGuides(lines: string[]): GuideBlock[] {
  const heads: Array<{ id: string; start: number }> = [];
  lines.forEach((text, i) => {
    const m = text.match(GUIDE_HEAD);
    if (m) heads.push({ id: m[1], start: i });
  });
  return heads.map(({ id, start }) => {
    let end = start + 1;
    // A guide entry owns everything up to the next heading of any level.
    while (end < lines.length && !/^#{1,6}\s/.test(lines[end])) end++;
    return { id, start, end };
  });
}

/**
 * Rewrites one checkbox line to carry `id`, inserting it if it had none.
 *
 * Trims a trailing SPACE only (an id with no title behind it), never all
 * trailing whitespace: `renumber` rewrites every checkbox line on every edit,
 * and on a CRLF file a blanket `trimEnd()` would strip the `\r` from each of
 * them while leaving every other line's intact — turning a hand-edited plan
 * into one with mixed line endings.
 */
function setTodoId(text: string, id: string): string {
  const m = text.match(CHECKBOX);
  if (!m) return text;
  const rest = m[3];
  return rest === '' ? `${m[1]}${id}` : `${m[1]}${id} ${rest}`;
}

/**
 * Assigns T1..Tn down the checklist and applies the same mapping to the guide
 * headings. Each line is rewritten once, from its OWN previous id, so ids
 * being swapped (a move) can never collide part-way through.
 */
function renumber(lines: string[]): string[] {
  const out = [...lines];
  const todos = findTodos(out);
  const map = new Map<string, string>();

  todos.forEach((t, i) => {
    const next = `T${i + 1}`;
    if (t.id) map.set(t.id, next);
    out[t.line] = setTodoId(out[t.line], next);
  });

  for (const g of findGuides(out)) {
    const next = map.get(g.id);
    // No mapping means no todo claims this entry. It was already orphaned
    // before this edit; renaming it would only make it harder to find.
    if (!next) continue;
    out[g.start] = out[g.start].replace(GUIDE_HEAD, (_all, _id, rest) =>
      rest ? `### ${next}: ${rest}` : `### ${next}`,
    );
  }
  return out;
}

/** Splices a guide block out of the line array, returning it and the rest. */
function cutGuide(lines: string[], id: string | null): { rest: string[]; block: string[] } {
  if (!id) return { rest: lines, block: [] };
  const g = findGuides(lines).find((b) => b.id === id);
  if (!g) return { rest: lines, block: [] };
  return {
    rest: [...lines.slice(0, g.start), ...lines.slice(g.end)],
    block: lines.slice(g.start, g.end),
  };
}

/** How many todos the document declares. */
export function todoCount(source: string): number {
  if (typeof source !== 'string') return 0;
  return findTodos(source.split('\n')).length;
}

/**
 * Removes the todo at `index` (0-based, document order) and the guide entry
 * that shares its id.
 */
export function removeTodoAt(source: string, index: number): string {
  const lines = source.split('\n');
  const todos = findTodos(lines);
  if (index < 0 || index >= todos.length) return source;

  const { id, line } = todos[index];
  const { rest } = cutGuide(lines, id);
  // The guide cut may have shifted the checkbox line, so find it by content
  // position rather than trusting the pre-cut index.
  const checkboxAt = id
    ? findTodos(rest).findIndex((t) => t.id === id)
    : index;
  const without =
    checkboxAt >= 0
      ? (() => {
          const at = findTodos(rest)[checkboxAt].line;
          return [...rest.slice(0, at), ...rest.slice(at + 1)];
        })()
      : [...lines.slice(0, line), ...lines.slice(line + 1)];

  return renumber(without).join('\n');
}

/**
 * Inserts a new todo after `index` (pass -1 for the top of the list), with a
 * matching guide stub placed after that todo's own guide entry. The id is
 * assigned by the renumber pass, so callers never choose one.
 */
export function insertTodoAfter(source: string, index: number, title: string): string {
  const lines = source.split('\n');
  const todos = findTodos(lines);
  if (todos.length === 0) return source;
  if (index < -1 || index >= todos.length) return source;

  const text = title.trim() || 'New step';
  // A placeholder id keeps the new rows findable through the splices below;
  // renumber() replaces it along with everything else.
  const NEW = 'T0';

  let out = [...lines];
  const anchor = index === -1 ? todos[0].line : todos[index].line + 1;
  out = [...out.slice(0, anchor), `- [ ] ${NEW} ${text}`, ...out.slice(anchor)];

  // Place the stub after the anchor todo's guide entry when there is one; if
  // this plan has no Guide section at all, the checklist edit stands alone
  // rather than inventing a section the document never had.
  const guides = findGuides(out);
  if (guides.length > 0) {
    const anchorId = index === -1 ? null : todos[index].id;
    const after = anchorId ? guides.find((g) => g.id === anchorId) : null;
    const at = after ? after.end : index === -1 ? guides[0].start : guides[guides.length - 1].end;
    out = [...out.slice(0, at), `### ${NEW}: ${text}`, '', ...out.slice(at)];
  }

  return renumber(out).join('\n');
}

/** Moves the todo at `from` to position `to`, guide entry included. */
export function moveTodo(source: string, from: number, to: number): string {
  const lines = source.split('\n');
  const todos = findTodos(lines);
  if (from === to) return source;
  if (from < 0 || from >= todos.length) return source;
  if (to < 0 || to >= todos.length) return source;

  const moved = todos[from];
  const checkboxText = lines[moved.line];

  // Pull the guide entry first: cutting it shifts nothing above it, and the
  // checkbox lines all sit above `## Guide` in the template.
  const { rest, block } = cutGuide(lines, moved.id);
  const afterCheckboxCut = (() => {
    const t = findTodos(rest);
    const at = moved.id ? t.find((x) => x.id === moved.id)?.line : t[from]?.line;
    return at === undefined ? rest : [...rest.slice(0, at), ...rest.slice(at + 1)];
  })();

  // Re-insert the checkbox at the target slot.
  const remaining = findTodos(afterCheckboxCut);
  const insertAt =
    to >= remaining.length
      ? remaining[remaining.length - 1].line + 1
      : remaining[to].line;
  let out = [
    ...afterCheckboxCut.slice(0, insertAt),
    checkboxText,
    ...afterCheckboxCut.slice(insertAt),
  ];

  // Re-insert the guide block at the matching slot among the guide entries.
  if (block.length > 0) {
    const guides = findGuides(out);
    const gAt =
      guides.length === 0
        ? out.length
        : to >= guides.length
          ? guides[guides.length - 1].end
          : guides[to].start;
    out = [...out.slice(0, gAt), ...block, ...out.slice(gAt)];
  }

  return renumber(out).join('\n');
}
