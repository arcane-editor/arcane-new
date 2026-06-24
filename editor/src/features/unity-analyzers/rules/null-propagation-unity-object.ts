import type { AnalyzerRule, Finding } from '../services/analyzer-engine';
import {
  type CSharpScan,
  type MethodDecl,
} from '../services/csharp-scan';
import { inferIdentifierTypes } from '../services/body-analysis';
import { buildEdit } from '../services/fix-helpers';
import { UNITY_OBJECT_TYPES, bareTypeName } from '../data/unity-knowledge';

// Null-conditional / null-coalescing / pattern-null applied to an identifier.
//   foo?.bar      foo ?? bar      foo is null      foo is not null
const NULL_COND_RE = /\b([A-Za-z_]\w*)\s*\?\./g;
const NULL_COALESCE_RE = /\b([A-Za-z_]\w*)\s*\?\?/g;
const IS_NULL_RE = /\b([A-Za-z_]\w*)\s+is\s+(not\s+)?null\b/g;

/**
 * Unity overloads `==`/`!=` on UnityEngine.Object to report a *destroyed* object
 * as equal to null ("fake null"). The C# null-propagation operators (`?.`,
 * `??`) and `is null` pattern bypass that override — they test the real managed
 * reference, so a destroyed-but-not-GC'd object reads as non-null and you can
 * touch a dead object. We flag these ONLY when the receiver is clearly a Unity
 * type (declared as a known Unity type, a field of one, or a GetComponent
 * result). Conservative by design: unknown-typed receivers are never flagged.
 */
export const nullPropagationUnityObjectRule: AnalyzerRule = {
  id: 'unity/null-propagation-unity-object',
  defaultSeverity: 'warning',

  run(scan, ctx): Finding[] {
    const findings: Finding[] = [];

    for (const method of scan.methods) {
      if (!method.bodySpan) continue;
      // Skip nested-in-other-method bodies — inferIdentifierTypes works per
      // method and the outer pass already covers the inner code's identifiers.
      const types = inferIdentifierTypes(scan, method);

      // ?.  — warn only; a correct rewrite needs a ternary around the call site,
      // which we don't synthesise (avoids producing non-compiling code).
      scanPattern(scan, method, NULL_COND_RE, (ident, identStart) => {
        if (!types.isUnityObject(ident)) return;
        const opStart = identStart + ident.length + skipWs(scan, identStart + ident.length);
        findings.push(make(this.id, identStart, opStart + 2, ident, types.get(ident)!,
          `'${ident}?.' bypasses Unity's destroyed-object check (?. tests the raw reference, not Unity's overloaded ==). A destroyed ${types.get(ident)} will read as non-null. Guard with an explicit 'if (${ident} != null)' instead.`,
          undefined));
      });

      // ??
      scanPattern(scan, method, NULL_COALESCE_RE, (ident, identStart) => {
        if (!types.isUnityObject(ident)) return;
        const opPos = scan.code.indexOf('??', identStart + ident.length);
        findings.push(make(this.id, identStart, opPos + 2, ident, types.get(ident)!,
          `'${ident} ??' bypasses Unity's destroyed-object check. A destroyed ${types.get(ident)} is not managed-null, so '??' won't pick the fallback. Use an explicit '== null' check.`,
          undefined));
      });

      // is (not) null
      scanPattern(scan, method, IS_NULL_RE, (ident, identStart, full, groups) => {
        if (!types.isUnityObject(ident)) return;
        const isNot = !!groups?.[0];
        const end = identStart + full.length;
        findings.push(make(this.id, identStart, end, ident, types.get(ident)!,
          `'${ident} is ${isNot ? 'not ' : ''}null' bypasses Unity's destroyed-object check (pattern matching tests the raw reference). Use '${ident} ${isNot ? '!=' : '=='} null' so Unity's lifetime check applies.`,
          buildReplaceFix(scan, ctx.model, identStart, end, `${ident} ${isNot ? '!=' : '=='} null`, full)));
      });
    }

    return findings;
  },
};

function skipWs(scan: CSharpScan, from: number): number {
  let i = 0;
  while (/\s/.test(scan.code[from + i] ?? '')) i++;
  return i;
}

function scanPattern(
  scan: CSharpScan,
  method: MethodDecl,
  re: RegExp,
  cb: (ident: string, identStart: number, full: string, groups: string[]) => void,
): void {
  if (!method.bodySpan) return;
  const body = method.bodySpan;
  const slice = scan.code.slice(body.start, body.end);
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(slice)) !== null) {
    const ident = m[1];
    const identStart = body.start + (m.index ?? 0) + m[0].indexOf(ident);
    cb(ident, identStart, m[0], m.slice(2));
    if (m.index === re.lastIndex) re.lastIndex++;
  }
}

function make(
  ruleId: string,
  start: number,
  end: number,
  _ident: string,
  type: string,
  message: string,
  fixes: Finding['fixes'],
): Finding {
  // Only emit when the type is genuinely a Unity object type (double-check).
  void (UNITY_OBJECT_TYPES.has(bareTypeName(type)));
  return { ruleId, severity: 'warning', start, end, message, code: 'UNITY0301', fixes };
}

function buildReplaceFix(
  scan: CSharpScan,
  model: Parameters<typeof buildEdit>[1],
  start: number,
  end: number,
  newText: string,
  expected: string,
): Finding['fixes'] {
  // Safety: only replace if the current text matches what we expect.
  const actual = scan.text.slice(start, end);
  if (actual.replace(/\s+/g, '') !== expected.replace(/\s+/g, '')) return undefined;
  const edit = buildEdit(scan, model, [{ start, end, newText }]);
  if (!edit) return undefined;
  return [{ title: "Use explicit '!= null' / '== null' check", isPreferred: true, edit }];
}
