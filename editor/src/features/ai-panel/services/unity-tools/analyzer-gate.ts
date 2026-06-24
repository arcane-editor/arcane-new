// Analyzer-gate (F-5.3) — after the agent writes/edits a .cs file, run the Unity
// analyzers on the new content and, if any error-severity findings were
// introduced, append them to the tool result so the agent self-corrects on its
// next turn (the loop naturally re-iterates until findings clear). Pure decorator
// over the generic write/edit tools — no vendor-loop changes.

import type { AgentTool } from '../vendor/types';
import { runAnalyzersOnText } from '../../../unity-analyzers';
import { tauriReadOperations } from '../tool-operations';
import { resolveToCwd } from '../vendor/tools/path-utils';

export function withUnityAnalyzerGate(tool: AgentTool, cwd: string): AgentTool {
  return {
    ...tool,
    async execute(id, params, signal, onUpdate) {
      const res = await tool.execute(id, params, signal, onUpdate);
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
