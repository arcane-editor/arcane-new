/**
 * String literals validated against the project's own settings assets.
 *
 * These are the bugs Unity ships with **no error at all**: a mistyped tag, a
 * layer that was renamed, a scene missing from the build settings, an input
 * axis that only exists on the developer's machine. None of them are visible
 * to the C# compiler, so nothing in a conventional IDE catches them — the game
 * simply misbehaves at runtime.
 *
 * One rule, six checks, because they share a single scan and a single data
 * source (`project-settings-cache`). Each check emits its own diagnostic code
 * so they can be reasoned about (and suppressed) independently.
 */

import type { AnalyzerRule, Finding } from '../services/analyzer-engine';
import { getProjectSettings } from '../services/project-settings-cache';

/**
 * Find `api("literal")` occurrences.
 *
 * Matching runs against `scan.code` — the blanked view, where string CONTENTS
 * are replaced but offsets and lengths are preserved — so a call that appears
 * inside a comment or another string is never matched. The literal's real
 * value therefore has to be read back out of `scan.text` at the same offset;
 * reading it from `code` yields the blanked placeholder, which is what
 * `string-apis.ts` already does for the same reason.
 */
function literalCalls(
  code: string,
  text: string,
  re: RegExp,
): Array<{ value: string; start: number; end: number }> {
  const out: Array<{ value: string; start: number; end: number }> = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const blanked = m[m.length - 1];
    const rel = m[0].lastIndexOf(`"${blanked}"`);
    if (rel < 0) continue;
    const start = m.index + rel;
    const end = start + blanked.length + 2;
    out.push({ value: text.slice(start + 1, end - 1), start, end });
  }
  return out;
}

// Tag APIs, plus the `tag == "..."` / `"..." == tag` comparison forms.
const TAG_CALL_RE =
  /\b(?:CompareTag|FindWithTag|FindGameObjectWithTag|FindGameObjectsWithTag)\s*\(\s*"([^"\n]*)"/g;
const TAG_COMPARE_RE = /\btag\s*[!=]=\s*"([^"\n]*)"/g;
const TAG_COMPARE_REVERSED_RE = /"([^"\n]*)"\s*[!=]=\s*\w*\.?\btag\b/g;

const LAYER_RE = /\bLayerMask\s*\.\s*(?:NameToLayer|GetMask)\s*\(\s*"([^"\n]*)"/g;
const SCENE_RE =
  /\bSceneManager\s*\.\s*(?:LoadScene|LoadSceneAsync|UnloadSceneAsync|GetSceneByName)\s*\(\s*"([^"\n]*)"/g;
const INPUT_RE =
  /\bInput\s*\.\s*(?:GetAxis|GetAxisRaw|GetButton|GetButtonDown|GetButtonUp)\s*\(\s*"([^"\n]*)"/g;
const RESOURCES_RE = /\bResources\s*\.\s*(?:Load|LoadAll|LoadAsync)\s*(?:<[^>]*>)?\s*\(\s*"([^"\n]*)"/g;

function near(candidates: string[], value: string): string {
  const lower = value.toLowerCase();
  const hit = candidates.find((c) => c.toLowerCase() === lower);
  return hit ? ` Did you mean '${hit}'?` : '';
}

