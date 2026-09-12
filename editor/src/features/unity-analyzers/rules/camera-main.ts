import type { AnalyzerRule, Finding } from '../services/analyzer-engine';
import { updateFamilyBodies, matchesInBody } from '../services/body-analysis';

const CAMERA_MAIN_RE = /\bCamera\s*\.\s*main\b/g;

/**
 * Parse a Unity version string like `2021.3.16f1` or `2019.4` into a
 * {major, minor} pair. Returns null if unparseable.
 */
function parseUnityVersion(v: string | null): { major: number; minor: number } | null {
  if (!v) return null;
  const m = /^(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return null;
  return { major: parseInt(m[1], 10), minor: parseInt(m[2], 10) };
}

/**
 * `Camera.main` is a property getter that, prior to Unity 2020.2, performed a
 * tag-based scene search on every access — costly inside Update. From 2020.2
 * onward Unity caches the result internally, so the warning no longer applies.
 * We therefore GATE the rule on the project's Unity version and skip it for
 * 2020.2 or newer.
 */
function shouldFlag(unityVersion: string | null): boolean {
  const parsed = parseUnityVersion(unityVersion);
  // Unknown version → stay silent.
  //
  // This used to flag, on the theory that warning was the safe default. It is
  // the opposite: Unity has cached `Camera.main` internally since 2020.2, so
  // on any project made in the last five years this advice is simply wrong —
  // and it would be given on every project whose ProjectVersion.txt could not
  // be read. A false warning about correct code costs more than a missed one
  // about a pattern that is no longer slow.
  if (!parsed) return false;
  if (parsed.major > 2020) return false;
  if (parsed.major === 2020 && parsed.minor >= 2) return false;
  return true;
}

export const cameraMainRule: AnalyzerRule = {
  id: 'unity/camera-main-in-update',
  defaultSeverity: 'warning',
  codes: ['UNITY0202'],

  run(scan, ctx): Finding[] {
    if (!shouldFlag(ctx.unityVersion)) return [];

    const findings: Finding[] = [];
    for (const { method, body } of updateFamilyBodies(scan)) {
      for (const m of matchesInBody(scan, body, CAMERA_MAIN_RE)) {
        findings.push({
          ruleId: this.id,
          severity: this.defaultSeverity,
          start: m.index,
          end: m.index + m[0].length,
          code: 'UNITY0202',
          message: `'Camera.main' inside ${method.name}() does a tagged scene search every frame on this Unity version. Cache it in a field once (e.g. in Awake).`,
        });
      }
    }
    return findings;
  },
};
