// Console-repair prompt assembly (Task 13, B5).
//
// Two prompts share one region reader:
//
//  1. `buildFixPrompt` — the one-click "Fix this console error" flow
//     (`fix-console-error.ts`). Extracted here VERBATIM: the strings it emits
//     are byte-identical to what that file shipped before this module existed
//     (pinned by `fix-console-error.test.ts`), so the refactor changes nothing
//     the model reads.
//  2. `buildConsoleRepairPrompt` — the post-turn console check's ONE bounded
//     repair pass. Same `<region>` blocks, different framing.
//
// PURE and Bun-safe (Global Constraint 4): no store imports, no Tauri. The
// file read is injected, exactly like `verified-pass.ts`'s `VerifiedPassDeps`
// — `fix-console-error.ts` and `agent-service.ts` pass the real Tauri reader.

import { parseStackTrace, type StackFrame, type UnityLogType } from '../../../../types/unity';

/** Lines of context on EACH side of a stack frame's line. */
export const CONTEXT_LINES = 12;

/** In-`Assets/` frames the one-click fix prompt embeds. Unchanged from the original. */
export const FIX_PROMPT_MAX_FRAMES = 4;

/** In-`Assets/` frames each console-check problem embeds. */
export const REPAIR_MAX_FRAMES = 2;

export interface RegionDeps {
  /** Read a file's full text by absolute path. Rejecting is fine — the region is dropped. */
  readFile: (absPath: string) => Promise<string>;
  /** Workspace root, used to absolutize a project-relative frame path. */
  workspacePath: string | null;
}

/** A stack frame inside the project's own `Assets/` tree — the only kind worth repairing. */
export function isProjectFrame(frame: { filePath: string }): boolean {
  return /Assets\//.test(frame.filePath);
}

/** The entry shape both prompts need — structurally satisfied by `UnityLogEntry`. */
export interface ConsoleErrorLike {
  logType: UnityLogType;
  message: string;
  stackTrace?: string;
  parsedFrames?: StackFrame[];
}

/** In-`Assets/` frames of an entry, already-parsed ones preferred, capped at `max`. */
export function projectFramesOf(entry: ConsoleErrorLike, max: number): StackFrame[] {
  const frames = entry.parsedFrames ?? parseStackTrace(entry.stackTrace ?? '');
  return frames.filter(isProjectFrame).slice(0, max);
}

function absolutize(filePath: string, workspacePath: string | null): string {
  if (filePath.startsWith('/') || /^[A-Za-z]:/.test(filePath)) return filePath;
  if (!workspacePath) return filePath;
  return (workspacePath.endsWith('/') ? workspacePath : workspacePath + '/') + filePath;
}

/** One `<region>` block around a frame's line, or `null` when the file can't be read. */
async function readRegion(frame: StackFrame, deps: RegionDeps): Promise<string | null> {
  try {
    const content = await deps.readFile(absolutize(frame.filePath, deps.workspacePath));
    const lines = content.split('\n');
    const ln = frame.lineNumber;
    const start = Math.max(0, ln - 1 - CONTEXT_LINES);
    const end = Math.min(lines.length, ln + CONTEXT_LINES);
    const snippet = lines
      .slice(start, end)
      .map((l, i) => `${start + i + 1}: ${l}`)
      .join('\n');
    return `<region path="${frame.filePath}" line="${ln}">\n${snippet}\n</region>`;
  } catch {
    return null;
  }
}

/**
 * `<region>` blocks for a set of frames, unreadable ones dropped and duplicate
 * `path:line` pairs collapsed (two problems in the same method otherwise embed
 * the same twenty-five lines twice).
 */
