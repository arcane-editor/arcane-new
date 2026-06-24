import type { AnalyzerRule, Finding } from '../services/analyzer-engine';
import { offsetInSpan } from '../services/csharp-scan';
import { classReceivesMessages } from '../services/fix-helpers';

// Destroy(this) / Destroy(this, delay) — destroys ONLY the component.
const DESTROY_THIS_RE = /\bDestroy\s*\(\s*this\s*(?:,|\))/g;

/**
 * `Destroy(this)` destroys only the MonoBehaviour component, leaving its
 * GameObject (and other components) alive — a frequent source of confusion when
 * the intent was to remove the whole object (`Destroy(gameObject)`). Informational.
 */
export const destroyThisRule: AnalyzerRule = {
  id: 'unity/destroy-this',
  defaultSeverity: 'info',

  run(scan, _ctx): Finding[] {
    const findings: Finding[] = [];
    const messageClassSpans = scan.classes
      .filter((c) => c.bodySpan && classReceivesMessages(c))
      .map((c) => c.bodySpan!);
    if (messageClassSpans.length === 0) return findings;

    DESTROY_THIS_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = DESTROY_THIS_RE.exec(scan.code)) !== null) {
      const start = m.index;
      if (!messageClassSpans.some((s: { start: number; end: number }) => offsetInSpan(s, start))) {
        continue;
      }
      // Highlight just the `this` token.
      const thisRel = m[0].indexOf('this');
      const thisStart = start + thisRel;
      findings.push({
        ruleId: this.id,
        severity: this.defaultSeverity,
        start: thisStart,
        end: thisStart + 'this'.length,
        code: 'UNITY0302',
        message: `'Destroy(this)' destroys only this component, not its GameObject. If you meant to remove the whole object, use 'Destroy(gameObject)'.`,
      });
    }
    return findings;
  },
};
