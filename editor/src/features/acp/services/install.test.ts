import { describe, it, expect } from 'bun:test';
import {
  isLaunchable,
  launchParams,
  parseNodeMajor,
  resolveSetupState,
  REQUIRED_NODE_MAJOR,
  type AcpProbe,
} from './install';

const ready: AcpProbe = {
  nodePath: '/usr/local/bin/node',
  nodeVersion: 'v24.12.0',
  npmPath: '/usr/local/bin/npm',
  claudePath: '/Users/x/.local/bin/claude',
  installedVersion: '0.70.0',
  adapterEntry: '/Users/x/.arcane/agents/claude/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js',
  usesExternalCli: true,
  pinnedVersion: '0.70.0',
};
const p = (o: Partial<AcpProbe> = {}): AcpProbe => ({ ...ready, ...o });

describe('parseNodeMajor', () => {
  it('reads the major out of the shapes `node -v` produces', () => {
    expect(parseNodeMajor('v24.12.0')).toBe(24);
    expect(parseNodeMajor('22.0.0')).toBe(22);
    expect(parseNodeMajor('  v20.11.1\n')).toBe(20);
  });

  it('returns null rather than NaN for junk', () => {
    expect(parseNodeMajor(null)).toBeNull();
    expect(parseNodeMajor('')).toBeNull();
    expect(parseNodeMajor('not a version')).toBeNull();
  });
});

describe('resolveSetupState', () => {
  it('reports ready with the exact spawn parameters', () => {
    const state = resolveSetupState(p());
    expect(state).toEqual({
      kind: 'ready',
      command: ready.nodePath!,
      args: [ready.adapterEntry!],
      env: { CLAUDE_CODE_EXECUTABLE: ready.claudePath! },
    });
  });

  it('omits CLAUDE_CODE_EXECUTABLE for a full install', () => {
    // A full install ships its own version-matched native binary; overriding it
    // with whatever `claude` happens to be on PATH would be a downgrade.
    const state = resolveSetupState(p({ usesExternalCli: false }));
    expect(state.kind === 'ready' && state.env).toEqual({});
  });

  it('reports node-missing before anything else', () => {
    expect(resolveSetupState(p({ nodePath: null, npmPath: null, installedVersion: null }))).toEqual({
      kind: 'node-missing',
    });
  });

  it('reports node-too-old with the version actually found', () => {
    expect(resolveSetupState(p({ nodeVersion: 'v20.11.1' }))).toEqual({
      kind: 'node-too-old',
      found: 'v20.11.1',
      required: REQUIRED_NODE_MAJOR,
    });
  });

  it('treats an unreadable node version as too old rather than assuming ok', () => {
    expect(resolveSetupState(p({ nodeVersion: null })).kind).toBe('node-too-old');
  });

  it('reports not-installed when npm is available to fix it', () => {
    expect(resolveSetupState(p({ installedVersion: null, adapterEntry: null }))).toEqual({
      kind: 'not-installed',
    });
  });

  it('reports npm-missing only when an install is actually needed', () => {
    expect(resolveSetupState(p({ npmPath: null, installedVersion: null, adapterEntry: null }))).toEqual({
      kind: 'npm-missing',
    });
    // Already installed: npm is irrelevant, so it must still be ready.
    expect(resolveSetupState(p({ npmPath: null })).kind).toBe('ready');
  });

  it('reports cli-missing when a lean install lost the binary it points at', () => {
    expect(resolveSetupState(p({ claudePath: null }))).toEqual({ kind: 'cli-missing' });
  });

  it('does not report cli-missing for a full install without a user CLI', () => {
    expect(resolveSetupState(p({ claudePath: null, usesExternalCli: false })).kind).toBe('ready');
  });

  it('reports outdated when the installed version drifts from the pin', () => {
    expect(resolveSetupState(p({ installedVersion: '0.66.0' }))).toEqual({
      kind: 'outdated',
      installed: '0.66.0',
      pinned: '0.70.0',
    });
  });

  it('repairs a broken install before bumping its version', () => {
    expect(resolveSetupState(p({ installedVersion: '0.66.0', claudePath: null })).kind).toBe('cli-missing');
  });
});

describe('isLaunchable / launchParams', () => {
  it('lets an outdated adapter still run', () => {
    const state = resolveSetupState(p({ installedVersion: '0.66.0' }));
    expect(isLaunchable(state)).toBe(true);
    expect(launchParams(state, p({ installedVersion: '0.66.0' }))).toEqual({
      command: ready.nodePath!,
      args: [ready.adapterEntry!],
      env: { CLAUDE_CODE_EXECUTABLE: ready.claudePath! },
    });
  });

  it('refuses to produce parameters for an unfinished setup', () => {
    for (const probe of [
      p({ nodePath: null }),
      p({ installedVersion: null, adapterEntry: null }),
      p({ claudePath: null }),
    ]) {
      const state = resolveSetupState(probe);
      expect(isLaunchable(state)).toBe(false);
      expect(launchParams(state, probe)).toBeNull();
    }
  });
});
