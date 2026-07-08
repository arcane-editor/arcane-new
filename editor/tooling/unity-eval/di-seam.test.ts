/**
 * Regression guard for the Bun-safety hazard documented in `checks.ts:1-61`:
 * the production Unity grounding tools (`unity_api_search`, `get_unity_docs`)
 * used to import store-backed value bindings (Zustand → `initMonaco` →
 * `monaco-editor`), which dies at module scope under Bun. `api-search-tool.ts`
 * and `docs-tool.ts` now take their store-backed dependencies as injected
 * parameters instead of importing them, so they can be constructed directly
 * here — bypassing the `unity-tools` barrel (`index.ts`), which still wires
 * the real stores for production and is NOT expected to be Bun-safe.
 *
 * If this file's imports ever start crashing again, something reintroduced a
 * module-scope store (or Monaco) import into one of these two files.
 */

import { describe, it, expect } from 'bun:test';
import {
  createUnityApiSearchTool,
  type UnityApiClient,
} from '../../src/features/ai-panel/services/unity-tools/api-search-tool';
import { createGetUnityDocsTool } from '../../src/features/ai-panel/services/unity-tools/docs-tool';
import type { ApiSearchHit, ApiSignature } from '../../src/features/ai-panel/services/unity-tools/api-client';

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((c) => c.text ?? '').join('\n');
}

describe('DI seam — unity_api_search', () => {
  it('formats hits from an injected fake client', async () => {
    const hits: ApiSearchHit[] = [
      {
        breadcrumb: 'Rigidbody.AddForce',
        signature: 'void AddForce(Vector3 force, ForceMode mode = ForceMode.Force)',
        docType: 'api',
        url: 'https://docs.unity3d.com/6000.0/Documentation/ScriptReference/Rigidbody.AddForce.html',
      },
    ];
    const fakeClient: UnityApiClient = {
      search: async (query) => {
        expect(query).toBe('apply force at a point');
        return hits;
      },
      lookup: async () => [],
    };

    const tool = createUnityApiSearchTool(fakeClient);
    expect(tool.name).toBe('unity_api_search');

    const result = await tool.execute('call-1', { query: 'apply force at a point' });
    const text = textOf(result);
    expect(text).toContain('Rigidbody.AddForce');
    expect(text).toContain('void AddForce');
  });

  it('takes the exact-lookup path when member is "Type.Member"', async () => {
    const sigs: ApiSignature[] = [
      { type: 'Rigidbody', member: 'AddForce', kind: 'method', signature: 'void AddForce(Vector3 force)' },
    ];
    const fakeClient: UnityApiClient = {
      search: async () => {
        throw new Error('should not fall back to search when lookup finds a signature');
      },
      lookup: async (type, member) => {
        expect(type).toBe('Rigidbody');
        expect(member).toBe('AddForce');
        return sigs;
      },
    };

    const tool = createUnityApiSearchTool(fakeClient);
    const result = await tool.execute('call-2', { query: 'Rigidbody.AddForce', member: 'Rigidbody.AddForce' });
    expect(textOf(result)).toContain('Exact Unity API signatures');
  });
});

describe('DI seam — get_unity_docs', () => {
  it('reports the version supplied by the injected getter', async () => {
    const tool = createGetUnityDocsTool(() => '2022.3.45f1');
    expect(tool.name).toBe('get_unity_docs');

    const result = await tool.execute('call-3', { symbol: 'Rigidbody.AddForce' });
    const text = textOf(result);
    expect(text).toContain('Unity 2022.3');
  });

  it('falls back to "version unknown" when the getter returns null', async () => {
    const tool = createGetUnityDocsTool(() => null);
    const result = await tool.execute('call-4', { symbol: 'Rigidbody.AddForce' });
    expect(textOf(result)).toContain('version unknown');
  });
});
