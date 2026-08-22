import { describe, it, expect } from 'bun:test';
import { AcpRequestError } from '../../acp';
import {
  ClaudeSetupRequiredError,
  classifyConnectError,
  connectStateIsBlocking,
} from './claude-connect';

describe('classifyConnectError', () => {
  /**
   * The bug this exists for: `session/new` answers `-32000 auth_required` for a
   * user who has never signed in to Claude, and the old code turned that into a
   * red error block in the transcript. The sign-in card is driven by
   * `agentNeedsAuth`, so an unclassified auth error meant the ONE actionable
   * state had no way to appear.
   */
  it('recognises the agent asking for authentication', () => {
    const err = new AcpRequestError('session/new', {
      code: -32000,
      message: 'Authentication required',
    });
    expect(classifyConnectError(err)).toEqual({ kind: 'auth-required' });
  });

  it('carries the setup state through so the gate can name what is missing', () => {
    const err = new ClaudeSetupRequiredError({ kind: 'not-installed' });
    expect(classifyConnectError(err)).toEqual({
      kind: 'setup-required',
      state: { kind: 'not-installed' },
    });
  });

  it('falls back to a readable failure for anything else', () => {
    expect(classifyConnectError(new Error('spawn ENOENT'))).toEqual({
      kind: 'failed',
      message: 'spawn ENOENT',
    });
    // Tauri rejects `invoke` with a bare string.
    expect(classifyConnectError('node exited with code 1')).toEqual({
      kind: 'failed',
      message: 'node exited with code 1',
    });
  });

  it('does not mistake an ordinary JSON-RPC failure for an auth prompt', () => {
    const err = new AcpRequestError('session/new', { code: -32602, message: 'bad params' });
    expect(classifyConnectError(err)).toEqual({ kind: 'failed', message: 'bad params' });
  });
});

describe('connectStateIsBlocking', () => {
  it('blocks the composer only while the agent cannot answer a prompt', () => {
    expect(connectStateIsBlocking({ kind: 'ready' })).toBe(false);
    expect(connectStateIsBlocking({ kind: 'idle' })).toBe(false);
    expect(connectStateIsBlocking({ kind: 'connecting' })).toBe(true);
    expect(connectStateIsBlocking({ kind: 'auth-required' })).toBe(true);
    expect(connectStateIsBlocking({ kind: 'setup-required', state: { kind: 'npm-missing' } })).toBe(
      true,
    );
    expect(connectStateIsBlocking({ kind: 'failed', message: 'boom' })).toBe(true);
  });
});
