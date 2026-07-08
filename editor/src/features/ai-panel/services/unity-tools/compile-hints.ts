// De-hallucinator — pure, Bun-safe. Turns REAL compiler errors (CS1061/CS0117
// missing member, CS0246 missing type, CS1501 wrong overload arity) into
// inlined ground-truth signatures, so the compile-repair loop self-corrects
// without another tool round-trip.
//
// Extracted from compile-gate.ts (which imports api-client.ts → stores, and
// therefore can't be exercised under Bun) so this logic is directly testable.
// Store-backed lookups are injected via `HintLookup` — mirrors the
// `UnityApiClient` shape from `api-search-tool.ts` exactly (same P1.1 DI seam:
// only type-only imports here, no value imports of api-client.ts), so the same
// `{ search: unityApiSearch, lookup: unityApiLookup }` object wired in the
// unity-tools barrel (`index.ts`) satisfies both.
//
// Best-effort throughout: never throws, never surfaces WHY grounding was
// unavailable (unlike `unity_api_search`) — an un-hinted compiler error is
// still a real, actionable error on its own.

import type { CompilerMessage } from '../../../../types/unity';
import type { GroundingResult, ApiSignature, ApiSearchHit } from './api-client';

/** Injected surface — matches `UnityApiClient` (api-search-tool.ts) structurally. */
export interface HintLookup {
  lookup(type: string, member?: string): Promise<GroundingResult<ApiSignature[]>>;
  search(
    query: string,
    opts?: { docType?: 'scriptref' | 'manual' | 'api' | 'all'; topK?: number },
  ): Promise<GroundingResult<ApiSearchHit[]>>;
}

const MAX_MEMBER_TYPES = 3; // CS1061/CS0117 distinct types hinted per batch
const MAX_MEMBERS_PER_TYPE = 32; // member names listed per hinted type
const MAX_MISSING_TYPES = 3; // CS0246 distinct missing types hinted per batch
const MAX_OVERLOAD_LOOKUPS = 3; // CS1501 distinct method lookups per batch
const MAX_OVERLOADS = 8; // overload signatures listed per method (existing cap)
const MIN_DIDYOUMEAN_SCORE = 0.5; // sanity floor for the CS0246 fuzzy fallback

/** Strip namespace + generics from a type reference → simple name. */
function simpleTypeName(t: string): string {
  let s = t.split('<')[0] ?? t;
  const dot = s.lastIndexOf('.');
  if (dot >= 0) s = s.slice(dot + 1);
  return s.trim();
}

/** Extract (type, missing-member) from a CS1061 / CS0117 "no definition" error. */
export function extractMissingMember(message: string): { type: string; member: string } | null {
  if (!/CS1061|CS0117/.test(message)) return null;
  const m = message.match(/'([^']+)' does not contain a definition for '([^']+)'/);
  if (!m || !m[1] || !m[2]) return null;
  return { type: simpleTypeName(m[1]), member: m[2] };
}

/** Extract the unresolved type/namespace name from a CS0246 error. */
export function extractMissingType(message: string): string | null {
  if (!/CS0246/.test(message)) return null;
  const m = message.match(/The type or namespace name '([^']+)' could not be found/);
  if (!m || !m[1]) return null;
  return simpleTypeName(m[1]);
}

/** Extract the method name from a CS1501 "no overload takes N arguments" error. */
export function extractBadOverload(message: string): { method: string } | null {
  if (!/CS1501/.test(message)) return null;
  const m = message.match(/No overload for method '([^']+)' takes \d+ argument/);
  if (!m || !m[1]) return null;
  return { method: m[1] };
}

/** Split a qualified `Ns.Type.Member` (or `Type.Member`) into its last two segments. */
function splitQualified(qualified: string): { type: string; member: string } | null {
  const parts = qualified.split('.').filter(Boolean);
  if (parts.length < 2) return null;
  const type = parts[parts.length - 2];
  const member = parts[parts.length - 1];
  if (!type || !member) return null;
  return { type, member };
}

/** All distinct types identifiable from CS1061/CS0117/CS0246 errors anywhere in the batch. */
function identifiedTypesInBatch(errors: CompilerMessage[]): Set<string> {
  const types = new Set<string>();
  for (const e of errors) {
    const mm = extractMissingMember(e.message);
    if (mm) types.add(mm.type);
    const mt = extractMissingType(e.message);
    if (mt) types.add(mt);
  }
  return types;
}

