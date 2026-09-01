/**
 * C# string literals validated against the project's own `.inputactions`.
 *
 * The New Input System couples code to the asset through **strings**, which
 * means the C# compiler validates none of it. Rename an action and
 * `FindAction("Jump")` still compiles, still runs, and simply returns null.
 * Bind two actions in one map to the same control and Unity reports nothing at
 * all while the second one silently never fires. These are the failures this
 * rule exists to make visible.
 *
 * One rule, three checks, because they share a single scan and a single data
 * source (`inputactions-cache`) — the same grouping `project-settings-
 * literals.ts` uses. Each check emits its own diagnostic code so they can be
 * reasoned about and suppressed independently.
 */

import type { AnalyzerRule, Finding } from '../services/analyzer-engine';
import { getInputActionsIndex, type InputActionsIndex } from '../services/inputactions-cache';

/** `expectedControlType` -> the C# types `ReadValue<T>()` may legally use. */
const CONTROL_TYPE_READS: Record<string, string[]> = {
  Button: ['float'],
  Axis: ['float'],
  Analog: ['float'],
  Digital: ['float', 'int'],
  Vector2: ['Vector2'],
  Vector3: ['Vector3'],
  Quaternion: ['Quaternion'],
  Dpad: ['Vector2'],
  Stick: ['Vector2'],
  Touch: ['TouchState'],
};

