/**
 * Eval analog of production's analyzer gate (F-5.3,
 * `src/features/ai-panel/services/unity-tools/analyzer-gate.ts`,
 * `withUnityAnalyzerGate`): after a `.cs` write/edit, run the ported
 * error-severity rule (`analyzer-rule.ts`'s `runErrorRule` — the same Bun-safe
 * port `checks.ts`'s `analyzer_clean` check uses) on the resulting file
 * content and, if error-severity findings were introduced, append them to the
 * tool result so the eval agent gets the same in-loop repair stimulus
 * production gives it (without this gate, eval agent tasks never saw the
 * findings that drive real self-correction turns). The appended sentinel
 * (`[Unity analyzers] N error-severity issue(s)…`) is copied VERBATIM from
 * production's string construction — production's compaction logic protects
 * that exact text and telemetry counts occurrences of it, so the eval must
 * reproduce it byte-for-byte, not just "similar enough".
 *
 * Deltas from prod's `withUnityAnalyzerGate` (deliberate, not fidelity gaps):
 *  - Prod runs the full analyzer engine; this runs only the ported
 *    error-severity rule. That's not a reduction in coverage — of every rule
 *    the engine registers, `editor-api-in-runtime` is the only one that can
 *    ever produce an `error`-severity finding (see `checks.ts`'s header), so
 *    running just that rule finds every error-severity finding the full
 *    engine would.
 *  - Prod trusts `write`'s `params.content` directly and only re-reads from
 *    disk for `edit` (which carries no content field). This decorator always
 *    re-reads the resulting file from disk for both write and edit, so a
 *    write/edit that failed (the file was never actually mutated to the
 *    proposed content) naturally falls through untouched instead of gating on
 *    content that was never persisted.
 */

import { readFile } from 'node:fs/promises';
import type { AgentTool } from '../../src/features/ai-panel/services/vendor/types';
import { resolveToCwd } from '../../src/features/ai-panel/services/vendor/tools/path-utils';
import { runErrorRule } from './analyzer-rule';

export function withEvalAnalyzerGate(tool: AgentTool, workDir: string): AgentTool {
  return {
    ...tool,
    async execute(id, params, signal, onUpdate) {
      const res = await tool.execute(id, params, signal, onUpdate);
      const p = (params as { path?: string }).path;
      if (!p || !p.toLowerCase().endsWith('.cs')) return res;

      // Always re-read from disk (rather than trusting a write's params.content)
      // so a failed write/edit — where the file was never actually mutated —
      // passes through untouched; see module doc above.
      const content = await readFile(resolveToCwd(p, workDir), 'utf8').catch(() => null);
      if (content == null) return res;

      const findings = runErrorRule(content, p).filter((f) => f.severity === 'error');
      if (findings.length === 0) return res;

      // Exact string construction copied from `analyzer-gate.ts`'s
      // `withUnityAnalyzerGate` (production) — see that file for the source.
      const note = findings.map((f) => `  • ${f.code ?? f.ruleId}: ${f.message}`).join('\n');
      return {
        content: [
          ...res.content,
          {
            type: 'text',
            text:
              `\n\n[Unity analyzers] ${findings.length} error-severity issue(s) introduced by this C# write — ` +
              `fix them before finishing:\n${note}`,
          },
        ],
      };
    },
  };
}
