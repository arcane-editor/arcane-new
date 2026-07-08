/**
 * `api-recordings.ts` implements the eval's offline stand-in for
 * `unity-tools/api-client.ts`'s `UnityApiClient` — replay reads committed
 * fixtures under `fixtures/api-recordings/<fixture>/<hash>.json`; record
 * hits the real arcane-server and writes those fixtures. No test here talks
 * to a live server: the "record" tests stub `globalThis.fetch`, same
 * pattern as `eval-stream.test.ts`.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRecordingApiClient,
  createReplayApiClient,
  lookupRequestKey,
  searchRequestKey,
  type GroundingFixtureCtx,
} from './api-recordings';

const ctx: GroundingFixtureCtx = {
  fixture: 'builtin-legacy',
  unityVersion: '2022.3.45f1',
  renderPipeline: 'Built-in',
  inputSystem: 'Legacy',
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'unity-eval-recordings-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('searchRequestKey / lookupRequestKey — normalization determinism', () => {
  it('hashes case/whitespace-equivalent queries to the same key', () => {
    const a = searchRequestKey('apply force at a point', ctx);
    const b = searchRequestKey('  Apply   Force   At A Point  ', ctx);
    expect(a).toBe(b);
  });

  it('hashes distinct queries to different keys', () => {
    const a = searchRequestKey('apply force', ctx);
    const b = searchRequestKey('raycast from camera', ctx);
    expect(a).not.toBe(b);
  });

  it('is sensitive to grounding context (different Unity version → different key)', () => {
    const a = searchRequestKey('apply force', ctx);
    const b = searchRequestKey('apply force', { ...ctx, unityVersion: '6000.0.23f1' });
    expect(a).not.toBe(b);
  });

  it('hashes type+member lookups the same way regardless of surrounding whitespace', () => {
    const a = lookupRequestKey('Rigidbody', 'AddForce', ctx);
    const b = lookupRequestKey(' Rigidbody ', ' AddForce ', ctx);
    expect(a).toBe(b);
  });

  it('treats an absent member distinctly from an empty one', () => {
    const a = lookupRequestKey('Rigidbody', undefined, ctx);
    const b = lookupRequestKey('Rigidbody', '', ctx);
    expect(a).not.toBe(b);
  });
});

describe('createReplayApiClient', () => {
  it('returns the recorded data on a cache hit (differently-cased/whitespaced query)', async () => {
    await withTempDir(async (dir) => {
      const key = searchRequestKey('apply force at a point', ctx);
      const fixtureDir = join(dir, ctx.fixture);
      await mkdir(fixtureDir, { recursive: true });
      await writeFile(
        join(fixtureDir, `${key}.json`),
        JSON.stringify({
          recordedAt: '2026-01-01T00:00:00.000Z',
          request: { endpoint: 'search', query: 'apply force at a point', unityVersion: ctx.unityVersion },
          response: { ok: true, data: [{ breadcrumb: 'Rigidbody.AddForce' }] },
        }),
      );

      const client = createReplayApiClient(dir, ctx);
      const result = await client.search('  Apply   Force At A Point  ');
      expect(result).toEqual({ ok: true, data: [{ breadcrumb: 'Rigidbody.AddForce' }] });
      expect(client.misses).toBe(0);
    });
  });

  it('returns { ok: false, reason: "offline" } and increments misses on a cache miss', async () => {
    await withTempDir(async (dir) => {
      const client = createReplayApiClient(dir, ctx);
      const result = await client.search('a query never recorded');
      expect(result).toEqual({ ok: false, reason: 'offline' });
      expect(client.misses).toBe(1);

      const second = await client.lookup('Nonexistent', 'Member');
      expect(second).toEqual({ ok: false, reason: 'offline' });
      expect(client.misses).toBe(2);
    });
  });

  it('replays a recorded lookup hit', async () => {
    await withTempDir(async (dir) => {
      const key = lookupRequestKey('Rigidbody', 'AddForce', ctx);
      const fixtureDir = join(dir, ctx.fixture);
      await mkdir(fixtureDir, { recursive: true });
      await writeFile(
        join(fixtureDir, `${key}.json`),
        JSON.stringify({
          recordedAt: '2026-01-01T00:00:00.000Z',
          request: { endpoint: 'lookup', type: 'Rigidbody', member: 'AddForce', unityVersion: ctx.unityVersion },
          response: { ok: true, data: [{ type: 'Rigidbody', member: 'AddForce', kind: 'method', signature: 'void AddForce(Vector3 force)' }] },
        }),
      );

      const client = createReplayApiClient(dir, ctx);
      const result = await client.lookup('Rigidbody', 'AddForce');
      expect(result.ok).toBe(true);
      expect(client.misses).toBe(0);
    });
  });

  it('never touches the network on a miss', async () => {
    await withTempDir(async (dir) => {
      globalThis.fetch = (() => {
        throw new Error('replay must never call fetch');
      }) as typeof fetch;
      const client = createReplayApiClient(dir, ctx);
      const result = await client.search('anything');
      expect(result).toEqual({ ok: false, reason: 'offline' });
    });
  });
});

describe('createRecordingApiClient', () => {
  it('performs the live call, writes a recording file, and returns the live result', async () => {
    await withTempDir(async (dir) => {
      let capturedUrl: string | undefined;
      let capturedBody: string | undefined;
      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        capturedUrl = url;
        capturedBody = init?.body as string;
        return new Response(JSON.stringify({ version: '2022.3', results: [{ breadcrumb: 'Rigidbody.AddForce' }] }), {
          status: 200,
        });
      }) as typeof fetch;

      const client = createRecordingApiClient('http://localhost:8787', 'dev-jwt', dir, ctx);
      const result = await client.search('apply force at a point');

      expect(result).toEqual({ ok: true, data: [{ breadcrumb: 'Rigidbody.AddForce' }] });
      expect(capturedUrl).toBe('http://localhost:8787/v1/unity/api/search');
      const body = JSON.parse(capturedBody ?? '{}');
      expect(body.query).toBe('apply force at a point');
      expect(body.unityVersion).toBe(ctx.unityVersion);

      const key = searchRequestKey('apply force at a point', ctx);
      const raw = await readFile(join(dir, ctx.fixture, `${key}.json`), 'utf8');
      const recorded = JSON.parse(raw);
      expect(recorded.response).toEqual({ ok: true, data: [{ breadcrumb: 'Rigidbody.AddForce' }] });
      expect(recorded.request.query).toBe('apply force at a point');
      expect(typeof recorded.recordedAt).toBe('string');
    });
  });

  it('maps a non-2xx response to http-<status> and still records it', async () => {
    await withTempDir(async (dir) => {
      globalThis.fetch = (async () => new Response('server error', { status: 500 })) as typeof fetch;
      const client = createRecordingApiClient('http://localhost:8787', 'dev-jwt', dir, ctx);
      const result = await client.lookup('Rigidbody', 'AddForce');
      expect(result).toEqual({ ok: false, reason: 'http-500' });

      const key = lookupRequestKey('Rigidbody', 'AddForce', ctx);
      const raw = await readFile(join(dir, ctx.fixture, `${key}.json`), 'utf8');
      expect(JSON.parse(raw).response).toEqual({ ok: false, reason: 'http-500' });
    });
  });

  it('maps a network throw to offline', async () => {
    await withTempDir(async (dir) => {
      globalThis.fetch = (async () => {
        throw new Error('network down');
      }) as typeof fetch;
      const client = createRecordingApiClient('http://localhost:8787', 'dev-jwt', dir, ctx);
      const result = await client.search('apply force');
      expect(result).toEqual({ ok: false, reason: 'offline' });
    });
  });

  it('returns signed-out without any network call when no token is supplied', async () => {
    await withTempDir(async (dir) => {
      globalThis.fetch = (() => {
        throw new Error('must not call fetch when signed out');
      }) as typeof fetch;
      const client = createRecordingApiClient('http://localhost:8787', '', dir, ctx);
      const result = await client.search('apply force');
      expect(result).toEqual({ ok: false, reason: 'signed-out' });
    });
  });
});
