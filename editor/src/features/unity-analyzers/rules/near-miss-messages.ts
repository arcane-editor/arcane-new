import { LIFECYCLE_METHOD_NAMES } from '../../csharp';
import type { AnalyzerRule, Finding } from '../services/analyzer-engine';
import {
  offsetInSpan,
  type CSharpScan,
  type MethodDecl,
  type ClassDecl,
} from '../services/csharp-scan';
import { buildEdit, messageClasses } from '../services/fix-helpers';
import {
  MESSAGE_PARAM_TYPES,
  ZERO_PARAM_MESSAGES,
  bareTypeName,
} from '../data/unity-knowledge';

// Case-insensitive lookup table: lowercased name → canonical message name.
const LOWER_TO_CANONICAL = new Map<string, string>();
for (const name of LIFECYCLE_METHOD_NAMES) {
  LOWER_TO_CANONICAL.set(name.toLowerCase(), name);
}

/** Methods declared directly inside a class body (not nested in another method). */
function methodsInClass(scan: CSharpScan, cls: ClassDecl): MethodDecl[] {
  if (!cls.bodySpan) return [];
  return scan.methods.filter((m) => {
    if (!cls.bodySpan || !offsetInSpan(cls.bodySpan, m.nameOffset)) return false;
    // Exclude methods that are actually nested inside another method body.
    return !scan.methods.some(
      (other) =>
        other !== m &&
        other.bodySpan &&
        offsetInSpan(other.bodySpan, m.nameOffset),
    );
  });
}

/** Compare a method's parameter types to a message's expected types. */
function paramTypesMatch(method: MethodDecl, expected: string[]): boolean {
  if (method.params.length !== expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    const actual = bareTypeName(method.params[i].type);
    if (actual !== bareTypeName(expected[i])) return false;
  }
  return true;
}

/**
 * Near-miss Unity message detector. Inside classes whose base list names a
 * Unity message-receiving type, flag methods that are clearly *intended* to be
 * a Unity message but are subtly wrong:
 *   - wrong casing (case-insensitive match but not exact)        → fix the case
 *   - exact name, but the wrong parameter type for that message  → fix the type
 *   - exact name, but accidentally `static`                       → drop static
 *
 * Deliberately conservative: a correctly-spelled, correctly-typed,
 * non-static message is never flagged, and unrelated methods (no case-insensitive
 * match to any known message) are never flagged.
 */
