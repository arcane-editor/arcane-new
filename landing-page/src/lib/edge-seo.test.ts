import { describe, expect, it, vi } from 'vitest';
import worker from '../../public/_worker.js';

describe('Pages SEO response policy', () => {
  it('redirects www directly, preserving the path and query', async () => {
    const fetch = vi.fn();
    const response = await worker.fetch(new Request('https://www.unityide.app/docs/?utm_source=demo'), { ASSETS: { fetch } });
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('https://unityide.app/docs/?utm_source=demo');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('redirects both download forms in a single hop with a real HTTP status', async () => {
    for (const path of ['/download', '/download/']) {
      const response = await worker.fetch(new Request(`https://www.unityide.app${path}?utm_source=demo`), { ASSETS: { fetch: vi.fn() } });
      expect(response.status).toBe(301);
      expect(response.headers.get('location')).toBe('https://unityide.app/?utm_source=demo#download');
    }
  });
  it('passes public asset status and cache headers through unchanged', async () => {
    const original = new Response('missing', { status: 404, headers: { 'Cache-Control': 'public, max-age=60' } });
    const response = await worker.fetch(new Request('https://unityide.app/not-found/'), { ASSETS: { fetch: async () => original } });
    expect(response).toBe(original);
    expect(response.headers.has('X-Robots-Tag')).toBe(false);
  });
  it('marks every nonpublic host noindex, including preview assets and errors', async () => {
    for (const host of ['dev.unityide.app', 'branch.example.pages.dev', 'example.pages.dev', 'localhost']) {
      const response = await worker.fetch(new Request(`https://${host}/missing.png`), { ASSETS: { fetch: async () => new Response('missing', { status: 404 }) } });
      expect(response.headers.get('X-Robots-Tag')).toBe('noindex');
      expect(response.status).toBe(404);
    }
  });
  it('keeps preview downloads on the preview origin and noindex', async () => {
    const response = await worker.fetch(new Request('https://dev.unityide.app/download/'), { ASSETS: { fetch: vi.fn() } });
    expect(response.headers.get('location')).toBe('https://dev.unityide.app/#download');
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex');
  });
});
