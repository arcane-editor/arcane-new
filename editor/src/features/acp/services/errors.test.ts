import { describe, it, expect } from 'bun:test';
import { AcpRequestError, isAuthRequired, looksLikeExpiredAuth, toMessage } from './errors';

describe('isAuthRequired', () => {
  it('matches ACP -32000 only', () => {
    expect(isAuthRequired(new AcpRequestError('session/new', { code: -32000, message: 'x' }))).toBe(true);
    expect(isAuthRequired(new AcpRequestError('session/new', { code: -32603, message: 'x' }))).toBe(false);
  });

  it('is false for anything that is not an AcpRequestError', () => {
    expect(isAuthRequired(new Error('Authentication required'))).toBe(false);
    expect(isAuthRequired('-32000')).toBe(false);
    expect(isAuthRequired(null)).toBe(false);
  });
});

describe('looksLikeExpiredAuth', () => {
  it('catches the messages the agent actually emits', () => {
    expect(looksLikeExpiredAuth('Not logged in · Please run /login')).toBe(true);
    expect(looksLikeExpiredAuth('Session expired. Please run /login to sign in again.')).toBe(true);
    expect(looksLikeExpiredAuth('Invalid API key')).toBe(true);
  });

  it('does not misfire on ordinary text about auth', () => {
    // The reason the markers are narrow: a turn that edits a login screen must
    // not be reported as an expired session.
    expect(looksLikeExpiredAuth('I updated the /login route handler.')).toBe(false);
    expect(looksLikeExpiredAuth('Added OAuth login to the settings page.')).toBe(false);
    expect(looksLikeExpiredAuth('')).toBe(false);
  });
});

describe('toMessage', () => {
  it('unwraps the shapes Tauri and JS actually throw', () => {
    expect(toMessage(new Error('boom'))).toBe('boom');
    expect(toMessage('spawn failed')).toBe('spawn failed');
    expect(toMessage({ detail: 'nope' })).toBe('{"detail":"nope"}');
  });
});