const FIND_ACTION_RE = /\bFindAction\s*\(\s*"([^"\n]*)"/g;
const ACTIONS_INDEXER_RE = /\.\s*actions\s*\[\s*"([^"\n]*)"\s*\]/g;
const FIND_MAP_RE = /\bFindActionMap\s*\(\s*"([^"\n]*)"/g;
/** `x = <anything>.FindAction("A")` — ties a local to the action it holds. */
const ACTION_ASSIGN_RE = /\b(\w+)\s*=\s*[^;\n]*?\bFindAction\s*\(\s*"([^"\n]*)"/g;
const READ_VALUE_RE = /\b(\w+)\s*\.\s*ReadValue\s*<\s*([\w.]+)\s*>\s*\(/g;

interface LiteralHit {
  value: string;
  start: number;
  end: number;
  groups: string[];
}

/**
 * Find literal occurrences, matching on the BLANKED view so a call inside a
 * comment or another string never counts, then reading the literal's real
 * value back out of the original text at the same offsets. `scan.code`
 * preserves offsets and length exactly, which is what makes this safe.
 */
function literalHits(code: string, text: string, re: RegExp, literalGroup: number): LiteralHit[] {
  const out: LiteralHit[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(code); m !== null; m = re.exec(code)) {
    const blanked = m[literalGroup];
    const rel = m[0].lastIndexOf(`"${blanked}"`);
    if (rel < 0) continue;
    const start = m.index + rel;
    const end = start + blanked.length + 2;
    out.push({ value: text.slice(start + 1, end - 1), start, end, groups: m.slice(1) });
  }
  return out;
}

/** Split `"Player/Jump"` into its parts; a bare name has no map. */
function splitQualified(literal: string): { map: string | null; action: string } {
  const slash = literal.lastIndexOf('/');
  return slash === -1
    ? { map: null, action: literal }
    : { map: literal.slice(0, slash), action: literal.slice(slash + 1) };
}

/** Resolve a literal to a known action, or explain why it does not resolve. */
function resolve(index: InputActionsIndex, literal: string) {
  const { map, action } = splitQualified(literal);
  if (map !== null) {
    const exact = index.byQualifiedName.get(literal);
    if (exact) return { known: exact, reason: null };
    // The action exists somewhere, just not in the map the literal names.
    const elsewhere = index.byName.get(action);
    if (elsewhere?.length) {
      return {
        known: null,
        reason: `No action '${action}' in map '${map}'. It exists in ${elsewhere
          .map((k) => `'${k.mapName}'`)
          .join(', ')}.`,
      };
    }
    return { known: null, reason: `No action '${action}' in any map.` };
  }

  const matches = index.byName.get(action);
  if (matches?.length) return { known: matches[0], reason: null };
  return { known: null, reason: `No action named '${action}' in any .inputactions asset.` };
}

const RULE_ID = 'unity/input-actions';

export const inputActionsRule: AnalyzerRule = {
  id: RULE_ID,
  defaultSeverity: 'warning',
  settingKey: 'unity.inputDiagnostics.enabled',

  run(scan): Finding[] {
    const index = getInputActionsIndex();
    // No snapshot (cold start, non-Unity folder) or no assets at all means
    // every check below would be guessing. Stay silent — a project can
    // legitimately create its actions in code with `new InputAction(...)`.
    if (!index || index.assetCount === 0) return [];

    const { code, text } = scan;
    const findings: Finding[] = [];

    // -- Check 1 + 3: does the literal resolve, and does it ever fire? --------
    const literalSites = [
      ...literalHits(code, text, FIND_ACTION_RE, 1),
      ...literalHits(code, text, ACTIONS_INDEXER_RE, 1),
    ];

    for (const hit of literalSites) {
      if (hit.value === '') continue;
      const { known, reason } = resolve(index, hit.value);

      if (!known) {
        findings.push({
          ruleId: RULE_ID,
          code: 'UNITY0401',
          severity: 'warning',
          message: `${reason} This compiles and returns null at runtime, so the action never fires.`,
          start: hit.start,
          end: hit.end,
        });
        continue;
      }

      if (known.starved) {
        const conflict = index.conflicts.find((c) => c.starved.includes(known.qualifiedName));
        findings.push({
          ruleId: RULE_ID,
          code: 'UNITY0403',
          severity: 'warning',
          message:
            `'${known.qualifiedName}' never fires: ${conflict?.winner ?? 'another action'} is bound ` +
            `to ${conflict?.path ?? 'the same control'} earlier in the same map and consumes it. ` +
            `Rebind one of them.`,
          start: hit.start,
          end: hit.end,
        });
      }
    }

    // -- Check 1b: the map literal ------------------------------------------
    for (const hit of literalHits(code, text, FIND_MAP_RE, 1)) {
      if (hit.value === '') continue;
      if (index.mapNames.has(hit.value)) continue;
      findings.push({
        ruleId: RULE_ID,
        code: 'UNITY0401',
        severity: 'warning',
        message:
          `No action map named '${hit.value}'. Known maps: ` +
          `${[...index.mapNames].map((m) => `'${m}'`).join(', ')}.`,
        start: hit.start,
        end: hit.end,
      });
    }

    // -- Check 2: ReadValue<T> against the action's expectedControlType ------
    // Locals are tied to their action by the assignment that produced them,
    // which is precise enough for the overwhelmingly common shape
    // (`jump = player.FindAction("Jump")` in Awake) without needing real
    // dataflow. A local we never saw assigned is simply skipped.
    const actionOfLocal = new Map<string, string>();
    for (const hit of literalHits(code, text, ACTION_ASSIGN_RE, 2)) {
      if (hit.groups[0]) actionOfLocal.set(hit.groups[0], hit.value);
    }

    READ_VALUE_RE.lastIndex = 0;
    for (let m = READ_VALUE_RE.exec(code); m !== null; m = READ_VALUE_RE.exec(code)) {
      const literal = actionOfLocal.get(m[1]);
      if (!literal) continue;
      const { known } = resolve(index, literal);
      if (!known?.expectedControlType) continue;

      const allowed = CONTROL_TYPE_READS[known.expectedControlType];
      if (!allowed) continue; // an control type we have no opinion about
      const readType = m[2].split('.').pop() ?? m[2];
      if (allowed.includes(readType)) continue;

      findings.push({
        ruleId: RULE_ID,
        code: 'UNITY0402',
        severity: 'error',
        message:
          `'${known.qualifiedName}' expects ${known.expectedControlType}, so ReadValue<${readType}>() ` +
          `throws InvalidOperationException the first frame it is polled. Use ReadValue<${allowed[0]}>()` +
          `${known.expectedControlType === 'Button' ? ', or IsPressed() for a Button' : ''}.`,
        start: m.index,
        end: m.index + m[0].length - 1,
      });
    }

    return findings;
  },
};