export async function buildRegions(frames: StackFrame[], deps: RegionDeps): Promise<string[]> {
  const seen = new Set<string>();
  const unique: StackFrame[] = [];
  for (const f of frames) {
    const key = `${f.filePath}:${f.lineNumber}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(f);
  }
  const regions = await Promise.all(unique.map((f) => readRegion(f, deps)));
  return regions.filter((r): r is string => r !== null);
}

/**
 * The one-click "Fix this console error" prompt. Byte-identical to what
 * `fix-console-error.ts` produced before this extraction.
 */
export async function buildFixPrompt(entry: ConsoleErrorLike, deps: RegionDeps): Promise<string> {
  const projectFrames = projectFramesOf(entry, FIX_PROMPT_MAX_FRAMES);
  const regions = await buildRegions(projectFrames, deps);

  return [
    `Fix this Unity console ${entry.logType.toLowerCase()}. First state the ROOT CAUSE in 2-3 sentences, then apply the fix.`,
    ``,
    `Error: ${entry.message}`,
    entry.stackTrace ? `\nStack trace:\n${entry.stackTrace}` : '',
    regions.length
      ? `\nRelevant code:\n${regions.join('\n\n')}`
      : `\n(No in-project stack frames resolved — infer from the message.)`,
    `\nGuidance: if this is a NullReferenceException on a serialized field, check whether the field is simply unassigned on the object in the scene (use get_scene_hierarchy / get_game_object) BEFORE adding a null-check — that is usually the real fix. If it's a typo'd Unity message (e.g. "update" vs "Update"), fix the casing. After editing, the Unity analyzer gate will flag any remaining issues.`,
  ].join('\n');
}

// ---- The console check's repair prompt ----

/** The marker every console-check repair prompt opens with (also a compaction sentinel). */
export const CONSOLE_CHECK_MARKER = '[Console check]';

export interface RepairPromptProblem {
  logType: UnityLogType;
  firstLine: string;
  /** `file:line` of the first in-`Assets/` frame, or `null` when nothing in the project appears. */
  location: string | null;
  count: number;
  /** True when no frame points inside `Assets/` — listed for context, never repaired. */
  external: boolean;
}

export interface RepairPromptCompileError {
  file: string;
  line: number;
  message: string;
}

export interface RepairPromptTestFailure {
  fullName: string;
  message: string;
}

export interface RepairPromptInput {
  console: RepairPromptProblem[];
  compile: RepairPromptCompileError[];
  tests: RepairPromptTestFailure[];
  /** `<region>` blocks built from the console problems' in-`Assets/` frames. */
  regions: string[];
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function describeProblem(p: RepairPromptProblem): string {
  const times = p.count > 1 ? ` ×${p.count}` : '';
  const where = p.location
    ? ` (${p.location})`
    : ' (no in-project stack frame — this came from a package or the engine; do not change it)';
  return `- [${p.logType}] ${p.firstLine}${where}${times}`;
}

/**
 * The repair pass's user message. Starts with `[Console check]` so
 * `vendor/compaction.ts` never elides it, and so the model can tell this apart
 * from the user's own words.
 */
export function buildConsoleRepairPrompt(input: RepairPromptInput): string {
  const sections: string[] = [
    `${CONSOLE_CHECK_MARKER} Your last turn left problems behind that were not there when it started. Fix the causes.`,
  ];

  if (input.console.length > 0) {
    sections.push(
      `New console errors (${input.console.length}):\n${input.console.map(describeProblem).join('\n')}`,
    );
  }
  if (input.compile.length > 0) {
    sections.push(
      `Compiler errors (${input.compile.length}):\n` +
        input.compile.map((e) => `- ${e.file}:${e.line}: ${e.message}`).join('\n'),
    );
  }
  if (input.tests.length > 0) {
    sections.push(
      `Failed tests (${input.tests.length}):\n` +
        input.tests.map((t) => `- ${t.fullName}\n  ${t.message}`).join('\n'),
    );
  }
  if (input.regions.length > 0) {
    sections.push(`Relevant code:\n${input.regions.join('\n\n')}`);
  }

  const instructions = [
    'Fix the root causes above, not the symptoms.',
  ];
  if (input.console.some((p) => p.external)) {
    instructions.push(
      `${plural(input.console.filter((p) => p.external).length, 'entry')} above came from a package or the engine — leave those alone unless this project's code is what triggers them.`,
    );
  }
  if (input.tests.length > 0) {
    instructions.push('Re-run the failed tests with `unity_run_tests` once you have changed the code.');
  }
  instructions.push(
    'Do not claim any of this is fixed without evidence: a clean compile, a passing test run, or a console read that no longer shows it.',
  );
  sections.push(instructions.join(' '));

  return sections.join('\n\n');
}