export const nearMissMessagesRule: AnalyzerRule = {
  id: 'unity/near-miss-message',
  defaultSeverity: 'warning',
  settingKey: 'unity.nearMissDiagnostics.enabled',

  run(scan, ctx): Finding[] {
    const findings: Finding[] = [];

    for (const cls of messageClasses(scan)) {
      for (const method of methodsInClass(scan, cls)) {
        const exactCanonical = LIFECYCLE_METHOD_NAMES.has(method.name)
          ? method.name
          : null;
        const ciCanonical = LOWER_TO_CANONICAL.get(method.name.toLowerCase());

        const nameStart = method.nameOffset;
        const nameEnd = method.nameOffset + method.name.length;

        // 1) Wrong casing — case-insensitive match but NOT exact.
        if (!exactCanonical && ciCanonical) {
          findings.push({
            ruleId: this.id,
            severity: this.defaultSeverity,
            start: nameStart,
            end: nameEnd,
            code: 'UNITY0001',
            message: `Did you mean '${ciCanonical}'? Unity messages are case-sensitive — '${method.name}' will never be called by Unity.`,
            fixes: buildCaseFix(scan, ctx.model, nameStart, nameEnd, ciCanonical),
          });
          continue; // one finding per method
        }

        // For exact-name matches, check param types + static.
        if (exactCanonical) {
          // 2) Accidentally static — Unity won't invoke a static message.
          if (method.isStatic) {
            const staticFix = buildStaticFix(scan, ctx.model, method);
            findings.push({
              ruleId: this.id,
              severity: this.defaultSeverity,
              start: nameStart,
              end: nameEnd,
              code: 'UNITY0002',
              message: `Unity message '${exactCanonical}' must not be 'static' — Unity invokes it on the instance, so a static method is never called.`,
              fixes: staticFix,
            });
            continue;
          }

          // 3) Wrong parameter types for a known signature.
          const expected = MESSAGE_PARAM_TYPES[exactCanonical];
          if (expected && !paramTypesMatch(method, expected)) {
            // Offer a type-fix only when the arity already matches: we rewrite
            // each parameter's type to the canonical one while keeping the
            // parameter NAMES, which is unambiguous and always compiles. When
            // the arity differs we warn only (synthesising/removing params would
            // be guesswork).
            const fix =
              method.params.length === expected.length
                ? buildParamTypeFix(scan, ctx.model, method, expected)
                : undefined;
            const want = expected.join(', ');
            findings.push({
              ruleId: this.id,
              severity: this.defaultSeverity,
              start: nameStart,
              end: nameEnd,
              code: 'UNITY0003',
              message: `Unity message '${exactCanonical}' has the wrong signature — Unity calls it as '${exactCanonical}(${want})'. With a different signature it will never be invoked.`,
              fixes: fix,
            });
            continue;
          }

          // 4) Zero-param message that accidentally declares parameters.
          if (
            ZERO_PARAM_MESSAGES.has(exactCanonical) &&
            method.params.length > 0
          ) {
            findings.push({
              ruleId: this.id,
              severity: this.defaultSeverity,
              start: nameStart,
              end: nameEnd,
              code: 'UNITY0003',
              message: `Unity message '${exactCanonical}' takes no parameters — Unity will not call this overload.`,
            });
          }
        }
      }
    }

    return findings;
  },
};

function buildCaseFix(
  scan: CSharpScan,
  model: Parameters<typeof buildEdit>[1],
  start: number,
  end: number,
  canonical: string,
): Finding['fixes'] {
  const edit = buildEdit(scan, model, [{ start, end, newText: canonical }]);
  if (!edit) return undefined;
  return [{ title: `Rename to '${canonical}'`, isPreferred: true, edit }];
}

function buildStaticFix(
  scan: CSharpScan,
  model: Parameters<typeof buildEdit>[1],
  method: MethodDecl,
): Finding['fixes'] {
  // Remove the `static ` token from the head text.
  const headText = scan.code.slice(method.headSpan.start, method.headSpan.end);
  const m = /\bstatic\b\s*/.exec(headText);
  if (!m) return undefined;
  const start = method.headSpan.start + m.index;
  const end = start + m[0].length;
  const edit = buildEdit(scan, model, [{ start, end, newText: '' }]);
  if (!edit) return undefined;
  return [{ title: "Remove 'static'", isPreferred: true, edit }];
}

function buildParamTypeFix(
  scan: CSharpScan,
  model: Parameters<typeof buildEdit>[1],
  method: MethodDecl,
  expected: string[],
): Finding['fixes'] {
  // Rewrite each parameter's type to the expected one, preserving the
  // parameter name. We rebuild the whole parameter list inside the parens.
  const headText = scan.text.slice(method.headSpan.start, method.headSpan.end);
  const open = headText.lastIndexOf('(');
  const close = headText.lastIndexOf(')');
  if (open < 0 || close < 0 || close <= open) return undefined;

  const rebuilt = method.params
    .map((p, i) => {
      const type = expected[i] ?? p.type;
      const name = p.name || `arg${i}`;
      return `${type} ${name}`;
    })
    .join(', ');

  const editStart = method.headSpan.start + open + 1;
  const editEnd = method.headSpan.start + close;
  const edit = buildEdit(scan, model, [{ start: editStart, end: editEnd, newText: rebuilt }]);
  if (!edit) return undefined;
  return [
    {
      title: `Change signature to (${expected.join(', ')})`,
      isPreferred: true,
      edit,
    },
  ];
}
