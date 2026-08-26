import { describe, it, expect } from 'bun:test';
import { computeAllowedRoots, computeExternalAgentWriteRoots } from './sandbox-roots';

describe('computeAllowedRoots', () => {
  it('Unity: Assets first (bash cwd), then .unityide, the legacy dir, then Packages', () => {
    expect(computeAllowedRoots('/p', true, '/p/Assets')).toEqual([
      '/p/Assets',
      '/p/.unityide',
      '/p/.arcane',
      '/p/Packages',
    ]);
  });

  /**
   * `.arcane/` is `.unityide/`'s pre-rename name, and it lives in the user's
   * Unity project rather than in our config dir — so the rename does not touch
   * it and plans written before the rename are still sitting there. A session
   * carried across by the config migration still points `activePlanPath` at
   * one. Drop this root and resuming any such plan is refused by the sandbox.
   */
  it('still allows the pre-rename workspace dir, so old plans stay resumable', () => {
    const roots = computeAllowedRoots('/p', true, '/p/Assets');
    expect(roots).toContain('/p/.arcane');
  });

  it('keeps Assets first — it is bash cwd and list default scan root', () => {
    expect(computeAllowedRoots('/p', true, '/p/Assets')[0]).toBe('/p/Assets');
  });

  it('non-Unity: the workspace itself (was: NO sandbox at all)', () => {
    expect(computeAllowedRoots('/p', false, null)).toEqual(['/p']);
  });

  it('Unity without a resolved Assets root falls back to the workspace', () => {
    expect(computeAllowedRoots('/p', true, null)).toEqual(['/p']);
  });

  it('no workspace open denies all file tools', () => {
    expect(computeAllowedRoots('/', false, null)).toEqual([]);
    expect(computeAllowedRoots('', false, null)).toEqual([]);
  });
});

describe('computeExternalAgentWriteRoots', () => {
  /**
   * An external agent runs its OWN harness. Confining its writes to a Unity
   * project's `Assets/` is UnityIDE's tool policy, not a safety property — and it
   * is not one the sandbox can enforce anyway, since `acp-terminals.ts` gives
   * the same agent an unconfined shell. What survives here is the one
   * confinement that does real work: writes stay inside the open project.
   */
  it('is the whole workspace, NOT the Unity triple', () => {
    expect(computeExternalAgentWriteRoots('/p')).toEqual(['/p']);
    // The UnityIDE agent's own sandbox is unchanged — these must not converge.
    expect(computeAllowedRoots('/p', true, '/p/Assets')).not.toEqual(
      computeExternalAgentWriteRoots('/p'),
    );
  });

  it('denies everything when no folder is open', () => {
    // Matches computeAllowedRoots: '/' is agent-service's no-workspace
    // placeholder, and deny-all beats sandboxing to the filesystem root.
    expect(computeExternalAgentWriteRoots('/')).toEqual([]);
    expect(computeExternalAgentWriteRoots('')).toEqual([]);
  });
});
