// Version-matched Unity docs lookup (F-5.2 + F-5.5 + F-10 T10.2).
//
// Reuses the existing UNITY_API_LIST (name + ScriptReference URL + category) but
// rebuilds the URL against the project's Unity major.minor so links point at the
// docs for the version actually in use, not "latest". No network on the critical
// path — we only construct the URL string.

import { UNITY_API_LIST, type UnityApiEntry } from './unity-api-list';

const SCRIPT_REF_LATEST = 'https://docs.unity3d.com/ScriptReference';

/** "6000.0.32f1" / "2022.3.10f1" → "6000.0" / "2022.3" (or null). */
export function unityMajorMinor(version: string | null | undefined): string | null {
  const m = version?.match(/^(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}` : null;
}

/** Extract the ScriptReference page slug (e.g. "Rigidbody.AddForce.html") from a latest-docs URL. */
function slugOf(url: string): string | null {
  const i = url.indexOf('/ScriptReference/');
  return i >= 0 ? url.slice(i + '/ScriptReference/'.length) : null;
}

/** Build a version-matched docs URL for a page slug (falls back to latest). */
export function versionedDocUrl(url: string, majorMinor: string | null): string {
  const slug = slugOf(url);
  if (!slug || !majorMinor) return url;
  return `https://docs.unity3d.com/${majorMinor}/Documentation/ScriptReference/${slug}`;
}

export interface DocHit {
  name: string;
  category: string;
  /** Version-matched URL. */
  url: string;
}

/**
 * Look up Unity API symbols by fuzzy name match (exact > startsWith > includes),
 * returning up to `limit` hits with version-matched URLs.
 */
export function lookupUnityDocs(
  symbol: string,
  version: string | null,
  limit = 5,
): DocHit[] {
  const q = symbol.trim().toLowerCase();
  if (!q) return [];
  const mm = unityMajorMinor(version);
  const scored: Array<{ e: UnityApiEntry; score: number }> = [];
  for (const e of UNITY_API_LIST) {
    const n = e.name.toLowerCase();
    let score = -1;
    if (n === q) score = 3;
    else if (n.startsWith(q)) score = 2;
    else if (n.includes(q)) score = 1;
    if (score >= 0) scored.push({ e, score });
  }
  scored.sort((a, b) => b.score - a.score || a.e.name.length - b.e.name.length);
  return scored.slice(0, limit).map(({ e }) => ({
    name: e.name,
    category: e.category,
    url: versionedDocUrl(e.url, mm),
  }));
}

export { SCRIPT_REF_LATEST };
