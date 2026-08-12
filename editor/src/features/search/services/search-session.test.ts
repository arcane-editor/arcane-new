import { describe, it, expect } from 'bun:test';
import {
  createSession,
  patchSession,
  sessionForSearchId,
} from './search-session';

describe('createSession', () => {
  it('starts empty, idle, and with default options', () => {
    const s = createSession('search://1');
    expect(s.id).toBe('search://1');
    expect(s.query).toBe('');
    expect(s.results).toEqual([]);
    expect(s.isSearching).toBe(false);
    expect(s.activeSearchId).toBeNull();
    expect(s.isRegex).toBe(false);
    expect(s.caseSensitive).toBe(false);
    expect(s.wholeWord).toBe(false);
    expect(s.includeIgnored).toBe(false);
    expect(s.history).toEqual([]);
  });
});

describe('patchSession', () => {
  it('replaces only the named session and leaves the others by reference', () => {
    const a = createSession('search://1');
    const b = createSession('search://2');
    const sessions = { [a.id]: a, [b.id]: b };
    const next = patchSession(sessions, 'search://1', { query: 'foo' });
    expect(next['search://1'].query).toBe('foo');
    expect(next['search://2']).toBe(b);
  });

  it('returns the same object when the session is unknown', () => {
    const sessions = { 'search://1': createSession('search://1') };
    expect(patchSession(sessions, 'search://9', { query: 'x' })).toBe(sessions);
  });
});

describe('sessionForSearchId', () => {
  it('finds the session tracking a given backend search id', () => {
    const sessions = {
      'search://1': { ...createSession('search://1'), activeSearchId: 7 },
      'search://2': { ...createSession('search://2'), activeSearchId: 9 },
    };
    expect(sessionForSearchId(sessions, 9)?.id).toBe('search://2');
  });

  it('returns null for an id no session is tracking (a superseded run)', () => {
    const sessions = {
      'search://1': { ...createSession('search://1'), activeSearchId: 7 },
    };
    expect(sessionForSearchId(sessions, 4)).toBeNull();
  });
});
