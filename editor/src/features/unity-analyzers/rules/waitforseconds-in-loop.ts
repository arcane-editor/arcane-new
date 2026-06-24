import type { AnalyzerRule, Finding } from '../services/analyzer-engine';
import { type CSharpScan, type SourceSpan } from '../services/csharp-scan';
import { classReceivesMessages } from '../services/fix-helpers';
import { offsetInSpan } from '../services/csharp-scan';

// `yield return new WaitForSeconds(...)` (or WaitForSecondsRealtime).
const YIELD_WFS_RE =
  /\byield\s+return\s+new\s+(WaitForSeconds|WaitForSecondsRealtime)\s*\(/g;

/**
 * Allocating `new WaitForSeconds(x)` inside a loop creates a fresh GC object
 * every iteration. Caching the instance once and yielding the same object
 * avoids the per-iteration allocation. Flags only the in-loop case.
 */
export const waitForSecondsInLoopRule: AnalyzerRule = {
  id: 'unity/waitforseconds-in-loop',
  defaultSeverity: 'warning',

  run(scan, _ctx): Finding[] {
    const findings: Finding[] = [];

    for (const loop of loopBodiesInMessageClasses(scan)) {
      const slice = scan.code.slice(loop.start, loop.end);
      YIELD_WFS_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = YIELD_WFS_RE.exec(slice)) !== null) {
        const start = loop.start + m.index;
        findings.push({
          ruleId: this.id,
          severity: this.defaultSeverity,
          start,
          end: start + m[0].length - 1,
          code: 'UNITY0210',
          message: `'new ${m[1]}(...)' inside a loop allocates a new object every iteration. Cache one instance before the loop and 'yield return' that.`,
        });
      }
    }

    return findings;
  },
};

/** Spans of loop bodies inside classes that receive Unity messages. */
function loopBodiesInMessageClasses(scan: CSharpScan): SourceSpan[] {
  const spans: SourceSpan[] = [];
  const code = scan.code;
  const messageClassSpans = scan.classes
    .filter((c) => c.bodySpan && classReceivesMessages(c))
    .map((c) => c.bodySpan!) as SourceSpan[];
  if (messageClassSpans.length === 0) return spans;

  const loopRe = /\b(for|foreach|while|do)\b/g;
  let lm: RegExpExecArray | null;
  while ((lm = loopRe.exec(code)) !== null) {
    const at = lm.index;
    if (!messageClassSpans.some((s) => offsetInSpan(s, at))) continue;
    const braceIdx = code.indexOf('{', at);
    if (braceIdx < 0) continue;
    // Ensure the brace belongs to this loop (no `;`/`{` between keyword and brace
    // other than the loop header parens).
    const between = code.slice(at, braceIdx);
    if (/[};]/.test(between.replace(/\([^)]*\)/g, ''))) continue;
    let depth = 0;
    let close = -1;
    for (let i = braceIdx; i < code.length; i++) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}') {
        depth--;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close < 0) continue;
    spans.push({ start: braceIdx, end: close + 1 });
  }
  return spans;
}
