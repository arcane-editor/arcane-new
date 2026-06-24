import { LIFECYCLE_METHOD_NAMES } from '../../csharp';
import type { AnalyzerRule, Finding } from '../services/analyzer-engine';
import {
  offsetInSpan,
  type CSharpScan,
  type ClassDecl,
  type MethodDecl,
} from '../services/csharp-scan';
import { messageClasses, buildEdit } from '../services/fix-helpers';

/**
 * Empty Unity messages (`void Update() { }`) still cost engine→managed call
 * overhead every relevant tick even though they do nothing. Flag them and offer
 * to delete the method. Only fires for the perf-sensitive frequently-called
 * messages where the overhead is meaningful.
 */
const FREQUENT_MESSAGES = new Set([
  'Update', 'FixedUpdate', 'LateUpdate', 'OnGUI',
  'OnTriggerStay', 'OnTriggerStay2D', 'OnCollisionStay', 'OnCollisionStay2D',
  'OnMouseOver', 'OnMouseDrag', 'OnWillRenderObject', 'OnRenderObject',
  'OnPreRender', 'OnPostRender', 'OnPreCull', 'OnAnimatorMove',
]);

export const emptyMessagesRule: AnalyzerRule = {
  id: 'unity/empty-message',
  defaultSeverity: 'warning',

  run(scan, ctx): Finding[] {
    const findings: Finding[] = [];

    for (const cls of messageClasses(scan)) {
      for (const method of directMethods(scan, cls)) {
        if (!LIFECYCLE_METHOD_NAMES.has(method.name)) continue;
        if (!FREQUENT_MESSAGES.has(method.name)) continue;
        if (!method.bodySpan) continue;
        if (!isEmptyBody(scan, method)) continue;

        const nameStart = method.nameOffset;
        const nameEnd = method.nameOffset + method.name.length;
        findings.push({
          ruleId: this.id,
          severity: this.defaultSeverity,
          start: nameStart,
          end: nameEnd,
          code: 'UNITY0209',
          message: `Empty Unity message '${method.name}()' still incurs per-call engine overhead. Remove it if it has no body.`,
          fixes: buildDeleteFix(scan, ctx.model, method),
        });
      }
    }

    return findings;
  },
};

function directMethods(scan: CSharpScan, cls: ClassDecl): MethodDecl[] {
  if (!cls.bodySpan) return [];
  return scan.methods.filter(
    (m) =>
      cls.bodySpan &&
      offsetInSpan(cls.bodySpan, m.nameOffset) &&
      !scan.methods.some(
        (o) => o !== m && o.bodySpan && offsetInSpan(o.bodySpan, m.nameOffset),
      ),
  );
}

/** The body contains only whitespace (comments already blanked in `code`). */
function isEmptyBody(scan: CSharpScan, method: MethodDecl): boolean {
  if (!method.bodySpan) return false;
  const inner = scan.code.slice(method.bodySpan.start + 1, method.bodySpan.end - 1);
  return inner.trim().length === 0;
}

function buildDeleteFix(
  scan: CSharpScan,
  model: Parameters<typeof buildEdit>[1],
  method: MethodDecl,
): Finding['fixes'] {
  if (!method.bodySpan) return undefined;
  // Delete from the start of the declaration head to the end of the body,
  // plus any leading whitespace/newline so we don't leave a blank line.
  let start = method.headSpan.start;
  const text = scan.text;
  // Walk back over leading whitespace on the same indentation.
  while (start > 0 && (text[start - 1] === ' ' || text[start - 1] === '\t')) start--;
  if (start > 0 && text[start - 1] === '\n') start--;
  const end = method.bodySpan.end;
  const edit = buildEdit(scan, model, [{ start, end, newText: '' }]);
  if (!edit) return undefined;
  return [{ title: `Delete empty '${method.name}()'`, isPreferred: true, edit }];
}
