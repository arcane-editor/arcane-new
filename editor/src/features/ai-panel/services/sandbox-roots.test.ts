import { describe, it, expect } from 'bun:test';
import { computeAllowedRoots, computeExternalAgentWriteRoots } from './sandbox-roots';

describe('computeAllowedRoots', () => {
  it('Unity: Assets first (bash cwd), then .arcane, then Packages', () => {
    expect(computeAllowedRoots('/p', true, '/p/Assets')).toEqual([
      '/p/Assets',
      '/p/.arcane',
      '/p/Packages',
    ]);
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
   * project's `Assets/` is Arcane's tool policy, not a safety property — and it
   * is not one the sandbox can enforce anyway, since `acp-terminals.ts` gives
   * the same agent an unconfined shell. What survives here is the one
   * confinement that does real work: writes stay inside the open project.
   */
  it('is the whole workspace, NOT the Unity triple', () => {
    expect(computeExternalAgentWriteRoots('/p')).toEqual(['/p']);
    // The Arcane agent's own sandbox is unchanged — these must not converge.
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
