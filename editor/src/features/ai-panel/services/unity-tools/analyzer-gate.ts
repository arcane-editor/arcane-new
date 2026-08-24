// Analyzer-gate (F-5.3) — after the agent writes/edits a .cs file, run the Unity
// analyzers on the new content and, if any error-severity findings were
// introduced, append them to the tool result so the agent self-corrects on its
// next turn (the loop naturally re-iterates until findings clear). Pure decorator
// over the generic write/edit tools — no vendor-loop changes.
//
// P5.3 finding: this gate wraps OUTSIDE `write-approval-gate.ts`, which sits
// closer to the raw tool — so a REJECTED write still reaches this gate's
// `execute`. Before the `isRejectedWrite` check below, the `write` branch
// analyzed `params.content` directly (by design, to avoid a re-read for a
// write it assumed had landed) — which meant a rejected write got analyzed as
// if the model's proposed-but-never-applied content were live, misreporting
// it as "issues introduced by this C# write". The early-out makes a rejected
// write inert here too (see `write-approval-gate.ts`'s header for the full
// investigation across all three cs-gates).

import type { AgentTool } from '../vendor/types';
import { runAnalyzersOnText } from '../../../unity-analyzers';
import { tauriReadOperations } from '../tool-operations';
import { resolveToCwd } from '../vendor/tools/path-utils';
import { isRejectedWrite, isSuccessfulWrite } from '../write-approval-gate';

export function withUnityAnalyzerGate(tool: AgentTool, cwd: string): AgentTool {
  return {
    ...tool,
    async execute(id, params, signal, onUpdate) {
      const res = await tool.execute(id, params, signal, onUpdate);
      if (isRejectedWrite(res)) return res;
      // Only a write that LANDED is worth analyzing. Without this the `write`
      // branch below analyzed `params.content` — the model's proposal — for
      // writes that failed for any non-rejection reason, and reported the
      // findings as "introduced by this C# write".
      if (!isSuccessfulWrite(res)) return res;
      const p = (params as { path?: string }).path;
      if (!p || !p.toLowerCase().endsWith('.cs')) return res;

      // `write` carries the content; `edit` does not, so re-read from disk.
      const content =
        (params as { content?: string }).content ??
        (await tauriReadOperations.readFile(resolveToCwd(p, cwd)).catch(() => null));
      if (content == null) return res;

      const findings = runAnalyzersOnText(content, p).filter((f) => f.severity === 'error');
      if (findings.length === 0) return res;

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
