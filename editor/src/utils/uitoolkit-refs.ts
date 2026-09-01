// The C#-side half of UI Toolkit verification: what a source file queries, what
// it names at runtime, and whether a queried name is genuinely missing.
//
// **The measurement this module exists to respect.** Across 12,898 real C#
// files, 208 distinct literal names are passed to `Q()`. 187 exist in some
// `.uxml`. The other 21 — `unity-content-container`, `unity-checkmark`,
// `unity-drag-container` and friends — are named inside the constructors of
// Unity's built-in controls, in the engine assembly, and appear in no `.uxml`
// anywhere. So the obvious check ("name not found in UXML -> error") is wrong
// about 10% of the time, on code that is completely fine.
//
// For a feature whose entire pitch is trust, a checker that cries wolf is worse
// than no checker. Hence `resolveQueryName`: a ladder of suppressors where the
// report is the LAST resort, the severity is never `error`, and "I do not know
// yet" is a first-class answer rather than a silent lie.
//
// A leaf module: no imports beyond sibling leaves, so analyzer rules and Bun
// tests both load it.

import { isBuiltinPartName } from './uxml-controls';

// ── Extraction ───────────────────────────────────────────────────────────────

export interface QuerySite {
  /** The element name queried, or null when this call names none. */
  name: string | null;
  /** The class queried, when one was given. */
  className: string | null;
  /** Offsets of the name literal INCLUDING its quotes, for the squiggle. */
  nameStart: number;
  nameEnd: number;
}

/**
 * `.Q<T>(...)` / `.Q(...)` / `.Query<T>(...)`.
 *
 * `[^()"]*` for the argument list rather than `[^)]*` so a `)` inside a string
 * literal cannot end the match early, and a nested call is skipped rather than
 * mis-parsed.
 */
const QUERY_RE = /\.\s*(?:Q|Query)\s*(?:<[^<>()]*>)?\s*\(([^()]*)\)/g;

const STRING_LITERAL_RE = /"((?:[^"\\]|\\.)*)"/;

interface ParsedArg {
  /** Argument label when written `name:` / `className:`, else null. */
  label: string | null;
  /** Literal value when the argument is a plain string literal, else null. */
  literal: string | null;
  /** Offset of the literal's opening quote within the source, when literal. */
  start: number;
  end: number;
}

/** Split an argument list on top-level commas, keeping offsets. */
function splitArgs(argText: string, base: number): ParsedArg[] {
  const out: ParsedArg[] = [];
  let depth = 0;
  let inString = false;
  let segStart = 0;
  for (let i = 0; i < argText.length; i++) {
    const ch = argText[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '<' || ch === '[') depth++;
    else if (ch === '>' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(parseArg(argText.slice(segStart, i), base + segStart));
      segStart = i + 1;
    }
  }
  out.push(parseArg(argText.slice(segStart), base + segStart));
  return out;
}

function parseArg(raw: string, base: number): ParsedArg {
  let text = raw;
  let offset = base;

  const labelMatch = /^(\s*)([A-Za-z_]\w*)\s*:(?!:)/.exec(text);
  let label: string | null = null;
  if (labelMatch) {
    label = labelMatch[2];
    const consumed = labelMatch[0].length;
    text = text.slice(consumed);
    offset += consumed;
  }

  const lit = STRING_LITERAL_RE.exec(text);
  if (!lit) return { label, literal: null, start: -1, end: -1 };
  const start = offset + lit.index;
  return { label, literal: lit[1], start, end: start + lit[0].length };
}

/**
 * Find every `Q()` call site.
 *
 * Matching runs on `code` (the comment/string-blanked view, which preserves
 * every offset) and values are read back out of `text` at the same offsets, so
 * a call inside a comment never counts. Same technique as
 * `unity-analyzers/rules/input-actions.ts`.
 */
