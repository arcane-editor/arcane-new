import type { AnalyzerRule, Finding } from '../services/analyzer-engine';

// transform.position (or .localPosition) member access.
const POSITION_ACCESS_RE = /\btransform\s*\.\s*(?:local)?position\b/g;
// transform.position = ... (assignment).
const POSITION_ASSIGN_RE = /\btransform\s*\.\s*(?:local)?position\s*=/g;

/**
 * Reading/writing `transform.position` is a property access that marshals a
 * Vector3 each time (and dirties the Transform on assignment). Doing it 3+ times
 * in one method — or assigning it twice in sequence — usually means the author
 * meant to compute one Vector3 and assign it once. We flag the pattern
 * conservatively (informational) so it never spams correct single-assignment code.
 */
export const transformPositionPerAxisRule: AnalyzerRule = {
  id: 'unity/transform-position-per-axis',
  defaultSeverity: 'info',

  run(scan, _ctx): Finding[] {
    const findings: Finding[] = [];

    for (const method of scan.methods) {
      if (!method.bodySpan) continue;
      const slice = scan.code.slice(method.bodySpan.start, method.bodySpan.end);

      const accesses: number[] = [];
      POSITION_ACCESS_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = POSITION_ACCESS_RE.exec(slice)) !== null) {
        accesses.push(method.bodySpan.start + m.index);
      }

      const assigns: number[] = [];
      POSITION_ASSIGN_RE.lastIndex = 0;
      while ((m = POSITION_ASSIGN_RE.exec(slice)) !== null) {
        assigns.push(method.bodySpan.start + m.index);
      }

      // Two or more separate assignments → very likely meant a single Vector3.
      if (assigns.length >= 2) {
        const at = assigns[0];
        findings.push(infoAt(this.id, at,
          `'transform.position' is assigned ${assigns.length} times in ${method.name}(). Each assignment dirties the Transform and marshals a Vector3 — compute one Vector3 and assign it once.`));
        continue;
      }

      // Three or more accesses (reads) → suggest reading into a local once.
      if (accesses.length >= 3) {
        const at = accesses[0];
        findings.push(infoAt(this.id, at,
          `'transform.position' is read ${accesses.length} times in ${method.name}(). Each read marshals a Vector3 from native code — cache it in a local 'Vector3 pos = transform.position;' and reuse it.`));
      }
    }

    return findings;
  },
};

function infoAt(ruleId: string, at: number, message: string): Finding {
  return {
    ruleId,
    severity: 'info',
    start: at,
    end: at + 'transform.position'.length,
    code: 'UNITY0304',
    message,
  };
}
