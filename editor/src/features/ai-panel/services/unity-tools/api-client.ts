// Client for the server-side version-accurate Unity API grounding
// (arcane-server routes/unity-api.ts). Two surfaces:
//   - unityApiSearch:  semantic search over the whole ScriptReference + Manual
//                      + API surface (Vectorize), for "how do I…" / discovery.
//   - unityApiLookup:  deterministic exact signature/overload lookup (D1), for
//                      the de-hallucinator and the compile-gate's CS-code repair.
//
// Unity version + render pipeline + input system are derived automatically from
// the detected project facts — callers never pass them. Best-effort: any failure
// (offline, signed out, version not ingested) returns [] so callers degrade.

import { useAuthStore } from '../../../../stores/auth';
import { unityMajorMinor } from '../../../../data/unity-docs-index';
import { getUnityGroundingContext } from '../prompts/unity-facts';

// Same host as the AI chat path (see arcane-stream.ts / graphify-enrich.ts).
const ARCANE_SERVER_URL = 'https://api.arcaneai.org';

export interface ApiSignature {
  namespace?: string;
  type: string;
  member: string;
  kind: string;
  signature: string;
  overloads?: string[];
  assembly?: string;
  deprecated?: boolean;
  obsoleteMessage?: string;
  docUrl?: string;
}

export interface ApiSearchHit {
  score?: number;
  docType?: string;
  type?: string;
  member?: string;
  namespace?: string;
  breadcrumb?: string;
  title?: string;
  url?: string;
  deprecated?: boolean;
  text?: string;
  signature?: string; // present on d1-fallback rows
}

function resolvedVersion(): string | null {
  const { unityVersion } = getUnityGroundingContext();
  if (!unityVersion) return null;
  return unityMajorMinor(unityVersion) ?? unityVersion;
}

async function postJson<T>(path: string, body: unknown): Promise<T | null> {
  const token = useAuthStore.getState().token;
  if (!token) return null;
  try {
    const res = await fetch(`${ARCANE_SERVER_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function unityApiSearch(
  query: string,
  opts?: { docType?: 'scriptref' | 'manual' | 'api' | 'all'; topK?: number },
): Promise<ApiSearchHit[]> {
  const version = resolvedVersion();
  if (!version) return [];
  const { renderPipeline, inputSystem } = getUnityGroundingContext();
  const data = await postJson<{ results?: ApiSearchHit[] }>('/v1/unity/api/search', {
    query,
    unityVersion: version,
    renderPipeline,
    inputSystem,
    docType: opts?.docType,
    topK: opts?.topK,
  });
  return data?.results ?? [];
}

export async function unityApiLookup(type: string, member?: string): Promise<ApiSignature[]> {
  const version = resolvedVersion();
  if (!version) return [];
  const data = await postJson<{ signatures?: ApiSignature[] }>('/v1/unity/api/lookup', {
    unityVersion: version,
    type,
    member,
  });
  return data?.signatures ?? [];
}

/** Deprecated APIs (with obsolete/replacement hints) for the project's version. */
export async function unityDeprecatedApis(limit = 500): Promise<ApiSignature[]> {
  const version = resolvedVersion();
  if (!version) return [];
  const data = await postJson<{ deprecated?: ApiSignature[] }>('/v1/unity/api/deprecated', {
    unityVersion: version,
    limit,
  });
  return data?.deprecated ?? [];
}