export function extractQuerySites(code: string, text: string): QuerySite[] {
  const out: QuerySite[] = [];
  QUERY_RE.lastIndex = 0;
  for (let m = QUERY_RE.exec(code); m !== null; m = QUERY_RE.exec(code)) {
    const argsStart = m.index + m[0].indexOf('(') + 1;
    const args = splitArgs(m[1], argsStart);

    let name: string | null = null;
    let className: string | null = null;
    let nameStart = -1;
    let nameEnd = -1;

    // `Q(name, className)` is positional; `Q(className: "x")` names no element.
    // Getting this wrong reports every class-based query as a missing element.
    let positional = 0;
    for (const arg of args) {
      const slot = arg.label ?? (positional === 0 ? 'name' : positional === 1 ? 'className' : null);
      if (arg.label === null) positional++;
      if (arg.literal === null) continue;
      if (slot === 'name') {
        // Read the real value from the unblanked source.
        name = text.slice(arg.start + 1, arg.end - 1);
        nameStart = arg.start;
        nameEnd = arg.end;
      } else if (slot === 'className') {
        className = text.slice(arg.start + 1, arg.end - 1);
      }
    }

    out.push({ name: name === '' ? null : name, className, nameStart, nameEnd });
  }
  return out;
}

export interface CsUiRefs {
  /** Names this file gives elements at runtime — `el.name = "x"`, `new Button { name = "x" }`. */
  assignedNames: string[];
  /** Classes this file adds, removes, probes or queries behaviourally. */
  referencedClasses: string[];
}

const ASSIGN_NAME_RE = /\.\s*name\s*=\s*"((?:[^"\\]|\\.)*)"/g;
const INIT_NAME_RE = /[{,]\s*name\s*=\s*"((?:[^"\\]|\\.)*)"/g;
const CLASS_CALL_RE =
  /\.\s*(?:AddToClassList|RemoveFromClassList|ToggleInClassList|EnableInClassList|ClassListContains)\s*\(\s*"((?:[^"\\]|\\.)*)"/g;
const CLASS_ARG_RE = /\bclassName\s*:\s*"((?:[^"\\]|\\.)*)"/g;

function collect(re: RegExp, code: string, text: string): string[] {
  const out: string[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(code); m !== null; m = re.exec(code)) {
    // The captured group is blanked; recover the literal from `text` by finding
    // the quotes at the same offsets.
    const openQuote = m.index + m[0].lastIndexOf('"', m[0].length - m[1].length - 1);
    const value = text.slice(openQuote + 1, openQuote + 1 + m[1].length);
    if (value !== '') out.push(value);
  }
  return out;
}

/**
 * Names and classes this file establishes at runtime.
 *
 * These are SUPPRESSORS, not findings: an element named from C# legitimately
 * appears in no UXML. 1,126 such assignments across 466 distinct names in the
 * measured corpus.
 */
export function extractCsUiRefs(code: string, text: string): CsUiRefs {
  const assigned = [
    ...collect(ASSIGN_NAME_RE, code, text),
    ...collect(INIT_NAME_RE, code, text),
  ];
  const classes = [
    ...collect(CLASS_CALL_RE, code, text),
    ...collect(CLASS_ARG_RE, code, text),
  ];
  return {
    assignedNames: [...new Set(assigned)],
    referencedClasses: [...new Set(classes)],
  };
}

// ── Did-you-mean ─────────────────────────────────────────────────────────────

/** Levenshtein with an early bail once `limit` is exceeded. */
function distance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      row.push(v);
      if (v < best) best = v;
    }
    if (best > limit) return limit + 1;
    prev = row;
  }
  return prev[b.length];
}

/**
 * The closest candidate to `value`, or null when nothing is close enough.
 *
 * The bound scales with length rather than being a flat 2: `play-btn` ->
 * `play-button` is distance 3, and that is the canonical case this check exists
 * to catch. A case-only difference wins outright — it is almost always the
 * actual mistake.
 */