export const projectSettingsLiteralsRule: AnalyzerRule = {
  id: 'unity/project-settings-literals',
  defaultSeverity: 'warning',
  settingKey: 'unity.projectSettingsDiagnostics.enabled',

  run(scan): Finding[] {
    const settings = getProjectSettings();
    // No snapshot (cold start, non-Unity folder, or a binary-serialized
    // project) means every check below would be guessing. Stay silent.
    if (!settings) return [];

    const code = scan.code;
    const text = scan.text;
    const findings: Finding[] = [];

    const push = (
      hit: { value: string; start: number; end: number },
      diagCode: string,
      message: string,
    ) =>
      findings.push({
        ruleId: this.id,
        severity: this.defaultSeverity,
        start: hit.start,
        end: hit.end,
        code: diagCode,
        message,
      });

    // ── tags ────────────────────────────────────────────────────
    // Unity always accepts "Untagged" even when the tag list is empty.
    const knownTags = ['Untagged', ...settings.tags];
    for (const re of [TAG_CALL_RE, TAG_COMPARE_RE, TAG_COMPARE_REVERSED_RE]) {
      for (const hit of literalCalls(code, text, re)) {
        if (!hit.value || knownTags.includes(hit.value)) continue;
        push(
          hit,
          'UNITY0301',
          `Tag '${hit.value}' is not defined in Tags & Layers.${near(knownTags, hit.value)}`,
        );
      }
    }

    // ── layers ──────────────────────────────────────────────────
    const namedLayers = settings.layers.filter((l) => l.trim() !== '');
    if (namedLayers.length > 0) {
      for (const hit of literalCalls(code, text, LAYER_RE)) {
        if (!hit.value || namedLayers.includes(hit.value)) continue;
        push(
          hit,
          'UNITY0302',
          `Layer '${hit.value}' is not defined in Tags & Layers — 'LayerMask.NameToLayer' returns -1 for an unknown name.${near(namedLayers, hit.value)}`,
        );
      }
    }

    // ── scenes ──────────────────────────────────────────────────
    if (settings.scenes.length > 0) {
      const enabled = settings.scenes.filter((s) => s.enabled);
      const shortName = (p: string) =>
        (p.split('/').pop() ?? p).replace(/\.unity$/, '');
      const allNames = settings.scenes.map((s) => shortName(s.path));
      const enabledNames = enabled.map((s) => shortName(s.path));

      for (const hit of literalCalls(code, text, SCENE_RE)) {
        if (!hit.value) continue;
        // A path form is matched against the full path, a bare name against
        // the stem — both are legal arguments to LoadScene.
        const isPath = hit.value.includes('/');
        const known = isPath
          ? settings.scenes.some((s) => s.path === hit.value)
          : allNames.includes(hit.value);
        if (!known) {
          push(
            hit,
            'UNITY0303',
            `Scene '${hit.value}' is not in the build settings — 'LoadScene' will throw at runtime.${near(allNames, hit.value)}`,
          );
          continue;
        }
        const isEnabled = isPath
          ? enabled.some((s) => s.path === hit.value)
          : enabledNames.includes(hit.value);
        if (!isEnabled) {
          push(
            hit,
            'UNITY0304',
            `Scene '${hit.value}' is in the build settings but disabled, so it is excluded from builds and cannot be loaded.`,
          );
        }
      }
    }

    // ── input axes ──────────────────────────────────────────────
    if (settings.inputAxes.length > 0) {
      for (const hit of literalCalls(code, text, INPUT_RE)) {
        if (!hit.value || settings.inputAxes.includes(hit.value)) continue;
        push(
          hit,
          'UNITY0305',
          `'${hit.value}' is not defined in the Input Manager — this throws ArgumentException at runtime.${near(settings.inputAxes, hit.value)}`,
        );
      }
    }

    // ── Resources paths ─────────────────────────────────────────
    // Only flagged when the literal is obviously wrong (a leading slash or an
    // extension). Verifying the path really exists needs the asset index, so a
    // plain unknown path is deliberately NOT reported — a false "resource does
    // not exist" on a valid Resources folder would be worse than silence.
    for (const hit of literalCalls(code, text, RESOURCES_RE)) {
      if (!hit.value) continue;
      if (hit.value.startsWith('/')) {
        push(
          hit,
          'UNITY0306',
          `Resources paths are relative to a Resources folder and must not start with '/'.`,
        );
      } else if (/\.(png|jpg|prefab|asset|mat|anim|controller|wav|mp3|txt)$/i.test(hit.value)) {
        push(
          hit,
          'UNITY0306',
          `Resources paths must not include a file extension — 'Resources.Load' expects '${hit.value.replace(/\.[^.]+$/, '')}'.`,
        );
      }
    }

    return findings;
  },
};
