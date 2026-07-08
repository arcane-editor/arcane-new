// LSP diagnostics gate (P3.3) — csharp-ls diagnostics are shown to the USER
// (Monaco markers, Problems panel) but were never fed back to the MODEL. This
// gate is the language-server sibling of the analyzer-gate/compile-gate: after
// the agent writes/edits a .cs file, it pulls ERROR-severity csharp-ls
// diagnostics for the new content and appends them to the tool result, in the
// same sentinel style, so the model repairs in-loop.
//
// csharp-ls is the sole C# diagnostics source and requires an ephemeral open
// for files not already tracked (see `features/lsp`'s `requestFileDiagnostics`)
// — that call is defensive (timeout, not-running checks, never throws) because
// it runs inside the agent's tool loop, where a hang blocks everything. This
// gate adds nothing on top of that beyond formatting: on any fetch failure it
// leaves the inner tool result untouched, exactly like a clean/no-error run.
//
// `fetchDiagnostics` is injectable (mirrors `compile-gate.ts`'s `HintLookup`
// seam) so this file stays directly Bun-testable. Its default reaches the real
// implementation via a DYNAMIC import of the `features/lsp` barrel rather than
// a static one: `lsp/index.ts` re-exports `services/providers.ts`, which pulls
// in `stores/workspace.ts` → the `editor` feature barrel → `@monaco-editor/react`
// and `stores/theme.ts` (a `document.documentElement` module-scope side
// effect) — none of which survive a static import under Bun's DOM-less test
// runtime. A dynamic import defers that whole chain until the default fetcher
// is actually invoked, which never happens in tests (they always inject a fake).

import { invoke } from '@tauri-apps/api/core';
import type { AgentTool, AgentToolResult } from '../vendor/types';
import { resolveToCwd } from '../vendor/tools/path-utils';
import type { FileDiag } from '../../../lsp';

export type DiagnosticsFetcher = (absPath: string, content: string) => Promise<FileDiag[]>;

async function defaultFetchDiagnostics(absPath: string, content: string): Promise<FileDiag[]> {
  const { requestFileDiagnostics } = await import('../../../lsp');
  return requestFileDiagnostics(absPath, content);
}

/**
 * `write`/`edit` never throw on failure — they catch internally and return a
 * text result. The only textual convention distinguishing success is the
 * leading "Successfully wrote"/"Successfully edited" both tools use (see
 * `vendor/tools/write.ts` and `vendor/tools/edit.ts`); anything else (a
 * thrown-and-caught error message, a path-outside-root message, a failed
 * search-and-replace) means the file on disk wasn't actually changed by this
 * call, so there's nothing new for csharp-ls to see.
 */
function isSuccessfulWrite(res: AgentToolResult): boolean {
  const text = res.content.find((c): c is { type: 'text'; text: string } => c.type === 'text')?.text ?? '';
  return /^Successfully (wrote|edited)\b/.test(text);
}

/** Best-effort path relative to the workspace root, for a shorter model-facing note. */
function toRelativePath(absPath: string, cwd: string): string {
  const normCwd = (cwd.endsWith('/') ? cwd : `${cwd}/`).toLowerCase();
  return absPath.toLowerCase().startsWith(normCwd) ? absPath.slice(normCwd.length) : absPath;
}

function formatError(d: FileDiag): string {
  return `  • line ${d.line}: ${d.message}${d.code ? ` (${d.code})` : ''}`;
}

function appendNote(res: AgentToolResult, text: string): AgentToolResult {
  return { ...res, content: [...res.content, { type: 'text', text }] };
}

export function withLspDiagnosticsGate(
  tool: AgentTool,
  cwd: string,
  fetchDiagnostics: DiagnosticsFetcher = defaultFetchDiagnostics,
): AgentTool {
  return {
    ...tool,
    async execute(id, params, signal, onUpdate) {
      const res = await tool.execute(id, params, signal, onUpdate);
      const p = (params as { path?: string }).path;
      if (!p || !p.toLowerCase().endsWith('.cs')) return res;
      if (!isSuccessfulWrite(res)) return res;

      const absPath = resolveToCwd(p, cwd);
      // `write` carries the content; `edit` does not, so re-read from disk.
      // Calls `invoke` directly (the same `read_file` command `tool-operations.ts`'s
      // `tauriReadOperations.readFile` wraps) instead of importing that module,
      // which eagerly pulls in `stores/workspace.ts` → the `editor` feature barrel
      // → `@monaco-editor/react` — the same Bun-unsafe chain `defaultFetchDiagnostics`
      // avoids above by deferring to a dynamic import.
      const content =
        (params as { content?: string }).content ??
        (await invoke<string>('read_file', { path: absPath }).catch(() => null));
      if (content == null) return res;

      let diagnostics: FileDiag[];
      try {
        diagnostics = await fetchDiagnostics(absPath, content);
      } catch {
        return res;
      }

      const errors = diagnostics.filter((d) => d.severity === 'error');
      if (errors.length === 0) return res;

      const relPath = toRelativePath(absPath, cwd);
      const note =
        `\n\n[C# language server] ${errors.length} error(s) in ${relPath}:\n` +
        errors.map(formatError).join('\n');
      return appendNote(res, note);
    },
  };
}
