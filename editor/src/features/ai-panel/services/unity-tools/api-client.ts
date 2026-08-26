// Client for the server-side version-accurate Unity API grounding
// (arcane-server routes/unity-api.ts). Two surfaces:
//   - unityApiSearch:  semantic search over the whole ScriptReference + Manual
//                      + API surface (Vectorize), for "how do I…" / discovery.
//   - unityApiLookup:  deterministic exact signature/overload lookup (D1), for
//                      the de-hallucinator and the compile-gate's CS-code repair.
//
// Unity version + render pipeline + input system are derived automatically from
// the detected project facts — callers never pass them. `unityApiSearch` and
// `unityApiLookup` surface WHY grounding is unavailable (signed out, version
// not ingested, offline, HTTP error) via `GroundingResult` instead of silently
// returning [] — a successful call that simply finds nothing is still `ok: true`.

import { useAuthStore } from '../../../../stores/auth';
import { postJsonWithTimeout } from './post-json';
import { unityMajorMinor } from '../../../../data/unity-docs-index';
import { getUnityGroundingContext } from '../prompts/unity-facts';
import { API_URL } from '../../../../config/api';

// Same host as the AI chat path (see hosted-stream.ts / graphify-enrich.ts).
const HOSTED_SERVER_URL = API_URL;

/**
 * Discriminated result for the two version-accurate grounding calls
 * (`unityApiSearch`, `unityApiLookup`). Unavailability is explicit so callers
 * (the tool layer) can tell "grounding is down" apart from "found nothing" —
 * the latter is `{ ok: true, data: [] }`, never a failure.
 *
 * This is the contract the eval replay client (next task) implements too.
 */
export type GroundingResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: 'signed-out' | 'no-unity-version' | 'offline' | `http-${number}` };

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

async function postJson<T>(path: string, body: unknown): Promise<GroundingResult<T>> {
  const token = useAuthStore.getState().token;
  if (!token) return { ok: false, reason: 'signed-out' };
  // Bounded (10s) — see post-json.ts. These calls run inside the agent's tool
  // loop; an unbounded fetch here once froze the whole agent mid-turn.
  const result = await postJsonWithTimeout(`${HOSTED_SERVER_URL}${path}`, token, body);
  if (!result.ok) return result;
  return { ok: true, data: result.json as T };
}

export async function unityApiSearch(
  query: string,
  opts?: { docType?: 'scriptref' | 'manual' | 'api' | 'all'; topK?: number },
): Promise<GroundingResult<ApiSearchHit[]>> {
  const version = resolvedVersion();
  if (!version) return { ok: false, reason: 'no-unity-version' };
  const { renderPipeline, inputSystem } = getUnityGroundingContext();
  const result = await postJson<{ results?: ApiSearchHit[] }>('/v1/unity/api/search', {
    query,
    unityVersion: version,
    renderPipeline,
    inputSystem,
    docType: opts?.docType,
    topK: opts?.topK,
  });
  if (!result.ok) return result;
  return { ok: true, data: result.data.results ?? [] };
}

export async function unityApiLookup(type: string, member?: string): Promise<GroundingResult<ApiSignature[]>> {
  const version = resolvedVersion();
  if (!version) return { ok: false, reason: 'no-unity-version' };
  const result = await postJson<{ signatures?: ApiSignature[] }>('/v1/unity/api/lookup', {
    unityVersion: version,
    type,
    member,
  });
  if (!result.ok) return result;
  return { ok: true, data: result.data.signatures ?? [] };
}

/**
 * Deprecated APIs (with obsolete/replacement hints) for the project's version.
 * Only consumed by `migration-tool.ts`'s "version-upgrade" plan, which already
 * degrades gracefully on an empty list — kept as a plain array (not part of
 * the `GroundingResult` contract) since that call site has no reason-specific
 * handling to do.
 */
export async function unityDeprecatedApis(limit = 500): Promise<ApiSignature[]> {
  const version = resolvedVersion();
  if (!version) return [];
  const result = await postJson<{ deprecated?: ApiSignature[] }>('/v1/unity/api/deprecated', {
    unityVersion: version,
    limit,
  });
  if (!result.ok) return [];
  return result.data.deprecated ?? [];
}
