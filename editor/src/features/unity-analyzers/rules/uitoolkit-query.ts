// UNITY0501 — `root.Q<Button>("play-btn")` names an element that does not exist.
//
// Unity compiles this happily and returns null at runtime, so the button simply
// never works — in a build, on someone else's machine, with no error anywhere.
// Nothing in the pipeline catches it today: not the UI Builder, not Rider, not
// a generic AI editor.
//
// **Why this rule is mostly suppression logic.** Measured over 12,898 real C#
// files: 208 distinct literal names reach `Q()`, and 21 of them exist in no
// `.uxml` at all — every one of those legitimately, because Unity's built-in
// controls name their own parts in C#. The naive check is wrong about 10% of
// the time, on correct code. So the reporting path is the LAST rung of a
// ladder, the severity is `warning` rather than `error`, and "not enough
// loaded to say" is answered with silence.
//
// `import type` from the engine is deliberate: `analyzer-engine.ts` imports
// `useProjectContextStore`, which reaches React, and a value import here would
// crash this rule's test on import alone under Bun's DOM-less runtime.

import type { AnalyzerRule, Finding } from '../services/analyzer-engine';
import { extractQuerySites, resolveQueryName } from '../../../utils/uitoolkit-refs';
import { getUxmlIndex, getCsUiRefIndex } from '../services/uitoolkit-cache';

const RULE_ID = 'unity/uitoolkit-query';

export const uitoolkitQueryRule: AnalyzerRule = {
  id: RULE_ID,
  defaultSeverity: 'warning',
  settingKey: 'unity.uiDiagnostics.enabled',

  run(scan): Finding[] {
    const uxml = getUxmlIndex();
    // No snapshot, or a project with no UXML at all, means every verdict below
    // would be a guess. A project can legitimately build its UI entirely in C#.
    // Same discipline as `input-actions.ts`.
    if (!uxml || uxml.docCount === 0) return [];

    const csRefs = getCsUiRefIndex();
    const projectNames = new Set(uxml.namesToDocs.keys());
    const findings: Finding[] = [];

    for (const site of extractQuerySites(scan.code, scan.text)) {
      if (!site.name || site.nameStart < 0) continue;

      const verdict = resolveQueryName(site.name, {
        // Resolving WHICH document a script drives needs the scene/prefab graph
        // and is async, so it is not available here yet. Null is a first-class
        // input: the ladder simply starts at its project-wide rung, which is
        // the weaker but never-wrong answer.
        associatedPath: null,
        associatedNames: null,
        projectNames,
        // Rung 4 is a suppressor. Handing it `null` until the C# walk finishes
        // is what keeps a cold start from reporting names it has not checked.
        csAssignedNames: csRefs.loaded ? csRefs.assignedNames : null,
        allNames: uxml.allNames,
      });

      if (verdict.kind !== 'unresolved') continue;

      const suggestion = verdict.suggestion
        ? ` Did you mean '${verdict.suggestion}'?`
        : '';
      findings.push({
        ruleId: RULE_ID,
        code: 'UNITY0501',
        severity: 'warning',
        message:
          `No element named '${site.name}' in any .uxml in this project, and nothing assigns ` +
          `that name in C#. This query returns null at runtime.${suggestion}`,
        start: site.nameStart,
        end: site.nameEnd,
      });
    }

    return findings;
  },
};
