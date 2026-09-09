/**
 * Running a set of rules over one scanned document.
 *
 * Pure and store-free, so the whole decision — which rules run, what happens
 * when one throws, when a rule defers to Roslyn — is testable without Monaco
 * or Tauri. The engine keeps the Monaco wiring; this keeps the policy.
 */

import type { AnalyzerRule, Finding, RuleContext } from './analyzer-engine';
import type { CSharpScan } from './csharp-scan';

export interface RunRulesOptions {
  /** Per-rule settings gate. Defaults to "every rule is enabled". */
  isEnabled?: (rule: AnalyzerRule) => boolean;
}

/**
 * Run `rules` over `scan`, returning every finding.
 *
 * Two policies live here:
 *
 * **A rule that throws is skipped, not fatal.** These are regex heuristics
 * over possibly half-typed code; one of them hitting an edge case must not
 * take the other nineteen down with it.
 *
 * **A rule defers to Roslyn when Roslyn is actually running.** `supersededBy`
 * names the UNT diagnostics that cover the same ground with a real parser and
 * full type information. Deferring is only safe when those analyzers are
 * confirmed live — `ctx.roslynAnalyzersActive` comes from what the generated
 * csproj really references (see `unity_analyzers.rs`), not from an assumption
 * — because a machine where the analyzer package failed to unpack would
 * otherwise lose the inspection from both engines at once, with nothing
 * reported anywhere.
 */
export function runRules(
  rules: readonly AnalyzerRule[],
  scan: CSharpScan,
  ctx: RuleContext,
  options: RunRulesOptions = {},
): Finding[] {
  const isEnabled = options.isEnabled ?? (() => true);
  const findings: Finding[] = [];

  for (const rule of rules) {
    if (!isEnabled(rule)) continue;
    if (ctx.roslynAnalyzersActive && rule.supersededBy?.length) continue;
    try {
      findings.push(...rule.run(scan, ctx));
    } catch (err) {
      console.warn(`[unity-analyzers] rule '${rule.id}' threw (skipping):`, err);
    }
  }

  return findings;
}
