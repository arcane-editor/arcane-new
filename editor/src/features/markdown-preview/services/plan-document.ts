/**
 * Structural parse of an `.aplan` document, for the plan view's step cards.
 *
 * An `.aplan` file is markdown — the same bytes the model wrote and the
 * executor reads — but it has a shape the plan view can render as UI instead
 * of as prose: a `## Todos` checklist where every todo has a matching
 * `### T<n>` entry under `## Guide`. Rendering those as a flat document showed
 * each step twice (once as a checkbox, once as a heading) and pushed the
 * bookkeeping the two halves use to find each other — `T3`, `[hard]` — into
 * the reader's face. This parser pairs them up so a step and its guide can be
 * one thing on screen.
 *
 * TWO CONTRACTS, both load-bearing:
 *
 * 1. **Lossless.** Every byte of the document lands in exactly one block, in
 *    document order. The renderer walks `blocks` and never has to guess. A
 *    plan the user hand-edited into a shape this doesn't recognize still shows
 *    all of its text — the parser degrades to a single markdown block rather
 *    than hiding the parts it didn't understand.
 *
 * 2. **Offsets, not copies.** Blocks carry `[start, end)` ranges into the
 *    ORIGINAL string, never extracted text. In-place editing splices by offset
 *    (`block-edit.ts`), so a block that carried a copy could not be edited
 *    back into the file it came from.
 *
 * Like `plan-todos.ts`, this NEVER throws — it backs a live view of a file the
 * user is editing by hand, and a parse failure must degrade, not blank the
 * screen.
 */

export interface PlanRange {
  start: number;
  end: number;
}

export interface PlanStepBlock {
  /**
   * 1-based position in the document.
   *
   * Derived from ORDER, never from the model's `T<n>` — a user who deletes the
   * second of five todos should see 1..4, not 1,3,4,5. The `T<n>` id stays in
   * the file untouched for the executor; it just isn't what the reader counts.
   */
  ordinal: number;
  /** Display title, with the `T<n>` id and `[easy|hard]` tag removed. */
  title: string;
  done: boolean;
  /** Any offset on the checkbox line — `toggleTaskAt` resolves the line itself. */
  checkboxOffset: number;
  /**
   * The span of `title` alone. Editing a step title splices only this range,
   * so the id and difficulty tag ahead of it survive an edit that never showed
   * them — without this, renaming a step would silently drop the tag the
   * executor routes on.
   */
  titleRange: PlanRange;
  /** This step's body under `## Guide`, when one could be matched. */
  guide: PlanRange | null;
}

export type PlanBlock =
  | { kind: 'markdown'; range: PlanRange }
  | { kind: 'steps'; steps: PlanStepBlock[] };

export interface PlanDocument {
  /**
   * False when the document has no checklist to build steps from. The view
   * renders `blocks` either way; this only says whether it got a plan or a
   * plain document, which is what decides if the step chrome is meaningful.
   */
  structured: boolean;
  blocks: PlanBlock[];
  steps: PlanStepBlock[];
}

/** `- [ ] T1 [easy] Title` — split so every part's offset is recoverable. */
const CHECKBOX_LINE = /^([ \t]*[-*][ \t]+\[)( |x|X)(\][ \t]+)(.*)$/;
const TODO_ID = /^(T\d+)[:.)]?[ \t]+/i;
const DIFFICULTY_TAG = /^\[(?:easy|hard)\][ \t]+/i;
const H2 = /^##[ \t]+(.*)$/;
const H3 = /^###[ \t]+(.*)$/;
const ANY_HEADING = /^#{1,6}[ \t]+/;
const GUIDE_HEADING = /^##[ \t]+guide\b/i;

/**
 * The model closes every plan with a literal `STOP — review and edit before
 * execution.` line (see `prompts/plan-planning.ts`). That is the model telling
 * itself where to stop, not something the reader needs; the view has an
 * Execute button where the sentence used to be the whole affordance.
 */
