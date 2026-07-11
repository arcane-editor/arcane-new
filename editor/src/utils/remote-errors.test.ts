import { describe, it, expect } from 'bun:test';
import { isAuthError, remoteErrorMessage, AUTH_ERROR_HINT } from './remote-errors';

describe('isAuthError', () => {
  it('matches "Authentication failed"', () => {
    expect(isAuthError('remote: Authentication failed for https://example.com/repo.git')).toBe(true);
  });

  it('matches "could not read Username"', () => {
    expect(
      isAuthError("fatal: could not read Username for 'https://example.com': terminal prompts disabled"),
    ).toBe(true);
  });

  it('matches "terminal prompts disabled" on its own', () => {
    expect(isAuthError('fatal: could not read Password: terminal prompts disabled')).toBe(true);
  });

  it('matches "Permission denied (publickey)"', () => {
    expect(isAuthError('git@github.com: Permission denied (publickey).')).toBe(true);
  });

  it('is false for a non-fast-forward rejection', () => {
    expect(
      isAuthError(
        '! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs',
      ),
    ).toBe(false);
  });

  it('is false for a merge-conflict pull failure', () => {
    expect(isAuthError('Automatic merge failed; fix conflicts and then commit the result.')).toBe(false);
  });

  it('is false for an unrelated network error', () => {
    expect(isAuthError('fatal: unable to access: Could not resolve host: example.com')).toBe(false);
  });

  it('is false for an empty string', () => {
    expect(isAuthError('')).toBe(false);
  });
});

describe('remoteErrorMessage', () => {
  it('replaces auth-ish stderr with the actionable hint, prefixed by the op label', () => {
    const msg = remoteErrorMessage('Push', 'fatal: Authentication failed for https://example.com/repo.git');
    expect(msg).toBe(`Push failed: ${AUTH_ERROR_HINT}`);
  });

  it('passes non-auth stderr through verbatim, prefixed by the op label', () => {
    const stderr = '! [rejected]        main -> main (non-fast-forward)';
    const msg = remoteErrorMessage('Push', stderr);
    expect(msg).toBe(`Push failed: ${stderr}`);
  });

  it('does not swallow a merge-conflict pull error', () => {
    const stderr = 'Automatic merge failed; fix conflicts and then commit the result.';
    const msg = remoteErrorMessage('Pull', stderr);
    expect(msg).toBe(`Pull failed: ${stderr}`);
    expect(msg).not.toContain(AUTH_ERROR_HINT);
  });

  it('uses the given op label for fetch', () => {
    const msg = remoteErrorMessage('Fetch', 'Permission denied (publickey).');
    expect(msg).toBe(`Fetch failed: ${AUTH_ERROR_HINT}`);
  });
});