async function memberHints(errors: CompilerMessage[], client: HintLookup): Promise<string[]> {
  const types: string[] = [];
  const seen = new Set<string>();
  for (const e of errors) {
    const hit = extractMissingMember(e.message);
    if (hit && !seen.has(hit.type)) {
      seen.add(hit.type);
      types.push(hit.type);
      if (types.length >= MAX_MEMBER_TYPES) break;
    }
  }

  const blocks: string[] = [];
  for (const type of types) {
    try {
      const result = await client.lookup(type);
      // Grounding unavailable (signed out / no version / offline / HTTP error) —
      // hints here are best-effort, so skip silently rather than surface the reason.
      if (!result.ok) continue;
      if (result.data.length === 0) continue;
      const members = [...new Set(result.data.map((s) => s.member))].slice(0, MAX_MEMBERS_PER_TYPE);
      if (members.length) blocks.push(`Real members of ${type}: ${members.join(', ')}`);
    } catch {
      /* best-effort */
    }
  }
  return blocks;
}

async function missingTypeHints(errors: CompilerMessage[], client: HintLookup): Promise<string[]> {
  const types: string[] = [];
  const seen = new Set<string>();
  for (const e of errors) {
    const type = extractMissingType(e.message);
    if (type && !seen.has(type)) {
      seen.add(type);
      types.push(type);
      if (types.length >= MAX_MISSING_TYPES) break;
    }
  }

  const blocks: string[] = [];
  for (const type of types) {
    try {
      const result = await client.lookup(type);
      if (result.ok && result.data.length > 0) {
        const ns = result.data.find((s) => s.namespace)?.namespace;
        if (ns) {
          const docUrl = result.data.find((s) => s.docUrl)?.docUrl;
          blocks.push(`${type} found in namespace ${ns} — add \`using ${ns};\`${docUrl ? ` (${docUrl})` : ''}`);
        }
        continue;
      }

      // Empty or failed lookup — try ONE fuzzy search before giving up.
      const searchResult = await client.search(type);
      if (!searchResult.ok || searchResult.data.length === 0) continue;
      const top = searchResult.data[0];
      if (!top) continue;
      if (typeof top.score === 'number' && top.score < MIN_DIDYOUMEAN_SCORE) continue;
      const label = top.breadcrumb || [top.type, top.member].filter(Boolean).join('.') || top.title;
      if (label) blocks.push(`${type} not found — did you mean "${label}"?`);
    } catch {
      /* best-effort */
    }
  }
  return blocks;
}

async function overloadHints(errors: CompilerMessage[], client: HintLookup): Promise<string[]> {
  const batchTypes = identifiedTypesInBatch(errors);
  const targets: { type: string; method: string }[] = [];
  const seen = new Set<string>();

  for (const e of errors) {
    const bad = extractBadOverload(e.message);
    if (!bad) continue;

    // (b) the method name itself is qualified — highest-confidence receiver.
    const qualified = splitQualified(bad.method);
    // (a) otherwise, only a SINGLE unambiguous type elsewhere in the batch counts —
    // more than one candidate (or none) means the receiver isn't identifiable, and
    // we never guess.
    const type = qualified?.type ?? (batchTypes.size === 1 ? [...batchTypes][0] : null);
    const method = qualified?.member ?? bad.method;
    if (!type) continue;

    const key = `${type}.${method}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ type, method });
    if (targets.length >= MAX_OVERLOAD_LOOKUPS) break;
  }

  const blocks: string[] = [];
  for (const { type, method } of targets) {
    try {
      const result = await client.lookup(type, method);
      if (!result.ok || result.data.length === 0) continue;
      const overloads = new Set<string>();
      for (const s of result.data) {
        overloads.add(s.signature);
        for (const o of s.overloads ?? []) overloads.add(o);
      }
      const list = [...overloads].slice(0, MAX_OVERLOADS);
      if (list.length) blocks.push(`${type}.${method} overloads: ${list.join(' | ')}`);
    } catch {
      /* best-effort */
    }
  }
  return blocks;
}

/**
 * De-hallucinator: when the compiler reports a missing member (CS1061/CS0117),
 * an unresolved type (CS0246), or a bad overload call (CS1501), fetch the REAL
 * API from the version-accurate index and inline it, so the weak model
 * corrects to a real signature without another tool round-trip.
 * Best-effort — never throws, capped so a compile-repair loop can't runaway.
 */
export async function buildCompileHints(errors: CompilerMessage[], client: HintLookup): Promise<string> {
  const blocks: string[] = [
    ...(await memberHints(errors, client)),
    ...(await missingTypeHints(errors, client)),
    ...(await overloadHints(errors, client)),
  ];
  return blocks.length ? `\n[Unity API] ${blocks.join('\n')}` : '';
}
