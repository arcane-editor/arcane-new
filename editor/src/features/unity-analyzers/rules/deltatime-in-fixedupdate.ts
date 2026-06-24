import type { AnalyzerRule, Finding } from '../services/analyzer-engine';
import { type CSharpScan, type SourceSpan } from '../services/csharp-scan';
import { namedMethodBodies } from '../services/body-analysis';
import { buildEdit } from '../services/fix-helpers';

const DELTA_TIME_RE = /\bTime\s*\.\s*deltaTime\b/g;
const FIXED_DELTA_TIME_RE = /\bTime\s*\.\s*fixedDeltaTime\b/g;

/**
 * Physics runs on the fixed timestep, so inside FixedUpdate the correct
 * per-step delta is `Time.fixedDeltaTime`; using `Time.deltaTime` there makes
 * motion frame-rate dependent. Conversely, inside Update `Time.fixedDeltaTime`
 * is almost always a mistake — `Time.deltaTime` is the per-frame delta. We flag
 * both and offer a one-token swap.
 */
export const deltaTimeInFixedUpdateRule: AnalyzerRule = {
  id: 'unity/deltatime-in-fixedupdate',
  defaultSeverity: 'warning',

  run(scan, ctx): Finding[] {
    const findings: Finding[] = [];

    // deltaTime inside FixedUpdate → suggest fixedDeltaTime.
    for (const body of namedMethodBodies(scan, 'FixedUpdate')) {
      for (const off of matchOffsets(scan, body, DELTA_TIME_RE)) {
        const len = scan.text.slice(off).match(/^Time\s*\.\s*deltaTime/)?.[0].length ?? 'Time.deltaTime'.length;
        findings.push({
          ruleId: this.id,
          severity: this.defaultSeverity,
          start: off,
          end: off + len,
          code: 'UNITY0303',
          message: `'Time.deltaTime' inside FixedUpdate is frame-rate dependent — physics uses the fixed timestep. Use 'Time.fixedDeltaTime'.`,
          fixes: swapFix(scan, ctx.model, off, off + len, 'Time.fixedDeltaTime'),
        });
      }
    }

    // fixedDeltaTime inside Update → suggest deltaTime.
    for (const body of namedMethodBodies(scan, 'Update')) {
      for (const off of matchOffsets(scan, body, FIXED_DELTA_TIME_RE)) {
        const len = scan.text.slice(off).match(/^Time\s*\.\s*fixedDeltaTime/)?.[0].length ?? 'Time.fixedDeltaTime'.length;
        findings.push({
          ruleId: this.id,
          severity: this.defaultSeverity,
          start: off,
          end: off + len,
          code: 'UNITY0303',
          message: `'Time.fixedDeltaTime' inside Update is usually a mistake — per-frame code should use 'Time.deltaTime'.`,
          fixes: swapFix(scan, ctx.model, off, off + len, 'Time.deltaTime'),
        });
      }
    }

    return findings;
  },
};

function matchOffsets(scan: CSharpScan, body: SourceSpan, re: RegExp): number[] {
  const offsets: number[] = [];
  const slice = scan.code.slice(body.start, body.end);
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(slice)) !== null) {
    offsets.push(body.start + m.index);
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return offsets;
}

function swapFix(
  scan: CSharpScan,
  model: Parameters<typeof buildEdit>[1],
  start: number,
  end: number,
  newText: string,
): Finding['fixes'] {
  const edit = buildEdit(scan, model, [{ start, end, newText }]);
  if (!edit) return undefined;
  return [{ title: `Replace with '${newText}'`, isPreferred: true, edit }];
}
