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
 * wasted repeat. This decorator wraps EVERY tool (see `agent-service.ts`'s
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

/** Reset all per-send guard state. Call once per user send (mirrors `resetCompileGate`/`resetTurnGovernor`). */
export function resetRepeatCallGuard(): void {
  callCounts.clear();
  writtenSincePaths.clear();
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
export function withRepeatCallGuard(tool: AgentTool): AgentTool {
  return {
    ...tool,
    async execute(id, params, signal, onUpdate) {
      const key = `${tool.name}::${stableStringify(params)}`;
      const path = pathOf(params);
      const seenCount = callCounts.get(key) ?? 0;

      if (seenCount > 0) {
        const exempt = tool.name === 'read' && path !== undefined && writtenSincePaths.has(path);
        if (exempt) {
          // Consume the exemption: a THIRD identical read without another
          // intervening write is a genuine repeat again.
          writtenSincePaths.delete(path!);
        } else {
          recordLoopGuardHit();
          return synthesizeRepeatResult(tool.name);
        }
      }

      callCounts.set(key, seenCount + 1);
      const result = await tool.execute(id, params, signal, onUpdate);

      if ((tool.name === 'write' || tool.name === 'edit') && path !== undefined) {
        writtenSincePaths.add(path);
      }

      return result;
    },
  };
}
