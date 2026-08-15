// Compile-gate — the engine-grounded sibling of the analyzer-gate. After the
// agent writes/edits a .cs file in a Unity project WITH a live bridge, we ask
// Unity to recompile and feed the REAL compiler errors back into the tool
// result, so the model self-corrects on its next turn (the loop naturally
// re-iterates until the file compiles). Pure decorator over the generic
// write/edit tools — no vendor-loop changes, exactly like the analyzer-gate.
//
// Honesty rule (agent-reliability fix): every degraded path SAYS SO in the
// tool result. The old behavior returned the inner result unchanged when the
// bridge was missing or the wait gave up — the model read that as "write
// succeeded, nothing else to do" and ended its turn, which is exactly the
// "agent stops the moment Unity starts compiling" bug. The analyzer-gate
// (wrapped underneath) still provides the static safety net; this gate now
// *labels* the gap instead of hiding it.
//
// Cost guard: a per-file attempt counter caps repair iterations so an
// un-fixable error (e.g. a missing package, not a code bug) can't loop forever.
//
// P5.3 finding: this gate wraps OUTSIDE `write-approval-gate.ts` and, before
// the `isRejectedWrite` check below, unconditionally triggered a REAL Unity
// recompile for any `.cs` path regardless of whether the write actually
// happened. The early-outs (rejected OR unsuccessful write) make both inert
// here — a failed write must not burn a `MAX_ATTEMPTS` slot or a real engine
// round-trip (see `write-approval-gate.ts`'s header for the investigation).
//
// DI seams (Bun-testability): `HintLookup` (as before, wired by the barrel)
// plus `CompileGateDeps` for the store/bridge-backed pieces — the defaults
// reach the real implementations via DYNAMIC imports so this module never
// statically pulls the unity-bridge barrel (react components) or the unity
// store chain into a Bun test. Mirrors `lsp-gate.ts`'s `defaultFetchDiagnostics`.

import type { AgentTool, AgentToolResult } from '../vendor/types';
import { resolveToCwd } from '../vendor/tools/path-utils';
import type { CompileWaitOutcome } from '../../../unity-bridge';
import type { CompilerMessage } from '../../../../types/unity';
import { buildCompileHints, type HintLookup } from './compile-hints';
import { isRejectedWrite } from '../write-approval-gate';

const MAX_ATTEMPTS = 4;
/** Hint lookups are best-effort garnish — never let them stall the loop. */
const DEFAULT_HINTS_BUDGET_MS = 8_000;

/** error-producing compile attempts per absolute .cs path, for the iteration cap. */
const compileAttempts = new Map<string, number>();
/** One bridge-disconnected notification per user send, not one per write. */
let warnedBridgeThisSend = false;

/** Reset the per-send state (attempt counters, warning dedup). Call at the start of each user send. */
export function resetCompileGate(): void {
  compileAttempts.clear();
  warnedBridgeThisSend = false;
}

/** Store/bridge-backed dependencies, injectable for tests. */
export interface CompileGateDeps {
  recompile: (opts: { signal?: AbortSignal }) => Promise<CompileWaitOutcome>;
  connected: () => boolean | Promise<boolean>;
  /** Surface "the agent can't verify compiles" to the user (notifications panel). */
  warnBridgeDisconnected: () => void;
}

const defaultDeps: CompileGateDeps = {
  recompile: async (opts) => (await import('../../../unity-bridge')).triggerRecompileAndWait(opts),
  connected: async () => (await import('./shared')).bridgeConnected(),
  warnBridgeDisconnected: () => {
    void import('../../../../stores/notifications')
      .then(({ useNotificationsStore }) => {
        useNotificationsStore.getState().addNotification({
          type: 'warning',
          message:
            'Unity bridge is not connected — the agent cannot verify compiles. ' +
            'Unity will only pick up changes when its window gains focus.',
        });
      })
      .catch(() => {
        /* notifications are best-effort */
      });
  },
};

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+/g, '/');
}

