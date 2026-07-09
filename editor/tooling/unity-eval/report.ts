import type { AggregatedTaskResult } from './aggregate';

/**
 * Renders the markdown eval report. Input is always the aggregated shape
 * (one `AggregatedTaskResult` per task, wrapping 1..N per-attempt
 * `TaskResult`s — see `aggregate.ts`); at `--repeats 1` (the default) each
 * task has exactly one attempt and `passCount/repeats` reads as `1/1`.
 */
export function renderReport(results: AggregatedTaskResult[], label: string): string {
  const byFamily = new Map<string, AggregatedTaskResult[]>();
  for (const r of results) {
    byFamily.set(r.family, [...(byFamily.get(r.family) ?? []), r]);
  }
  const repeats = results[0]?.repeats ?? 1;
  const lines: string[] = [];
  const total = results.filter((r) => r.pass).length;
  lines.push(
    `# Unity eval — ${label}`,
    '',
    `**${total}/${results.length} passed**` + (repeats > 1 ? ` (repeats=${repeats}, majority scoring)` : ''),
    '',
  );
  // At repeats > 1 these columns are sums across attempts, not per-attempt
  // values — label them accordingly so the table isn't misread.
  const sumSuffix = repeats > 1 ? ' (Σ)' : '';
  lines.push(
    `| Task | Family | Pass | Score | Turns${sumSuffix} | Wall (s)${sumSuffix} | Tokens in/out${sumSuffix} | Failing checks |`,
  );
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    const turns = r.attempts.reduce((sum, a) => sum + a.turns, 0);
    const wallMs = r.attempts.reduce((sum, a) => sum + a.wallMs, 0);
    const inputTokens = r.attempts.reduce((sum, a) => sum + a.inputTokens, 0);
    const outputTokens = r.attempts.reduce((sum, a) => sum + a.outputTokens, 0);
    const failing =
      r.attempts
        .flatMap((a) => a.checks.filter((c) => !c.pass).map((c) => c.detail))
        .join('; ') || r.attempts.map((a) => a.error).filter(Boolean).join('; ');
    // Flakiness marker (attempts disagree) — `~` prefix on the pass glyph,
    // independent of which way the aggregated verdict landed.
    const passGlyph = `${r.pass ? '✅' : '❌'}${r.flaky ? ' ~' : ''}`;
    lines.push(
      `| ${r.taskId} | ${r.family} | ${passGlyph} | ${r.passCount}/${r.repeats} | ${turns} | ${(wallMs / 1000).toFixed(1)} | ${inputTokens}/${outputTokens} | ${failing} |`,
    );
  }
  lines.push('');
  for (const [family, rs] of byFamily) {
    lines.push(`- **${family}**: ${rs.filter((r) => r.pass).length}/${rs.length}`);
  }
  if (results.some((r) => r.flaky)) {
    lines.push('', '`~` marks a task whose attempts disagreed (flaky) — see its `attempts` in the results JSON.');
  }
  return lines.join('\n');
}
