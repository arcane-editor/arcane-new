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
