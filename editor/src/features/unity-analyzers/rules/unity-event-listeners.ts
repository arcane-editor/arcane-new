// UNITY0502 / UNITY0503 — a prefab's UnityEvent points at a method that is gone.
//
// A Button's `onClick` stores `PauseController.OnResume` as a STRING in prefab
// YAML. Rename the method and nothing tells you: no compile error, no console
// warning, no Inspector marker. The button silently stops working. This is the
// cheapest real check in the whole UI feature because `unity_index.rs` already
// resolves the wiring; only the "does it still exist" join was missing.
//
// The squiggle lands on the class NAME rather than on a call site, because
// there is no call site — the reference lives in an asset, not in this file.

import type { AnalyzerRule, Finding, RuleContext } from '../services/analyzer-engine';
import type { CSharpScan } from '../services/csharp-scan';
import { getListenerSnapshot, type MethodUsage } from '../services/unity-events-cache';
import { judgeListener } from '../services/unity-event-ladder';

const RULE_ID = 'unity/unity-event-listeners';

/** `"Game.PauseController, Assembly-CSharp"` -> `PauseController`. */
function shortTypeName(targetType: string | null): string | null {
  if (!targetType) return null;
  const beforeComma = targetType.split(',')[0].trim();
  const bare = beforeComma.includes('.')
    ? beforeComma.slice(beforeComma.lastIndexOf('.') + 1)
    : beforeComma;
  return bare || null;
}

/** Where the listener lives, for the message. */
function describeSites(usages: MethodUsage[]): string {
  const seen: string[] = [];
  for (const u of usages) {
    const file = u.path.split('/').pop() ?? u.path;
    const label = u.gameObject ? `${file} (${u.gameObject})` : file;
    if (!seen.includes(label)) seen.push(label);
  }
  return seen.slice(0, 3).join(', ') + (seen.length > 3 ? `, +${seen.length - 3} more` : '');
}

export const unityEventListenersRule: AnalyzerRule = {
  id: RULE_ID,
  defaultSeverity: 'warning',
  settingKey: 'unity.uiDiagnostics.enabled',

  run(scan: CSharpScan, ctx: RuleContext): Finding[] {
    const snapshot = getListenerSnapshot(ctx.filePath);
    // Not loaded, or we could not read the script's guid. Either way there is
    // nothing to say — an unread index must never look like a missing method.
    if (!snapshot || !snapshot.trustworthy || snapshot.usages.length === 0) return [];

    const findings: Finding[] = [];
    const reported = new Set<string>();

    for (const usage of snapshot.usages) {
      if (!usage.methodName || reported.has(usage.methodName)) continue;

      // Attribute the wiring to the class the prefab actually targets. In a
      // multi-class file, blaming the first class for another's listener would
      // be worse than saying nothing.
      const targetName = shortTypeName(usage.targetType);
      const cls = targetName
        ? scan.classes.find((c) => c.name === targetName)
        : scan.classes.length === 1
          ? scan.classes[0]
          : undefined;
      if (!cls) continue;

      const verdict = judgeListener(scan, cls, usage.methodName);
      if (verdict.kind !== 'missing' && verdict.kind !== 'not-public') continue;

      reported.add(usage.methodName);
      const sameMethod = snapshot.usages.filter((u) => u.methodName === usage.methodName);
      const where = describeSites(sameMethod);
      const count = sameMethod.length;
      const plural = count === 1 ? 'listener' : 'listeners';

      if (verdict.kind === 'not-public') {
        findings.push({
          ruleId: RULE_ID,
          code: 'UNITY0503',
          severity: 'warning',
          message:
            `${count} UnityEvent ${plural} in ${where} call ${cls.name}.${usage.methodName}(), ` +
            `which is not public. The Inspector can only bind public methods, so this listener never fires.`,
          start: cls.nameOffset,
          end: cls.nameOffset + cls.name.length,
        });
        continue;
      }

      const suggestion = verdict.suggestion ? ` Did you mean '${verdict.suggestion}'?` : '';
      findings.push({
        ruleId: RULE_ID,
        code: 'UNITY0502',
        severity: 'warning',
        message:
          `${count} UnityEvent ${plural} in ${where} call ${cls.name}.${usage.methodName}(), ` +
          `which this class does not declare. Renaming a method does not update the Inspector ` +
          `wiring, so the listener silently never fires.${suggestion}`,
        start: cls.nameOffset,
        end: cls.nameOffset + cls.name.length,
      });
    }

    return findings;
  },
};
