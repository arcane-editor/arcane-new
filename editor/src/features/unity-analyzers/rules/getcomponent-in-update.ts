import type { AnalyzerRule, Finding } from '../services/analyzer-engine';
import {
  offsetInSpan,
  type CSharpScan,
  type ClassDecl,
  type MethodDecl,
} from '../services/csharp-scan';
import { updateFamilyBodies, matchesInBody } from '../services/body-analysis';
import { buildEdit, type PendingEdit } from '../services/fix-helpers';

// Component lookups. Each walks the object's component list (or, for the Find
// family, the whole scene) on every call.
const EXPENSIVE_CALL_RE =
  /\b(GetComponent|GetComponents|GetComponentInChildren|GetComponentsInChildren|GetComponentInParent|GetComponentsInParent|FindObjectOfType|FindObjectsOfType|FindFirstObjectByType|FindAnyObjectByType|FindObjectsByType)\s*(?:<\s*([A-Za-z_][\w.]*)\s*>)?\s*\(/g;

// Scene-wide searches by name or tag.
const GAMEOBJECT_FIND_RE =
  /\bGameObject\s*\.\s*(Find|FindWithTag|FindGameObjectWithTag|FindGameObjectsWithTag)\s*\(/g;

// `transform.Find("Child")` — a hierarchy walk with a string compare per node.
const TRANSFORM_FIND_RE = /\b(?:transform|\w+\.transform)\s*\.\s*(Find)\s*\(/g;

// Resources.Load hits the filesystem and the asset database.
const RESOURCES_LOAD_RE = /\bResources\s*\.\s*(Load|LoadAll|LoadAsync)\s*(?:<[^>]*>)?\s*\(/g;

// String-addressed messaging: a reflective lookup per call, and silent when
// the target method is renamed. UNT0016 covers Invoke/StartCoroutine; nothing
// upstream covers these.
const SEND_MESSAGE_RE =
  /\b(SendMessage|SendMessageUpwards|BroadcastMessage)\s*\(/g;

// Logging from a per-frame message. Each call formats a string and captures a
// stack trace even when the console is closed.
const DEBUG_LOG_RE = /\bDebug\s*\.\s*(Log|LogFormat|LogWarning|LogError)\s*\(/g;

export const getComponentInUpdateRule: AnalyzerRule = {
  id: 'unity/getcomponent-in-update',
  defaultSeverity: 'warning',
  codes: ['UNITY0201', 'UNITY0211', 'UNITY0212'],
  // Governed by the master `unity.analyzers.enabled` gate only.

  run(scan, ctx): Finding[] {
    const findings: Finding[] = [];

    for (const { method, body } of updateFamilyBodies(scan)) {
      const owner = scan.classes.find(
        (c) => c.bodySpan && offsetInSpan(c.bodySpan, method.nameOffset),
      );

      for (const m of matchesInBody(scan, body, EXPENSIVE_CALL_RE)) {
        const api = m[1];
        const typeArg = m[2];
        const start = m.index;
        const end = m.index + m[0].length - 1; // exclude the '('

        // Offer the hoist quick-fix only for the simple GetComponent<T>() case
        // where we can synthesise a typed cache field + Awake assignment.
        const fixes =
          owner && typeArg && /^GetComponent(InChildren|InParent)?$/.test(api)
            ? buildHoistFix(scan, ctx.model, owner, api, typeArg)
            : undefined;

        findings.push({
          ruleId: this.id,
          severity: this.defaultSeverity,
          start,
          end,
          code: 'UNITY0201',
          message: `'${api}' called inside ${method.name}() runs every frame and is expensive. Cache the result in a field (assign once in Awake/Start).`,
          fixes,
        });
      }

      for (const m of matchesInBody(scan, body, GAMEOBJECT_FIND_RE)) {
        const api = `GameObject.${m[1]}`;
        findings.push({
          ruleId: this.id,
          severity: this.defaultSeverity,
          start: m.index,
          end: m.index + m[0].length - 1,
          code: 'UNITY0201',
          message: `'${api}' inside ${method.name}() searches the whole scene every frame and is very expensive. Cache the reference once instead.`,
        });
      }

      for (const m of matchesInBody(scan, body, TRANSFORM_FIND_RE)) {
        findings.push({
          ruleId: this.id,
          severity: this.defaultSeverity,
          start: m.index,
          end: m.index + m[0].length - 1,
          code: 'UNITY0201',
          message: `'transform.Find' inside ${method.name}() walks the child hierarchy comparing names on every frame. Cache the child once instead.`,
        });
      }

      for (const m of matchesInBody(scan, body, RESOURCES_LOAD_RE)) {
        findings.push({
          ruleId: this.id,
          severity: this.defaultSeverity,
          start: m.index,
          end: m.index + m[0].length - 1,
          code: 'UNITY0201',
          message: `'Resources.${m[1]}' inside ${method.name}() hits the asset database every frame. Load once in Awake/Start and keep the reference.`,
        });
      }

      // Reflective messaging. Expensive per call, and silently wrong the
      // moment the target method is renamed — the compiler cannot see the
      // string. UNT0016 covers Invoke and StartCoroutine; these it does not.
      for (const m of matchesInBody(scan, body, SEND_MESSAGE_RE)) {
        findings.push({
          ruleId: this.id,
          severity: this.defaultSeverity,
          start: m.index,
          end: m.index + m[0].length - 1,
          code: 'UNITY0211',
          message: `'${m[1]}' inside ${method.name}() resolves the target method by reflection on every call. Hold a direct reference or use an event instead.`,
        });
      }

      // A hint, not a warning: this is a habit worth breaking rather than a
      // defect, and it is legitimate while debugging.
      for (const m of matchesInBody(scan, body, DEBUG_LOG_RE)) {
        findings.push({
          ruleId: this.id,
          severity: 'hint',
          start: m.index,
          end: m.index + m[0].length - 1,
          code: 'UNITY0212',
          message: `'Debug.${m[1]}' inside ${method.name}() formats a string and captures a stack trace on every frame, even with the console closed.`,
        });
      }
    }

    return findings;
  },
};

/** Find the Awake method declared directly in `owner`, if any. */
function findAwake(scan: CSharpScan, owner: ClassDecl): MethodDecl | undefined {
  return scan.methods.find(
    (m) =>
      m.name === 'Awake' &&
      m.bodySpan &&
      owner.bodySpan &&
      offsetInSpan(owner.bodySpan, m.nameOffset) &&
      !scan.methods.some(
        (o) => o !== m && o.bodySpan && offsetInSpan(o.bodySpan, m.nameOffset),
      ),
  );
}

/** Derive a cache field name from a type (`Rigidbody` → `_rigidbody`). */
function cacheFieldName(typeArg: string): string {
  const bare = typeArg.split('.').pop() ?? typeArg;
  return '_' + bare.charAt(0).toLowerCase() + bare.slice(1);
}

/**
 * Quick-fix: introduce a private cached field of the component type and assign
 * it once in Awake (creating Awake if needed). Does NOT rewrite the call sites
 * — that would require flow analysis; the field + assignment make the cache
 * available and the developer swaps the call. (Conservative + always compiles.)
 */
function buildHoistFix(
  scan: CSharpScan,
  model: Parameters<typeof buildEdit>[1],
  owner: ClassDecl,
  api: string,
  typeArg: string,
): Finding['fixes'] {
  if (!owner.bodySpan || !model) return undefined;
  const fieldName = cacheFieldName(typeArg);

  // Bail if a field of this name already exists in the class.
  const fieldExists = scan.fields.some(
    (f) => f.name === fieldName && owner.bodySpan && offsetInSpan(owner.bodySpan, f.nameOffset),
  );
  if (fieldExists) return undefined;

  const edits: PendingEdit[] = [];
  const bodyOpen = owner.bodySpan.start; // offset of class '{'
  // Indentation: one level inside the class. Derive from the class line + 4.
  const classIndentMatch = /(^|\n)([ \t]*)\S/.exec(
    scan.text.slice(Math.max(0, bodyOpen - 200), bodyOpen),
  );
  const baseIndent = classIndentMatch ? classIndentMatch[2] : '';
  const indent = baseIndent + '    ';

  // 1) Insert the cache field just after the class's opening brace.
  edits.push({
    start: bodyOpen + 1,
    end: bodyOpen + 1,
    newText: `\n${indent}private ${typeArg} ${fieldName};`,
  });

  const assignExpr = `${api}${`<${typeArg}>`}()`;
  const awake = findAwake(scan, owner);
  if (awake && awake.bodySpan) {
    // 2a) Add the assignment at the top of the existing Awake body.
    edits.push({
      start: awake.bodySpan.start + 1,
      end: awake.bodySpan.start + 1,
      newText: `\n${indent}    ${fieldName} = ${assignExpr};`,
    });
  } else {
    // 2b) No Awake — create one right after the field.
    edits.push({
      start: bodyOpen + 1,
      end: bodyOpen + 1,
      newText:
        `\n${indent}private void Awake()\n${indent}{\n` +
        `${indent}    ${fieldName} = ${assignExpr};\n${indent}}`,
    });
  }

  const edit = buildEdit(scan, model, edits);
  if (!edit) return undefined;
  return [
    {
      title: `Cache '${typeArg}' in a field and assign in Awake`,
      isPreferred: true,
      edit,
    },
  ];
}
