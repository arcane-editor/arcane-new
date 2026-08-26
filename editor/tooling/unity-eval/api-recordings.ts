/**
 * Offline record/replay implementation of `UnityApiClient`
 * (`ai-panel/services/unity-tools/api-search-tool.ts`) for the eval harness.
 *
 * Production's `unity_api_search` tool hits `api.unityide.app` with a signed-
 * in user's JWT — the eval must run offline, deterministic, and CI-safe.
 * Instead, the eval reads/writes committed JSON recordings:
 *
 *   fixtures/api-recordings/<fixture-name>/<hash>.json
 *
 * `<fixture-name>` is the eval task's fixture (`builtin-legacy` /
 * `urp-newinput`); `<hash>` is a sha256 of the *normalized* request — see
 * `searchRequestKey` / `lookupRequestKey`. Query text is trimmed, lowercased,
 * and has internal whitespace collapsed before hashing, so trivially
 * different phrasing/casing across runs (or across models) still hits the
 * same recording.
 *
 * `createReplayApiClient` (the default, used by every eval run) NEVER
 * touches the network: a cache miss logs one warning line to stderr and
 * returns `{ ok: false, reason: 'offline' }`, exactly the shape the real
 * `unity_api_search` tool already knows how to render
 * ("[Unity grounding UNAVAILABLE: offline] ...") — see `api-search-tool.ts`.
 *
 * `createRecordingApiClient` is the `--record` mode's client (`run-eval.ts`):
 * it performs the real HTTP call against a local `wrangler dev` arcane-server
 * (mirroring `api-client.ts`'s request/response handling exactly) and writes
 * the live result to the recording file before returning it — so a
 * `--record` run is always live AND capturing.
 *
 * Known limitation: replay hits depend on models repeating normalized query
 * text close enough to a previously-recorded one. New models/prompts *will*
 * produce misses — that's visible via the stderr warning and the
 * `groundingCacheMisses` counter surfaced in the run's TaskResult / results
 * JSON (see `run-task.ts` / `run-eval.ts`), not a silent failure. Re-record
 * via `--record` is cheap (see README's "Grounding recordings" section).
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { UnityApiClient } from '../../src/features/ai-panel/services/unity-tools/api-search-tool';
import type {
  ApiSearchHit,
  ApiSignature,
  GroundingResult,
} from '../../src/features/ai-panel/services/unity-tools/api-client';

/**
 * Grounding context for one fixture — the eval-harness equivalent of
 * production's `getUnityGroundingContext()` (`prompts/unity-facts.ts`),
 * derived from the fixture's Unity project files instead of a live store
 * (see `buildFixtureGroundingContext` in `fixture-facts.ts`). `fixture` is
 * the eval task's fixture name and doubles as the recordings subdirectory.
 */
export interface GroundingFixtureCtx {
  fixture: string;
  unityVersion: string;
  renderPipeline?: string;
  inputSystem?: string;
}

type NormalizedRequest =
  | {
      endpoint: 'search';
      query: string;
      unityVersion: string;
      renderPipeline?: string;
      inputSystem?: string;
    }
  | {
      endpoint: 'lookup';
      type: string;
      member?: string;
      unityVersion: string;
      renderPipeline?: string;
      inputSystem?: string;
    };

interface RecordingFile {
  recordedAt: string;
  request: NormalizedRequest;
  response: GroundingResult<unknown>;
}

