/**
 * Repeat-call guard (P3.2) — the tool-call-level sibling of the turn
 * governor: instead of bounding the whole loop, this decorator suppresses a
 * single wasted round-trip whenever the model calls the SAME tool with the
 * EXACT same arguments it already used this send. A repeat can't produce a
 * new result, so re-executing it just burns a turn a weak model could spend
 * trying something else — the synthetic result below nudges it to.
 *
 * Exemption: a `read` of a path is allowed to repeat once more if that path
 * was WRITTEN (via `write`/`edit`) since the previous identical read — a
 * post-write re-read is a legitimate way to confirm the change landed, not a
 * wasted repeat.
 *
 * Second exemption, same principle: `unity_ui_layout` may repeat once after a
 * successful `unity_ui_write`. Design mode's whole loop is *write → render →
 * read the real boxes → fix → render again*, and the second render is by
 * definition the same call with the same arguments — the document did not
 * change name, its content did. Without this, the design prompt's own step 5
 * ("fix what it reports, then render again") was answered with "Try different
 * arguments, a different tool, **or finish**", which is the guard telling the
 * model to stop iterating on a screen it had just been told was broken. This
 * one cannot key on the path the way the read exemption does: a `.uss` write
 * changes the layout of a `.uxml` with a different path entirely.
 *
 * This decorator wraps EVERY tool (see `agent-service.ts`'s
 * `createToolsForPromptMode` / `run-task.ts`'s `buildTools`), so it can
 * observe write/edit calls directly and mark their path as "written since"
 * in the same shared per-send registry the read side consults — no
 * cross-tool coupling needed beyond that shared state.
 *
 * Per-send state (call counts, the "written since" set) is module-level,
 * reset via `resetRepeatCallGuard()` — the same reset-per-send pattern
 * `resetCompileGate()` / `resetTurnGovernor()` use, since each tool gets its
 * own `withRepeatCallGuard(tool)` wrapper instance (rebuilt every send by
 * `createToolsForPromptMode`) but they all need to share ONE registry for
 * the write→read exemption to work across different tool instances.
 *
 * Suppressions are counted into `turn-telemetry.ts`'s `loopGuardHits`
 * (client-side telemetry only; a server column is P4).
 */

import type { AgentTool, AgentToolResult } from './vendor/types';
import { recordLoopGuardHit } from './turn-telemetry';
import { isRejectedWrite } from './write-approval-gate';
import { resolveToCwd } from './vendor/tools/path-utils';

/**
 * Deterministic JSON serialization — sorts object keys recursively so two
 * calls with the same arguments in a different key order still produce the
 * same string (tool-call args come from parsed JSON, so key order isn't
 * meaningful).
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** Per-send call count, keyed by `toolName::stableStringify(args)`. */
const callCounts = new Map<string, number>();

/** Per-send set of paths written (via write/edit) since their last identical read — the read-exemption registry. */
const writtenSincePaths = new Set<string>();

/**
 * True when a `unity_ui_write` has landed since the last `unity_ui_layout` —
 * the render-exemption flag. Not a path set: the write and the render name
 * different files whenever a stylesheet is what changed.
 */
let uiWrittenSinceLayout = false;

/** The write whose result arms the render exemption, and the tool the exemption is for. */
const UI_WRITE_TOOL = 'unity_ui_write';
const UI_LAYOUT_TOOL = 'unity_ui_layout';

/**
 * `unity_ui_write` announces its own successes as `Wrote <path> (guid …)` and
 * every refusal as `Not writing <path>: …`. The shared `isSuccessfulWrite`
 * tests for the vendor tools' `Successfully wrote …` and is therefore false for
 * all of them — the same trap `layout-gate.ts` documents at length.
 */
function uiWriteLanded(result: AgentToolResult): boolean {
  const text = result.content.find((c) => c.type === 'text')?.text ?? '';
  return /^Wrote\b/.test(text);
}

/** Reset all per-send guard state. Call once per user send (mirrors `resetCompileGate`/`resetTurnGovernor`). */
export function resetRepeatCallGuard(): void {
  callCounts.clear();
  writtenSincePaths.clear();
  uiWrittenSinceLayout = false;
}