const STOP_LINE = /^(?:```[a-z]*\s*)?STOP\b.*$/i;

interface Line {
  start: number;
  end: number;
  text: string;
}

function linesOf(doc: string): Line[] {
  const out: Line[] = [];
  let start = 0;
  while (start <= doc.length) {
    const nl = doc.indexOf('\n', start);
    const end = nl === -1 ? doc.length : nl;
    out.push({ start, end, text: doc.slice(start, end) });
    if (nl === -1) break;
    start = nl + 1;
  }
  return out;
}

/** A range with nothing but whitespace in it contributes no block. */
function pushMarkdown(blocks: PlanBlock[], doc: string, start: number, end: number): void {
  if (end <= start) return;
  if (!doc.slice(start, end).trim()) return;
  blocks.push({ kind: 'markdown', range: { start, end } });
}

function unstructured(doc: string): PlanDocument {
  return {
    structured: false,
    blocks: doc.trim() ? [{ kind: 'markdown', range: { start: 0, end: doc.length } }] : [],
    steps: [],
  };
}

export function parsePlanDocument(doc: string): PlanDocument {
  try {
    if (typeof doc !== 'string' || doc.length === 0) return unstructured('');

    const lines = linesOf(doc);
    const checkboxIdx = lines
      .map((l, i) => (CHECKBOX_LINE.test(l.text) ? i : -1))
      .filter((i) => i !== -1);
    if (checkboxIdx.length === 0) return unstructured(doc);

    const firstBox = checkboxIdx[0];
    const lastBox = checkboxIdx[checkboxIdx.length - 1];

    // The checklist's own heading (`## Todos`) belongs to the step block, not
    // to the prose above it — the step cards ARE the todo list, so a "Todos"
    // heading left floating above them labels nothing. Only a heading within
    // three lines counts, so a distant one stays part of the lead.
    let headStart = lines[firstBox].start;
    for (let i = firstBox - 1; i >= 0 && firstBox - i <= 3; i--) {
      if (ANY_HEADING.test(lines[i].text)) {
        headStart = lines[i].start;
        break;
      }
      if (lines[i].text.trim()) break;
    }

    const steps = buildSteps(lines, checkboxIdx);
    const todosEnd = lines[lastBox].end;

    // The guide is consumed into the steps only when it sits AFTER them; a
    // document that puts it first is not the shape this pairs up, and reading
    // it out of order would be worse than leaving it as prose.
    const guide = findGuideSection(lines, todosEnd);
    if (guide) attachGuides(doc, lines, steps, guide);

    const blocks: PlanBlock[] = [];
    pushMarkdown(blocks, doc, 0, headStart);
    blocks.push({ kind: 'steps', steps });
    // Whatever sat between the checklist and the guide, plus every guide entry
    // that matched no step — kept rather than dropped (contract 1).
    pushMarkdown(blocks, doc, todosEnd, guide ? guide.bodyStart : todosEnd);
    if (guide) for (const r of guide.orphans) pushMarkdown(blocks, doc, r.start, r.end);
    const tailStart = guide ? guide.end : todosEnd;
    pushMarkdown(blocks, doc, tailStart, trailingEnd(lines, tailStart, doc.length));

    return { structured: true, blocks, steps };
  } catch {
    // Never let a malformed plan blank the view.
    return unstructured(typeof doc === 'string' ? doc : '');
  }
}

function buildSteps(lines: Line[], checkboxIdx: number[]): PlanStepBlock[] {
  return checkboxIdx.map((lineIdx, i) => {
    const line = lines[lineIdx];
    const m = CHECKBOX_LINE.exec(line.text)!;
    const [, open, state, close, rest] = m;

    // Strip the id and tag off the FRONT only, tracking how far we moved so
    // `titleRange` still points at the real characters in the file.
    let offset = open.length + state.length + close.length;
    let title = rest;
    const id = TODO_ID.exec(title);
    if (id) {
      offset += id[0].length;
      title = title.slice(id[0].length);
    }
    const tag = DIFFICULTY_TAG.exec(title);
    if (tag) {
      offset += tag[0].length;
      title = title.slice(tag[0].length);
    }

    return {
      ordinal: i + 1,
      title: title.trim(),
      done: state.toLowerCase() === 'x',
      checkboxOffset: line.start,
      titleRange: { start: line.start + offset, end: line.end },
      // The `T<n>` id is re-read off the line in attachGuides rather than
      // stored here: keeping it out of the public shape keeps it out of the UI.
      guide: null,
    };
  });
}

