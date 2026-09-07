import { describe, it, expect } from 'bun:test';
import { pushRecentFile, RECENT_FILES_LIMIT } from './recent-files';

describe('pushRecentFile', () => {
  it('puts a newly visited file at the front', () => {
    expect(pushRecentFile(['/a.cs'], '/b.cs')).toEqual(['/b.cs', '/a.cs']);
  });

  it('moves a revisited file to the front instead of duplicating it', () => {
    expect(pushRecentFile(['/a.cs', '/b.cs', '/c.cs'], '/c.cs')).toEqual([
      '/c.cs',
      '/a.cs',
      '/b.cs',
    ]);
  });

  it('records a file the user is already on without growing the list', () => {
    const list = ['/a.cs', '/b.cs'];
    expect(pushRecentFile(list, '/a.cs')).toEqual(['/a.cs', '/b.cs']);
  });

  it('returns the SAME reference for a virtual tab, so the caller can skip the write', () => {
    // Reference equality is load-bearing: this drives a store subscription, and
    // writing a fresh array every time would re-notify on every tab switch.
    const list = ['/a.cs'];
    for (const path of ['search://1', 'diff://staged/x.cs', 'auth://callback']) {
      expect(pushRecentFile(list, path)).toBe(list);
    }
  });

  it('returns the same reference for an empty path', () => {
    const list = ['/a.cs'];
    expect(pushRecentFile(list, '')).toBe(list);
  });

  it('caps the list, dropping the least recently visited', () => {
    let list: string[] = [];
    for (let i = 0; i < RECENT_FILES_LIMIT + 5; i++) list = pushRecentFile(list, `/f${i}.cs`);

    expect(list).toHaveLength(RECENT_FILES_LIMIT);
    expect(list[0]).toBe(`/f${RECENT_FILES_LIMIT + 4}.cs`);
    expect(list).not.toContain('/f0.cs');
  });

  it('builds an order that reflects visits, not opens', () => {
    // a, b, c opened; then a revisited. The switcher must offer a first.
    let list: string[] = [];
    list = pushRecentFile(list, '/a.cs');
    list = pushRecentFile(list, '/b.cs');
    list = pushRecentFile(list, '/c.cs');
    list = pushRecentFile(list, '/a.cs');
    expect(list).toEqual(['/a.cs', '/c.cs', '/b.cs']);
  });
});
