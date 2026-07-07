import type { TaskResult } from './eval-types';

export function renderReport(results: TaskResult[], label: string): string {
  const byFamily = new Map<string, TaskResult[]>();
  for (const r of results) {
    byFamily.set(r.family, [...(byFamily.get(r.family) ?? []), r]);
  }
  const lines: string[] = [];
  const total = results.filter((r) => r.pass).length;
  lines.push(`# Unity eval — ${label}`, '', `**${total}/${results.length} passed**`, '');
  lines.push('| Task | Family | Pass | Turns | Wall (s) | Tokens in/out | Failing checks |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const r of results) {
    const failing = r.checks.filter((c) => !c.pass).map((c) => c.detail).join('; ') || (r.error ?? '');
    lines.push(
      `| ${r.taskId} | ${r.family} | ${r.pass ? '✅' : '❌'} | ${r.turns} | ${(r.wallMs / 1000).toFixed(1)} | ${r.inputTokens}/${r.outputTokens} | ${failing} |`,
    );
  }
  lines.push('');
  for (const [family, rs] of byFamily) {
    lines.push(`- **${family}**: ${rs.filter((r) => r.pass).length}/${rs.length}`);
  }
  return lines.join('\n');
}
