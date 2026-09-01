/**
 * Input callbacks subscribed in `OnEnable` and never unsubscribed in
 * `OnDisable`.
 *
 * `InputAction.performed += Handler` adds a delegate to an action that
 * outlives the component -- the action belongs to the asset, not to the
 * MonoBehaviour. Every enable/disable cycle therefore adds another handler, so
 * after N scene reloads the callback fires N times for one button press. It is
 * a slow, confusing leak that looks like a gameplay bug, and it never produces
 * a compiler warning.
 *
 * Structural, not asset-grounded: it needs no `.inputactions` snapshot, so it
 * also protects projects that build their actions in code with
 * `new InputAction(...)`.
 */

import type { AnalyzerRule, Finding } from '../services/analyzer-engine';
import type { CSharpScan } from '../services/csharp-scan';

const RULE_ID = 'unity/input-callback-leak';

/**
 * The three `InputAction` callback events. Requiring one of these is what
 * keeps the rule off ordinary C# events, which have their own (different)
 * lifetime rules and are not this rule's business.
 */
const EVENT_NAMES = ['performed', 'started', 'canceled'];

interface Subscription {
  /** The handler being attached, e.g. `OnJump`. */
  handler: string;
  /** `jump.performed` — used only for the message. */
  target: string;
  event: string;
  start: number;
  end: number;
}

function subscriptionsIn(
  code: string,
  from: number,
  to: number,
  operator: '+=' | '-=',
): Subscription[] {
  const body = code.slice(from, to);
  const re = new RegExp(
    String.raw`\b([\w.]+)\s*\.\s*(${EVENT_NAMES.join('|')})\s*` +
      (operator === '+=' ? String.raw`\+=` : String.raw`-=`) +
      String.raw`\s*([\w.]+)`,
    'g',
  );
  const out: Subscription[] = [];
  for (let m = re.exec(body); m !== null; m = re.exec(body)) {
    out.push({
      target: m[1],
      event: m[2],
      handler: m[3],
      start: from + m.index,
      end: from + m.index + m[0].length,
    });
  }
  return out;
}

function bodyOf(scan: CSharpScan, methodName: string): { from: number; to: number } | null {
  const method = scan.methods.find((m) => m.name === methodName);
  if (!method?.bodySpan) return null;
  return { from: method.bodySpan.start, to: method.bodySpan.end };
}

export const inputCallbackLeakRule: AnalyzerRule = {
  id: RULE_ID,
  defaultSeverity: 'warning',
  settingKey: 'unity.inputDiagnostics.enabled',

  run(scan): Finding[] {
    const enable = bodyOf(scan, 'OnEnable');
    if (!enable) return [];

    const subscribed = subscriptionsIn(scan.code, enable.from, enable.to, '+=');
    if (subscribed.length === 0) return [];

    const disable = bodyOf(scan, 'OnDisable');
    // No OnDisable at all is the worst version of this bug, not an exemption.
    const released = disable
      ? new Set(subscriptionsIn(scan.code, disable.from, disable.to, '-=').map((s) => s.handler))
      : new Set<string>();

    return subscribed
      .filter((sub) => !released.has(sub.handler))
      .map((sub) => ({
        ruleId: RULE_ID,
        code: 'UNITY0404',
        severity: 'warning' as const,
        message:
          `'${sub.handler}' is subscribed to ${sub.target}.${sub.event} in OnEnable but never ` +
          `removed in OnDisable${disable ? '' : ', which this class does not declare'}. ` +
          `The action outlives the component, so each enable/disable cycle adds another handler ` +
          `and the callback fires once per cycle. Add ` +
          `\`${sub.target}.${sub.event} -= ${sub.handler};\` to OnDisable.`,
        start: sub.start,
        end: sub.end,
      }));
  },
};