/** Trim, lowercase, collapse internal whitespace — maximizes replay hits across runs/models. */
function normalizeQueryText(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeSearchRequest(query: string, ctx: GroundingFixtureCtx): NormalizedRequest {
  return {
    endpoint: 'search',
    query: normalizeQueryText(query),
    unityVersion: ctx.unityVersion,
    renderPipeline: ctx.renderPipeline,
    inputSystem: ctx.inputSystem,
  };
}

function normalizeLookupRequest(
  type: string,
  member: string | undefined,
  ctx: GroundingFixtureCtx,
): NormalizedRequest {
  return {
    endpoint: 'lookup',
    type: type.trim(),
    member: member?.trim(),
    unityVersion: ctx.unityVersion,
    renderPipeline: ctx.renderPipeline,
    inputSystem: ctx.inputSystem,
  };
}

/** Stable across key order because `NormalizedRequest` object literals are always built in this same field order. */
function hashRequest(req: NormalizedRequest): string {
  return createHash('sha256').update(JSON.stringify(req)).digest('hex');
}

/** Cache key for a `search()` call — same key for whitespace/case-variant phrasings of the same query. */
export function searchRequestKey(query: string, ctx: GroundingFixtureCtx): string {
  return hashRequest(normalizeSearchRequest(query, ctx));
}

/** Cache key for a `lookup()` call. */
export function lookupRequestKey(type: string, member: string | undefined, ctx: GroundingFixtureCtx): string {
  return hashRequest(normalizeLookupRequest(type, member, ctx));
}

function recordingFilePath(recordingsDir: string, fixture: string, key: string): string {
  return join(recordingsDir, fixture, `${key}.json`);
}

/**
 * Default eval client: reads committed recordings, never touches the
 * network. `misses` (a live getter, not a snapshot) lets callers surface
 * `groundingCacheMisses` after a task run.
 */
export function createReplayApiClient(
  recordingsDir: string,
  ctx: GroundingFixtureCtx,
): UnityApiClient & { misses: number } {
  let misses = 0;

  async function replay<T>(req: NormalizedRequest, key: string, label: string): Promise<GroundingResult<T>> {
    const path = recordingFilePath(recordingsDir, ctx.fixture, key);
    try {
      const raw = await readFile(path, 'utf8');
      const file = JSON.parse(raw) as RecordingFile;
      return file.response as GroundingResult<T>;
    } catch {
      misses++;
      console.error(
        `[unity-eval] grounding cache MISS: ${req.endpoint} "${label}" (fixture=${ctx.fixture}) — ` +
          `no recording at ${path}`,
      );
      return { ok: false, reason: 'offline' };
    }
  }

  return {
    search(query) {
      const req = normalizeSearchRequest(query, ctx);
      return replay<ApiSearchHit[]>(req, searchRequestKey(query, ctx), req.query);
    },
    lookup(type, member) {
      const req = normalizeLookupRequest(type, member, ctx);
      const label = req.member ? `${req.type}.${req.member}` : req.type;
      return replay<ApiSignature[]>(req, lookupRequestKey(type, member, ctx), label);
    },
    get misses() {
      return misses;
    },
  };
}

/**
 * `--record` mode's client: mirrors `api-client.ts`'s request bodies and
 * response parsing exactly (same endpoints, same fallback fields), performs
 * the live HTTP call against `serverUrl`, and writes the resulting
 * `GroundingResult` (success or failure) to the recording file before
 * returning it — so re-recording captures whatever the server actually said,
 * good or bad, for human review. Exposes `recordFailures` counter for callers
 * to surface in results — see `run-task.ts`.
 */
export function createRecordingApiClient(
  serverUrl: string,
  token: string,
  recordingsDir: string,
  ctx: GroundingFixtureCtx,
): UnityApiClient & { recordFailures: number } {
  let recordFailures = 0;

  async function postJson<T>(path: string, body: unknown): Promise<GroundingResult<T>> {
    if (!token) return { ok: false, reason: 'signed-out' };
    try {
      const res = await fetch(`${serverUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) return { ok: false, reason: `http-${res.status}` };
      return { ok: true, data: (await res.json()) as T };
    } catch {
      return { ok: false, reason: 'offline' };
    }
  }

  async function recordAndReturn<T>(req: NormalizedRequest, key: string, result: GroundingResult<T>) {
    const path = recordingFilePath(recordingsDir, ctx.fixture, key);
    if (!result.ok) {
      recordFailures++;
      const label = req.endpoint === 'search' ? `"${req.query}"` : req.member ? `${req.type}.${req.member}` : req.type;
      console.error(
        `[unity-eval] grounding record FAILURE: ${req.endpoint} ${label} (fixture=${ctx.fixture}) — ` +
          `reason=${result.reason} recording to ${path}`,
      );
    }
    await mkdir(dirname(path), { recursive: true });
    const file: RecordingFile = { recordedAt: new Date().toISOString(), request: req, response: result };
    await writeFile(path, JSON.stringify(file, null, 2) + '\n');
    return result;
  }

  return {
    async search(query, opts) {
      const req = normalizeSearchRequest(query, ctx);
      const result = await postJson<{ results?: ApiSearchHit[] }>('/v1/unity/api/search', {
        query,
        unityVersion: ctx.unityVersion,
        renderPipeline: ctx.renderPipeline,
        inputSystem: ctx.inputSystem,
        docType: opts?.docType,
        topK: opts?.topK,
      });
      const mapped: GroundingResult<ApiSearchHit[]> = result.ok
        ? { ok: true, data: result.data.results ?? [] }
        : result;
      return recordAndReturn(req, searchRequestKey(query, ctx), mapped);
    },
    async lookup(type, member) {
      const req = normalizeLookupRequest(type, member, ctx);
      const result = await postJson<{ signatures?: ApiSignature[] }>('/v1/unity/api/lookup', {
        unityVersion: ctx.unityVersion,
        type,
        member,
      });
      const mapped: GroundingResult<ApiSignature[]> = result.ok
        ? { ok: true, data: result.data.signatures ?? [] }
        : result;
      return recordAndReturn(req, lookupRequestKey(type, member, ctx), mapped);
    },
    get recordFailures() {
      return recordFailures;
    },
  };
}
