import type { AgentToolResult } from '../vendor/types';

// Pure formatting helpers with zero store/Monaco dependency — split out of
// `shared.ts` so tools with no other store-backed dependency (currently
// `api-search-tool.ts` and `docs-tool.ts`) can be imported directly under Bun
// (see `tooling/unity-eval/di-seam.test.ts`). `shared.ts` re-exports both for
// existing callers; behavior is unchanged.

/** Wrap a string as a text tool result. */
export function txt(s: string): AgentToolResult {
  return { content: [{ type: 'text', text: s }] };
}

/** Best-effort string-cap so a tool result never floods the context. */
export function cap(s: string, max = 8000): string {
  return s.length > max ? s.slice(0, max) + `\n…(${s.length - max} more chars truncated)` : s;
}

/**
 * Standard refusal text for a bridge-requiring tool with no connection. Pure
 * data (no store read) — lives here rather than `shared.ts` so `read-tools.ts`
 * can use it without pulling that file's `bridgeConnected()` (and therefore
 * `stores/unity.ts`) into scope. `shared.ts` re-exports it for existing callers.
 */
export const NOT_CONNECTED =
  'Unity bridge not connected — this needs a running Unity Editor with the UnityIDE bridge installed. ' +
  'If Unity is running, the connection drops briefly during every script recompile/domain reload and ' +
  'reconnects automatically — do any remaining file creation/editing first, then retry this. ' +
  'The IDE can still read project files statically with the read/list tools.';
