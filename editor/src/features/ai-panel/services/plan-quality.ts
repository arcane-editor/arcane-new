/**
 * Does this text actually meet the plan contract `prompts/plan-planning.ts`
 * asks for?
 *
 * Nothing used to ask. `plan-controller.ts` took the model's last assistant
 * message, checked it was non-empty, and wrote it to `.unityide/plans/*.aplan`
 * as the plan. So a turn that produced only a preamble —
 *
 *   "I'm going to build this around the existing SampleScene and
 *    PlayerController.cs so everything stays wired. First, let me study…"
 *
 * — became the plan document, and the user was shown an Execute button for it.
 * `plan-todos.ts` could not catch that: it is deliberately forgiving (a
 * document with no checkbox lines yields `[]`, never an error) because it runs
 * on every execution send and must never block one. That resilience is right
 * there and wrong here. Drafting is the one moment where the document should
 * be held to the template, because it is the moment a human is about to read
 * it and approve it.
 *
 * DEPTH is checked, not just shape. A checklist whose guide entries say "do
 * the movement" passes every structural rule and is still worthless: the
 * executor has to re-derive the design the planning phase existed to settle.
 * So each `### T<n>` entry has to carry both a body of real length AND
 * something concrete — a file, a path, an API member, a backticked identifier.
 *
 * Pure and total, so it can be tested without a model and can never itself
 * break a draft: any input that is not a string is simply "not a plan".
 */

/** Sections the template requires, in the order it lists them. */
const REQUIRED_SECTIONS = ['Goal', 'Context', 'Todos', 'Guide', 'Risks'] as const;

/**
 * Below this it is not a plan, it is a note. Deliberately lower than the
 * prompt's "aim for 5-12": the prompt should ask for the right size, but a
 * hard gate that forces padding on a genuinely small change would trade one
 * kind of bad plan for another. Depth is enforced per entry instead, which is
 * where "detailed" actually lives.
 */
const MIN_TODOS = 3;

/** A guide entry shorter than this cannot be carrying instructions. */
const MIN_GUIDE_CHARS = 100;

const SENTINEL = 'STOP — review and edit before execution.';

const CHECKBOX = /^\s*[-*]\s+\[[ xX]\]\s+(T\d+)\b/gm;
const GUIDE_HEAD = /^###\s+(T\d+)\b/gm;

/**
 * Something the executor can act on without a further decision: a filename, a
 * path, a dotted API member, anything in backticks, or a camel/Pascal-cased
 * identifier.
 *
 * That last alternative is doing most of the work and is deliberately loose.
 * Real Unity instructions are carried by names like `isGrounded`, `stepOffset`
 * and `deltaTime`, and requiring a path or a dot rejected guidance that was
 * perfectly concrete. An internal capital is a good enough signal for "this
 * names a thing in the codebase"; ordinary English prose has none, which is
 * all this needs to separate.
 */
const CONCRETE =
  /`[^`]+`|\b[\w-]+\.(?:cs|unity|prefab|asset|inputactions|mat|shader|json|asmdef)\b|\b[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*\b|\bAssets\/|\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*\b/;

export interface PlanQualityReport {
  ok: boolean;
  /** Human-readable, and sent verbatim to the model on a repair turn. */
  problems: string[];
}

/** Body text of each `### T<n>` entry, keyed by id. */
function guideBodies(doc: string): Map<string, string> {
  const lines = doc.split('\n');
  const out = new Map<string, string>();
  let current: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (current) out.set(current, buf.join('\n').trim());
    buf = [];
  };
  for (const line of lines) {
    const head = line.match(/^###\s+(T\d+)\b/);
    if (head) {
      flush();
      current = head[1];
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      flush();
      current = null;
      continue;
    }
    if (current) buf.push(line);
  }
  flush();
  return out;
}

export function validatePlanDocument(doc: string): PlanQualityReport {
  if (typeof doc !== 'string' || doc.trim().length === 0) {
    return { ok: false, problems: ['The turn produced no plan document at all.'] };
  }

  const text = doc.trim();
  const firstLine = text.split('\n')[0].trim();

  // Checked first and reported alone. When the answer is prose rather than a
  // document, listing five missing headings buries the actual problem — the
  // model did not write a plan — under the symptoms of it.
  if (!/^#\s+\S/.test(firstLine)) {
    return {
      ok: false,
      problems: [
        'The reply does not start with a `# ` title, so it is not a plan document. ' +
          'The whole reply must BE the plan — no preamble, no narration of what you ' +
          'are about to do.',
      ],
    };
  }

  const problems: string[] = [];

  for (const section of REQUIRED_SECTIONS) {
    if (!new RegExp(`^##\\s+${section}\\b`, 'm').test(text)) {
      problems.push(`Missing the \`## ${section}\` section.`);
    }
  }

  const todoIds = [...text.matchAll(CHECKBOX)].map((m) => m[1]);
  if (todoIds.length < MIN_TODOS) {
    problems.push(
      `Only ${todoIds.length} todo${todoIds.length === 1 ? '' : 's'} — a plan needs at ` +
        `least ${MIN_TODOS} \`- [ ] T<n> <title>\` lines under \`## Todos\`. Aim for 5-12.`,
    );
  }

  const duplicates = todoIds.filter((id, i) => todoIds.indexOf(id) !== i);
  if (duplicates.length > 0) {
    problems.push(`Duplicate todo ids: ${[...new Set(duplicates)].join(', ')}. Each must be unique.`);
  }

  const bodies = guideBodies(text);
  const guideIds = [...text.matchAll(GUIDE_HEAD)].map((m) => m[1]);

  for (const id of todoIds) {
    if (!guideIds.includes(id)) {
      problems.push(`Todo ${id} has no matching \`### ${id}\` entry under \`## Guide\`.`);
    }
  }
  for (const id of guideIds) {
    if (!todoIds.includes(id)) {
      problems.push(`\`### ${id}\` under \`## Guide\` has no matching todo in \`## Todos\`.`);
    }
  }

  for (const id of todoIds) {
    const body = bodies.get(id);
    if (body === undefined) continue; // already reported as missing above
    if (body.length < MIN_GUIDE_CHARS) {
      problems.push(
        `\`### ${id}\` is too thin to execute — say which files change, what the ` +
          `change is, and how to verify it.`,
      );
    } else if (!CONCRETE.test(body)) {
      problems.push(
        `\`### ${id}\` names nothing concrete — reference the actual file paths, ` +
          `API members or values the executor should use, not just the intent.`,
      );
    }
  }

  if (!text.includes(SENTINEL)) {
    problems.push(`The document must end with the line: ${SENTINEL}`);
  }

  return { ok: problems.length === 0, problems };
}

/**
 * The repair turn's prompt. One shot, the same shape `grounding-lint.ts` uses
 * for ask mode: state what is wrong, ask for the whole document back. The
 * model cannot write the plan file itself in this phase (plan-planning's
 * toolset is read-only), so the reply IS the document.
 */
export function buildPlanRepairPrompt(problems: string[]): string {
  return (
    `That reply is not a usable plan. Fix these and reply with the COMPLETE plan ` +
    `document and nothing else — no preamble, no explanation of the fixes:\n\n` +
    problems.map((p) => `- ${p}`).join('\n') +
    `\n\nUse the exact structure you were given: \`# title\`, then \`## Goal\`, ` +
    `\`## Context\`, \`## Todos\`, \`## Guide\`, \`## Risks\`, ending with the ` +
    `\`${SENTINEL}\` line.`
  );
}