export function nearestName(candidates: readonly string[], value: string): string | null {
  if (candidates.length === 0 || value === '') return null;

  const lower = value.toLowerCase();
  for (const c of candidates) {
    if (c !== value && c.toLowerCase() === lower) return c;
  }

  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    if (c === value) continue;
    const limit = Math.max(2, Math.floor(Math.max(c.length, value.length) / 3));
    const d = distance(value, c, limit);
    if (d <= limit && d < bestDistance) {
      bestDistance = d;
      best = c;
    }
  }
  return best;
}

// ── The ladder ───────────────────────────────────────────────────────────────

export type QueryVerdictKind =
  | 'resolved-associated'
  | 'resolved-project'
  | 'builtin-part'
  | 'assigned-in-code'
  | 'unresolved'
  /** Not enough loaded to answer. Report nothing; this is not a pass or a fail. */
  | 'insufficient-data';

export interface QueryVerdict {
  kind: QueryVerdictKind;
  /** Which suppressor fired, for the rail's trace and for tests. */
  rung: 1 | 2 | 3 | 4 | null;
  /** The associated document, when one was resolvable — used to word the message. */
  associatedPath: string | null;
  /** Set only for `unresolved`, and only when a near match exists. */
  suggestion: string | null;
}

export interface LadderContext {
  /** The UXML this script is wired to, when resolvable. Often null, by design. */
  associatedPath: string | null;
  /** Names declared by that document. Null when the association is unknown. */
  associatedNames: Set<string> | null;
  /** Names declared by ANY `.uxml` in the project. */
  projectNames: Set<string>;
  /** Names assigned from C# project-wide. **Null until the walk completes.** */
  csAssignedNames: Set<string> | null;
  /** Candidate pool for did-you-mean. */
  allNames: readonly string[];
}

/**
 * Decide whether a queried element name is genuinely missing.
 *
 * Every rung is a reason to STAY QUIET. Only a name that clears all four is
 * reported, and even then as a warning — this is a heuristic over data the
 * compiler cannot see, and a false error costs more than a missed warning.
 */
export function resolveQueryName(name: string, ctx: LadderContext): QueryVerdict {
  const base = { associatedPath: ctx.associatedPath, suggestion: null } as const;

  if (name === '') return { kind: 'insufficient-data', rung: null, ...base };

  // A project with no `.uxml` does not use UI Toolkit. Every verdict below would
  // be a guess, so refuse to have an opinion — the same discipline as
  // `input-actions.ts`, which returns nothing when it has no snapshot.
  if (ctx.projectNames.size === 0) {
    return { kind: 'insufficient-data', rung: null, ...base };
  }

  // Rung 1 — the document this script is actually wired to declares it.
  if (ctx.associatedNames && ctx.associatedNames.has(name)) {
    return { kind: 'resolved-associated', rung: 1, ...base };
  }

  // Rung 2 — some document declares it. Weaker, and deliberately still a pass:
  // a wrong association must never turn a project-wide hit into a report.
  if (ctx.projectNames.has(name)) {
    return { kind: 'resolved-project', rung: 2, ...base };
  }

  // Rung 3 — a part a built-in control names in its own constructor. All 21
  // unmatched names in the measured corpus were of this kind.
  if (isBuiltinPartName(name)) {
    return { kind: 'builtin-part', rung: 3, ...base };
  }

  // Rung 4 is a SUPPRESSOR, so an unfinished walk means "not yet", never
  // "missing". Reporting here would mean reporting names we have not finished
  // checking — precisely the false positive the ladder exists to prevent.
  if (ctx.csAssignedNames === null) {
    return { kind: 'insufficient-data', rung: null, ...base };
  }
  if (ctx.csAssignedNames.has(name)) {
    return { kind: 'assigned-in-code', rung: 4, ...base };
  }

  return {
    kind: 'unresolved',
    rung: null,
    associatedPath: ctx.associatedPath,
    suggestion: nearestName(ctx.allNames, name),
  };
}
