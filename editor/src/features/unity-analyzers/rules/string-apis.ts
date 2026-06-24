import type { AnalyzerRule, Finding } from '../services/analyzer-engine';
import {
  offsetInSpan,
  type CSharpScan,
  type ClassDecl,
} from '../services/csharp-scan';
import { classReceivesMessages, buildEdit, type PendingEdit } from '../services/fix-helpers';

// Reflection / messaging string APIs that should use nameof().
const REFLECTION_STRING_RE =
  /\b(Invoke|InvokeRepeating|SendMessage|SendMessageUpwards|BroadcastMessage|CancelInvoke|StartCoroutine|StopCoroutine)\s*\(\s*"([^"]*)"/g;

// Animator string-parameter setters/getters that should use a cached hash.
const ANIMATOR_STRING_RE =
  /\.\s*(SetFloat|SetInt|SetBool|SetTrigger|ResetTrigger|GetFloat|GetInt|GetBool|GetCurrentAnimatorStateInfo)\s*\(\s*"([^"]*)"/g;

export const stringApisRule: AnalyzerRule = {
  id: 'unity/string-api',
  defaultSeverity: 'info',

  run(scan, ctx): Finding[] {
    const findings: Finding[] = [];
    const code = scan.code;
    const text = scan.text;

    // Reflection/messaging APIs → suggest nameof(). We scan the whole file
    // (these aren't Update-scoped) but only inside message-receiving classes to
    // stay on-topic for Unity scripts.
    REFLECTION_STRING_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = REFLECTION_STRING_RE.exec(code)) !== null) {
      const api = m[1];
      const matchStart = m.index;
      if (!inMessageClass(scan, matchStart)) continue;
      // The literal value lives in the ORIGINAL text at the same offset.
      const literalRel = m[0].indexOf('"');
      const literalStart = matchStart + literalRel;
      const literalEnd = literalStart + m[2].length + 2; // include quotes
      const value = text.slice(literalStart + 1, literalEnd - 1);
      findings.push({
        ruleId: this.id,
        severity: this.defaultSeverity,
        start: literalStart,
        end: literalEnd,
        code: 'UNITY0203',
        message: `'${api}' with a string literal is not refactor-safe and skips compiler checks. Prefer 'nameof(${value})' so renames keep it in sync.`,
      });
    }

    // Animator string params → suggest cached Animator.StringToHash, with a fix.
    ANIMATOR_STRING_RE.lastIndex = 0;
    while ((m = ANIMATOR_STRING_RE.exec(code)) !== null) {
      const api = m[1];
      const matchStart = m.index;
      const owner = classAt(scan, matchStart);
      if (!owner || !classReceivesMessages(owner)) continue;

      const literalRel = m[0].indexOf('"');
      const literalStart = matchStart + literalRel;
      const literalEnd = literalStart + m[2].length + 2;
      const paramName = text.slice(literalStart + 1, literalEnd - 1);
      if (!/^[A-Za-z_]\w*$/.test(paramName)) {
        // Non-identifier-ish parameter name: warn without an auto-fix.
        findings.push({
          ruleId: this.id,
          severity: this.defaultSeverity,
          start: literalStart,
          end: literalEnd,
          code: 'UNITY0204',
          message: `Animator.${api}("${paramName}") hashes the string every call. Cache 'Animator.StringToHash("${paramName}")' in a static readonly int.`,
        });
        continue;
      }

      const fix = buildAnimatorHashFix(scan, ctx.model, owner, paramName, literalStart, literalEnd);
      findings.push({
        ruleId: this.id,
        severity: this.defaultSeverity,
        start: literalStart,
        end: literalEnd,
        code: 'UNITY0204',
        message: `Animator.${api}("${paramName}") re-hashes the string on every call. Use a cached 'Animator.StringToHash' id (static readonly int).`,
        fixes: fix,
      });
    }

    return findings;
  },
};

function classAt(scan: CSharpScan, offset: number): ClassDecl | undefined {
  return scan.classes.find((c) => c.bodySpan && offsetInSpan(c.bodySpan, offset));
}

function inMessageClass(scan: CSharpScan, offset: number): boolean {
  const c = classAt(scan, offset);
  return !!c && classReceivesMessages(c);
}

function hashFieldName(paramName: string): string {
  return `${paramName.charAt(0).toLowerCase()}${paramName.slice(1)}Hash`;
}

/**
 * Quick-fix: declare `static readonly int <param>Hash = Animator.StringToHash("<param>")`
 * at the top of the class (if not already present) and replace the string
 * literal at the call site with the hash field.
 */
function buildAnimatorHashFix(
  scan: CSharpScan,
  model: Parameters<typeof buildEdit>[1],
  owner: ClassDecl,
  paramName: string,
  literalStart: number,
  literalEnd: number,
): Finding['fixes'] {
  if (!owner.bodySpan || !model) return undefined;
  const fieldName = hashFieldName(paramName);

  const edits: PendingEdit[] = [];

  // Add the cache field only if it doesn't already exist in this class.
  const exists = scan.fields.some(
    (f) => f.name === fieldName && owner.bodySpan && offsetInSpan(owner.bodySpan, f.nameOffset),
  );
  if (!exists) {
    const bodyOpen = owner.bodySpan.start;
    const classIndentMatch = /(^|\n)([ \t]*)\S/.exec(
      scan.text.slice(Math.max(0, bodyOpen - 200), bodyOpen),
    );
    const baseIndent = classIndentMatch ? classIndentMatch[2] : '';
    const indent = baseIndent + '    ';
    edits.push({
      start: bodyOpen + 1,
      end: bodyOpen + 1,
      newText: `\n${indent}private static readonly int ${fieldName} = Animator.StringToHash("${paramName}");`,
    });
  }

  // Replace the "param" literal with the hash field reference.
  edits.push({ start: literalStart, end: literalEnd, newText: fieldName });

  const edit = buildEdit(scan, model, edits);
  if (!edit) return undefined;
  return [
    {
      title: `Cache as Animator.StringToHash and use '${fieldName}'`,
      isPreferred: true,
      edit,
    },
  ];
}
