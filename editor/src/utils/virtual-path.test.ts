import { describe, it, expect } from 'bun:test';
import { isVirtualPath } from './virtual-path';

describe('isVirtualPath', () => {
  it('matches every virtual scheme', () => {
    expect(isVirtualPath('diff://unstaged/src/a.ts')).toBe(true);
    expect(isVirtualPath('diff://commit/abc123/src/a.ts')).toBe(true);
    expect(isVirtualPath('auth://signin')).toBe(true);
    expect(isVirtualPath('search://1')).toBe(true);
  });

  it('does not match real paths on either platform', () => {
    expect(isVirtualPath('/Users/x/proj/src/a.ts')).toBe(false);
    expect(isVirtualPath('C:/proj/src/a.ts')).toBe(false);
  });

  it('only matches at the start, never mid-path', () => {
    expect(isVirtualPath('/Users/x/search://1')).toBe(false);
  });
});
