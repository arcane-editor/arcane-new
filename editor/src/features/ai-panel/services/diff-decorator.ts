/**
 * Diff decorator (P5.1) — attaches structured file diffs to write/edit tool
 * results on the UNITYIDE path.
 *
 * Design deviation from the original P5.1 plan (deliberate — see the brief):
 * `vendor/tools/edit.ts` / `write.ts` are NOT touched. They already embed a
 * human-readable diff in their TEXT result (for the model to read), but never
 * populate `AgentToolResult.diffs` — the field `DiffBlock` renders from (see
 * `vendor/types.ts`'s comment: "UnityIDE tools leave this undefined; only the
 * Claude ACP path sets it"). This decorator closes that gap the same way
 * every other cross-cutting UnityIDE-tool behavior is added (analyzer-gate.ts,
 * compile-gate.ts, checkpoint-gate.ts): wrap, don't touch the vendor tool.
 *
 * Mechanism: read the target file BEFORE delegating (missing → '', so a
 * `write` that creates a new file gets `oldText: ''`), delegate
 * unconditionally, then read it again AFTER. If the two reads differ, attach
 * `diffs: [{ path, oldText, newText }]` to a SHALLOW COPY of the inner result
 * (never mutate the object the wrapped tool returned — other decorators in
 * the same chain, or the caller, may still hold a reference to it). If the
 * reads are identical, no `diffs` field is attached — this single check
 * covers BOTH "the inner call legitimately made no change" (e.g. a write with
 * content identical to what was already on disk) AND "the inner call failed"
 * (every failure branch in `write.ts` / `edit.ts` returns before calling its
 * write operation, so the post-read is byte-identical to the pre-read — there
 * is no separate "did it succeed" signal to check).
 *
 * Wiring (agent-service.ts's `createToolsForPromptMode`): this decorator sits
 * OUTSIDE the cs-gates (`wrapCs`) and the checkpoint snapshot, but INSIDE the
 * repeat-call guard — the final composition is `guard(diffs(gates(checkpoint(tool))))`.
 * This is NOT a stylistic choice — diffs MUST stay outside the gates, or a
 * gate hit silently drops them. `analyzer-gate.ts` (and the other cs-gates)
 * rebuild their result as `{ content: [...res.content, note] }` on a hit,
 * WITHOUT spreading `res` first — so any field a wrapper already attached to
 * `res` before reaching the gate (like this decorator's `diffs`) is dropped
 * the moment a gate is the outermost layer around it. Putting
 * `withResultDiffs` outside every gate means it's always the LAST thing to
 * touch the result on the way out, so `diffs` reaches `ToolCallBlock` no
 * matter which gates fired. See `diff-decorator.test.ts`'s "composition
 * order" tests, which pin this down in both directions (diffs outside a gate
 * that rebuilds-without-spreading survive; diffs inside one don't).
 * Inside the guard so a suppressed repeat call never triggers a redundant
 * pair of diff reads. `allowedRoot` must match the wrapped tool's own sandbox
 * for the same reason `checkpoint-gate.ts` requires it: an out-of-root path
 * is rejected internally by the tool itself, and reading around that here
 * would produce a phantom diff for a write that never happened.
 */

import { invoke } from '@tauri-apps/api/core';
import type { AgentTool } from './vendor/types';
import { resolveWithinRoot, PathOutsideRootError, type AllowedRoots } from './vendor/tools/path-utils';

export interface DiffDecoratorDeps {
  /** Reads the file's current content; resolves `null` if it doesn't exist (or is unreadable). */
  readFile: (absPath: string) => Promise<string | null>;
}

export interface DiffDecoratorOptions {
  /**
   * The same Assets/ sandbox root the wrapped write/edit tool was created
   * with (null = no sandbox). Must match, or this decorator reads around
   * paths the inner tool will refuse to write.
   */
  allowedRoot?: AllowedRoots;
  deps?: DiffDecoratorDeps;
}

async function defaultReadFile(absPath: string): Promise<string | null> {
  return invoke<string>('read_file', { path: absPath }).catch(() => null);
}

const DEFAULT_DEPS: DiffDecoratorDeps = { readFile: defaultReadFile };

/** Wrap a write/edit-shaped tool so its result carries `diffs` for `DiffBlock`. */
export function withResultDiffs(
  tool: AgentTool,
  cwd: string,
  options: DiffDecoratorOptions = {},
): AgentTool {
  const deps = options.deps ?? DEFAULT_DEPS;
  const allowedRoot = options.allowedRoot ?? null;

  return {
    ...tool,
    async execute(id, params, signal, onUpdate) {
      const p = (params as { path?: string }).path;
      let absPath: string | null = null;
      if (p) {
        try {
          absPath = resolveWithinRoot(p, cwd, allowedRoot);
        } catch (err) {
          if (!(err instanceof PathOutsideRootError)) throw err;
          // Out-of-root: the inner tool will reject this write itself — don't
          // read around it (nothing was, or will be, written).
          absPath = null;
        }
      }

      const before = absPath ? await deps.readFile(absPath) : null;

      const result = await tool.execute(id, params, signal, onUpdate);

      if (!absPath) return result;

      const after = await deps.readFile(absPath);
      if (after === null) return result; // unreadable/missing post-call — nothing to show

      const oldText = before ?? '';
      if (after === oldText) return result; // identical content, or the inner call never wrote

      return { ...result, diffs: [{ path: absPath, oldText, newText: after }] };
    },
  };
}
