import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool } from '../vendor/types';
import { txt } from './text-result';
import type { ApiSignature, ApiSearchHit } from './api-client';

// Injected dependency — mirrors `unityApiSearch`/`unityApiLookup` from
// `./api-client` exactly, but as an interface so this module never imports
// those (store-backed) value bindings itself. Production wiring lives in
// `unity-tools/index.ts` (the only place in this feature that touches
// stores); everything below is store-free and Bun-safe to import directly.
export interface UnityApiClient {
  search(
    query: string,
    opts?: { docType?: 'scriptref' | 'manual' | 'api' | 'all'; topK?: number },
  ): Promise<ApiSearchHit[]>;
  lookup(type: string, member?: string): Promise<ApiSignature[]>;
}

// Deliberately tiny schema (weak-model friendly): just a free-text query and an
// optional exact "Type.Member". Version / pipeline / input are derived server-
// side from project facts — never asked of the model.
const schema = Type.Object({
  query: Type.String({
    description:
      'What you want to do, or the API you need — e.g. "apply force at a point", "raycast from camera", or "Rigidbody.AddForce".',
  }),
  member: Type.Optional(
    Type.String({
      description:
        'Optional "Type.Member" (e.g. "Rigidbody.AddForce") to fetch the EXACT signature + all overloads instead of a fuzzy search.',
    }),
  ),
});

function splitTypeMember(qualified: string): { type: string; member?: string } {
  const parts = qualified.split('.').filter(Boolean);
  if (parts.length < 2) return { type: parts[0] ?? qualified };
  return { type: parts[parts.length - 2], member: parts[parts.length - 1] };
}

function formatSignatures(sigs: ApiSignature[]): string {
  return sigs
    .map((s) => {
      const head = `• ${s.namespace ? s.namespace + '.' : ''}${s.type}.${s.member} — ${s.signature}`;
      const dep = s.deprecated
        ? `\n  ⚠ DEPRECATED${s.obsoleteMessage ? `: ${s.obsoleteMessage}` : ''}`
        : '';
      const more =
        s.overloads && s.overloads.length > 1
          ? '\n  overloads: ' + s.overloads.slice(0, 8).join(' | ')
          : '';
      const url = s.docUrl ? `\n  ${s.docUrl}` : '';
      return head + dep + more + url;
    })
    .join('\n');
}

function formatHits(hits: ApiSearchHit[]): string {
  return hits
    .map((h) => {
      const label = h.breadcrumb || [h.type, h.member].filter(Boolean).join('.') || h.title || '(doc)';
      const kind = h.docType ? ` [${h.docType}]` : '';
      const sig = h.signature ? ` — ${h.signature}` : '';
      const dep = h.deprecated ? ' ⚠DEPRECATED' : '';
      const snippet = h.text ? `\n  ${h.text.replace(/\s+/g, ' ').slice(0, 200)}` : '';
      const url = h.url ? `\n  ${h.url}` : '';
      return `• ${label}${kind}${dep}${sig}${snippet}${url}`;
    })
    .join('\n');
}

/**
 * unity_api_search — version-accurate Unity API + docs grounding. Semantic
 * search over the whole ScriptReference + Manual (Vectorize) plus exact
 * signature lookup (D1). Read-only / auto-approved.
 */
export function createUnityApiSearchTool(client: UnityApiClient): AgentTool {
  return {
    name: 'unity_api_search',
    label: 'unity api search',
    description:
      "Search the version-accurate Unity API + documentation for THIS project's exact Unity version. " +
      'Use BEFORE writing Unity code you are unsure about, to confirm an API exists and get its real ' +
      'signature/overloads (this prevents hallucinated APIs). Pass `member` as "Type.Member" for an exact lookup.',
    parameters: schema,
    async execute(_id, params) {
      const { query, member } = params as Static<typeof schema>;

      // Exact-signature path when a "Type.Member" is provided.
      const exactTarget = member?.includes('.') ? member : query.includes('.') && !query.includes(' ') ? query : null;
      if (exactTarget) {
        const { type, member: mem } = splitTypeMember(exactTarget);
        const sigs = await client.lookup(type, mem);
        if (sigs.length > 0) {
          return txt(`Exact Unity API signatures:\n${formatSignatures(sigs)}`);
        }
      }

      const hits = await client.search(query, { topK: 8 });
      if (hits.length === 0) {
        return txt(
          `No Unity API matches for "${query}". Either you're signed out, this Unity version's API index ` +
            `isn't ingested yet, or the symbol name is off. Try get_unity_docs, or a different phrasing.`,
        );
      }
      return txt(`Unity API / docs matches (version-accurate):\n${formatHits(hits)}`);
    },
  };
}