/** Argument keys whose string values name a filesystem location. */
const PATH_KEYS = new Set(['path', 'cwd']);

/**
 * Resolve path-valued arguments to their absolute form before they are used as
 * a repeat-call key.
 *
 * The guard keyed on the RAW argument text, so `./Foo.cs` and `Foo.cs` and
 * `Assets/../Assets/Foo.cs` were three different calls — the model could loop
 * on the same file forever just by varying the spelling. The same mismatch also
 * broke the post-write read exemption, which is keyed on the path: a write to
 * `./Foo.cs` never armed the re-read of `Foo.cs`.
 *
 * `cwd` is threaded from the workspace so a relative and an absolute spelling of
 * the same file collapse, not just two relative ones.
 */
function normalizeArgPaths(params: unknown, cwd: string): unknown {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return params;
  const obj = params as Record<string, unknown>;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (PATH_KEYS.has(k) && typeof v === 'string' && v) {
      const resolved = resolveToCwd(v, cwd);
      out[k] = resolved;
      if (resolved !== v) changed = true;
    } else {
      out[k] = v;
    }
  }
  return changed ? out : params;
}

function pathOf(params: unknown): string | undefined {
  const p = (params as { path?: unknown } | null)?.path;
  return typeof p === 'string' ? p : undefined;
}

function synthesizeRepeatResult(toolName: string): AgentToolResult {
  return {
    content: [
      {
        type: 'text',
        text:
          `You already called ${toolName} with identical arguments this task; the result would be identical. ` +
          `Try different arguments, a different tool, or finish.`,
      },
    ],
  };
}

/**
 * Wrap a single tool with the repeat-call guard. Applied to EVERY tool, as
 * the OUTERMOST wrapper — outside the analyzer/lsp/compile gates and the
 * checkpoint snapshot — so a suppressed call never reaches them (no phantom
 * snapshots, no gate feedback for a call that never ran).
 */
export function withRepeatCallGuard(tool: AgentTool, cwd: string): AgentTool {
  return {
    ...tool,
    async execute(id, params, signal, onUpdate) {
      // Key on NORMALIZED paths: the raw text let the same file loop forever
      // under different spellings. The inner tool still receives `params`
      // untouched — it does its own resolution and sandboxing.
      const normalized = normalizeArgPaths(params, cwd);
      const key = `${tool.name}::${stableStringify(normalized)}`;
      const path = pathOf(normalized);
      const seenCount = callCounts.get(key) ?? 0;

      if (seenCount > 0) {
        const reReadExempt =
          tool.name === 'read' && path !== undefined && writtenSincePaths.has(path);
        const reRenderExempt = tool.name === UI_LAYOUT_TOOL && uiWrittenSinceLayout;
        if (reReadExempt || reRenderExempt) {
          // Consume the exemption: a THIRD identical call without another
          // intervening write is a genuine repeat again.
          if (reReadExempt) writtenSincePaths.delete(path!);
          if (reRenderExempt) uiWrittenSinceLayout = false;
        } else {
          recordLoopGuardHit();
          return synthesizeRepeatResult(tool.name);
        }
      }

      callCounts.set(key, seenCount + 1);
      const result = await tool.execute(id, params, signal, onUpdate);

      if (tool.name === UI_LAYOUT_TOOL) {
        // Whatever the outcome, the render just happened: the next repeat needs
        // a fresh write to earn its exemption.
        uiWrittenSinceLayout = false;
      } else if (tool.name === UI_WRITE_TOOL) {
        // Only a write that actually landed. A validation refusal changed
        // nothing, so re-rendering would produce the identical result the guard
        // exists to suppress.
        if (uiWriteLanded(result)) uiWrittenSinceLayout = true;
      }

      if (tool.name === 'write' || tool.name === 'edit') {
        if (isRejectedWrite(result)) {
          // Nothing touched disk. The rejection text tells the model to ask
          // before retrying — when the user then SAYS YES, the byte-identical
          // re-issue must execute, not get answered with a synthetic "the
          // result would be identical". Un-count it (and never arm the
          // post-write read exemption for a write that didn't land).
          callCounts.set(key, seenCount);
        } else if (path !== undefined) {
          writtenSincePaths.add(path);
        }
      }

      return result;
    },
  };
}