/** Resolve a Unity CompilerMessage.file (project-relative or absolute) → abs path. */
function toAbsPath(file: string, cwd: string): string {
  const norm = normalize(file);
  if (norm.startsWith('/') || /^[A-Za-z]:/.test(norm)) return norm;
  const base = cwd.endsWith('/') ? cwd : cwd + '/';
  return normalize(base + norm.replace(/^\.?\//, ''));
}

function sameFile(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function formatError(m: CompilerMessage): string {
  return `  • line ${m.line}: ${m.message}`;
}

function appendNote(res: AgentToolResult, text: string): AgentToolResult {
  return { ...res, content: [...res.content, { type: 'text', text }] };
}

/**
 * Same textual success convention `lsp-gate.ts` keys on: the vendor
 * write/edit tools never throw — the leading "Successfully wrote/edited" is
 * the only marker that the file on disk actually changed.
 */
function isSuccessfulWrite(res: AgentToolResult): boolean {
  const text = res.content.find((c): c is { type: 'text'; text: string } => c.type === 'text')?.text ?? '';
  return /^Successfully (wrote|edited)\b/.test(text);
}

/** Race a promise against a timeout, resolving `fallback` on expiry. Timer always cleared. */
function raceWithFallback<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

export function withUnityCompileGate(
  tool: AgentTool,
  cwd: string,
  client: HintLookup,
  deps: CompileGateDeps = defaultDeps,
  opts: { hintsBudgetMs?: number } = {},
): AgentTool {
  const hintsBudgetMs = opts.hintsBudgetMs ?? DEFAULT_HINTS_BUDGET_MS;
  return {
    ...tool,
    async execute(id, params, signal, onUpdate) {
      const res = await tool.execute(id, params, signal, onUpdate);
      if (isRejectedWrite(res)) return res;
      const p = (params as { path?: string }).path;
      if (!p || !p.toLowerCase().endsWith('.cs')) return res;
      if (!isSuccessfulWrite(res)) return res;

      // No live engine → the analyzer-gate's static findings are the only net.
      // Say so instead of implying the compile was verified.
      if (!(await deps.connected())) {
        if (!warnedBridgeThisSend) {
          warnedBridgeThisSend = true;
          deps.warnBridgeDisconnected();
        }
        return appendNote(
          res,
          `\n\n[Unity compile] Unity bridge not connected — compile status unknown; ` +
            `Unity will pick up this change when it next gains focus.`,
        );
      }

      const absWritten = resolveToCwd(p, cwd);

      const outcome = await deps.recompile({ signal });

      if (outcome.status === 'no-compile') {
        return appendNote(res, `\n\n[Unity compile] Assets refreshed — no recompile was needed.`);
      }
      if (outcome.status === 'unknown') {
        if (outcome.reason === 'aborted') return res;
        const why =
          outcome.reason === 'bridge-lost'
            ? 'Unity bridge was lost mid-compile'
            : "timed out waiting for Unity's report";
        return appendNote(
          res,
          `\n\n[Unity compile] Compile status unknown (${why}) — verify before finishing.`,
        );
      }

      const report = outcome.report;
      const errors = (report.messages ?? []).filter((m) => m.type === 'Error');
      if (errors.length === 0) {
        compileAttempts.delete(absWritten);
        return appendNote(res, `\n\n[Unity compile] Clean — no compiler errors.`);
      }

      // Partition: errors in the file we just wrote vs. elsewhere in the project.
      const here = errors.filter((m) => sameFile(toAbsPath(m.file, cwd), absWritten));
      const shown = here.length ? here : errors;
      const elsewhere = errors.length - here.length;

      const attempts = (compileAttempts.get(absWritten) ?? 0) + 1;
      compileAttempts.set(absWritten, attempts);

      if (attempts > MAX_ATTEMPTS) {
        return appendNote(
          res,
          `\n\n[Unity compile] Still ${errors.length} compiler error(s) after ${MAX_ATTEMPTS} attempts — ` +
            `stop auto-fixing and surface these to the user:\n${shown.map(formatError).join('\n')}`,
        );
      }

      let text =
        `\n\n[Unity compile] ${errors.length} compiler error(s) after writing ${p} — fix before finishing:\n` +
        shown.map(formatError).join('\n');
      if (here.length && elsewhere > 0) {
        text += `\n(+${elsewhere} more compiler error(s) elsewhere in the project)`;
      }
      text += await raceWithFallback(buildCompileHints(shown, client), hintsBudgetMs, '');
      text += `\nVerify exact signatures with unity_api_search (pass "Type.Member") before retrying.`;
      return appendNote(res, text);
    },
  };
}
