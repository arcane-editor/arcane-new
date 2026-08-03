import { describe, it, expect } from 'bun:test';
import { createSuggestCache, cacheKey } from './suggest-cache';

describe('suggest cache', () => {
    it('stores and retrieves by key, including empty suggestions', () => {
        const c = createSuggestCache();
        const k = cacheKey('/a.cs', 'pre', 'suf');
        expect(c.get(k)).toBeNull();
        c.set(k, 'foo();', { path: '/a.cs', prefix: 'pre', suffix: 'suf' });
        expect(c.get(k)).toBe('foo();');
        const k2 = cacheKey('/a.cs', 'pre2', 'suf');
        c.set(k2, '', { path: '/a.cs', prefix: 'pre2', suffix: 'suf' });
        expect(c.get(k2)).toBe('');
    });

    it('keys hash on prefix TAIL and suffix HEAD', () => {
        const long = 'x'.repeat(1000);
        expect(cacheKey('/a', long + 'same500tail'.padStart(500, 'x'), 's'))
            .toBe(cacheKey('/a', 'DIFFERENT' + long.slice(0, 1000 - 9) + 'same500tail'.padStart(500, 'x'), 's'));
    });

    it('evicts least-recently-used beyond capacity', () => {
        const c = createSuggestCache(2);
        c.set('k1', 'a', { path: '', prefix: '', suffix: '' });
        c.set('k2', 'b', { path: '', prefix: '', suffix: '' });
        c.get('k1'); // touch k1 → k2 is now LRU
        c.set('k3', 'c', { path: '', prefix: '', suffix: '' });
        expect(c.get('k2')).toBeNull();
        expect(c.get('k1')).toBe('a');
    });

    it('type-through: typing the suggested chars trims the suggestion locally', () => {
        const c = createSuggestCache();
        c.set('k', 'return x;', { path: '/a.cs', prefix: 'int f() { ', suffix: ' }' });
        expect(c.tryTypeThrough('/a.cs', 'int f() { ret', ' }')).toBe('urn x;');
        expect(c.tryTypeThrough('/a.cs', 'int f() { wrong', ' }')).toBeNull();  // diverged
        expect(c.tryTypeThrough('/b.cs', 'int f() { ret', ' }')).toBeNull();    // other file
        expect(c.tryTypeThrough('/a.cs', 'int f() { ret', ' }X')).toBeNull();   // suffix changed
        expect(c.tryTypeThrough('/a.cs', 'int f() { return x;', ' }')).toBeNull(); // fully typed
    });
});