interface GuideSection {
  /** Start of the `## Guide` heading line — everything from here is consumed. */
  bodyStart: number;
  /** End of the section (the next `##`, or EOF). */
  end: number;
  /** Entries that matched no step, kept so their text is never lost. */
  orphans: PlanRange[];
  entries: Array<{ id: number | null; range: PlanRange }>;
}

function findGuideSection(lines: Line[], after: number): GuideSection | null {
  const headingIdx = lines.findIndex((l) => l.start >= after && GUIDE_HEADING.test(l.text));
  if (headingIdx === -1) return null;

  let endIdx = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (H2.test(lines[i].text)) {
      endIdx = i;
      break;
    }
  }

  // Each `###` inside the section is one entry, running to the next `###` or
  // to the section's end.
  const entryStarts: number[] = [];
  for (let i = headingIdx + 1; i < endIdx; i++) {
    if (H3.test(lines[i].text)) entryStarts.push(i);
  }

  const entries: Array<{ id: number | null; range: PlanRange }> = [];
  for (let k = 0; k < entryStarts.length; k++) {
    const i = entryStarts[k];
    const bodyStart = i + 1 < lines.length ? lines[i + 1].start : lines[i].end;
    const stopIdx = k + 1 < entryStarts.length ? entryStarts[k + 1] : endIdx;
    const bodyEnd = stopIdx > 0 ? lines[stopIdx - 1].end : bodyStart;
    const headingText = H3.exec(lines[i].text)![1];
    const idMatch = /\bT(\d+)\b/i.exec(headingText);
    entries.push({
      id: idMatch ? Number(idMatch[1]) : null,
      range: { start: bodyStart, end: Math.max(bodyStart, bodyEnd) },
    });
  }

  // Anything between the `## Guide` heading and its first `###` is preamble.
  const preambleEnd = entryStarts.length > 0 ? lines[entryStarts[0]].start : lines[endIdx - 1].end;
  const orphans: PlanRange[] = [];
  const preambleStart = lines[headingIdx].end;
  if (preambleEnd > preambleStart) orphans.push({ start: preambleStart, end: preambleEnd });

  return {
    bodyStart: lines[headingIdx].start,
    end: endIdx < lines.length ? lines[endIdx].start : lines[lines.length - 1].end,
    orphans,
    entries,
  };
}

/**
 * Pair guide entries to steps: by `T<n>` id first (the ids are what the
 * template writes on both halves), then positionally for whatever is left, so
 * a plan whose guide headings lost their ids still lines up.
 */
function attachGuides(
  doc: string,
  lines: Line[],
  steps: PlanStepBlock[],
  guide: GuideSection,
): void {
  const claimed = new Set<number>();

  steps.forEach((step) => {
    const line = doc.slice(step.checkboxOffset, lineEndOf(lines, step.checkboxOffset));
    const m = CHECKBOX_LINE.exec(line);
    const idMatch = m ? TODO_ID.exec(m[4]) : null;
    if (!idMatch) return;
    const id = Number(idMatch[1].slice(1));
    const at = guide.entries.findIndex((e, i) => e.id === id && !claimed.has(i));
    if (at !== -1) {
      claimed.add(at);
      step.guide = guide.entries[at].range;
    }
  });

  const spare = guide.entries.map((_, i) => i).filter((i) => !claimed.has(i));
  for (const step of steps) {
    if (step.guide) continue;
    const next = spare.shift();
    if (next === undefined) break;
    claimed.add(next);
    step.guide = guide.entries[next].range;
  }

  for (const i of spare) guide.orphans.push(guide.entries[i].range);
}

function lineEndOf(lines: Line[], offset: number): number {
  const line = lines.find((l) => l.start <= offset && offset <= l.end);
  return line ? line.end : offset;
}

/** Trim a trailing `STOP — …` line (and the fence around it) off the tail. */
function trailingEnd(lines: Line[], from: number, docEnd: number): number {
  let end = docEnd;
  for (let i = lines.length - 1; i >= 0 && lines[i].start >= from; i--) {
    const text = lines[i].text.trim();
    if (!text || text === '```') {
      end = lines[i].start;
      continue;
    }
    if (STOP_LINE.test(text)) {
      end = lines[i].start;
      continue;
    }
    break;
  }
  return Math.max(from, end);
}
