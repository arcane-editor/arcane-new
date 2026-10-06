import { describe, expect, it } from 'vitest';
import { ACQUISITION_KEY, acquisitionQuery, deriveAcquisition, readAcquisition, validateAcquisition } from './acquisition';

describe('minimal first-touch acquisition', () => {
  it('retains the entry pathname, not a search term or query parameter', () => {
    expect(deriveAcquisition('https://unityide.app/blog/setup/?token=private#section', 'https://www.google.com/search?q=private'))
      .toEqual({ source: 'google', medium: 'organic', landingPath: '/blog/setup/', referrerHost: 'www.google.com' });
  });
  it('never captures private, encoded, or off-site routes', () => {
    for (const path of ['/auth/?code=private', '/auth/success/', '/reset/', '/account/', '/%61uth/', '/blog/%2Ftoken']) {
      expect(deriveAcquisition(`https://unityide.app${path}`, 'https://bing.com/')).toBeUndefined();
    }
    expect(deriveAcquisition('https://dev.unityide.app/', '')).toBeUndefined();
    expect(deriveAcquisition('https://unityide.app.evil.test/', '')).toBeUndefined();
  });
  it('does not label paid clicks or unknown search hosts organic', () => {
    expect(deriveAcquisition('https://unityide.app/?gclid=private', 'https://www.google.com/')?.medium).toBe('cpc');
    expect(deriveAcquisition('https://unityide.app/?rdt_cid=private', '')?.medium).toBe('paid_social');
    expect(deriveAcquisition('https://unityide.app/', 'https://google.com.evil.test/')?.medium).toBe('referral');
  });
  it('keeps direct/unknown explicit and ignores internal navigation', () => {
    expect(deriveAcquisition('https://unityide.app/', '')?.source).toBe('direct');
    expect(deriveAcquisition('https://unityide.app/pricing/', 'https://unityide.app/blog/setup/')).toBeUndefined();
    expect(deriveAcquisition('https://unityide.app/?utm_source=person@example.com', '')?.source).toBe('unknown');
  });
  it('strips arbitrary extra fields and invalid referrer values', () => {
    expect(validateAcquisition({ source: 'google', medium: 'organic', landingPath: '/', referrerHost: 'https://example.com/path', email: 'private' }))
      .toEqual({ source: 'google', medium: 'organic', landingPath: '/' });
  });
  it('expires the first touch and tolerates blocked storage', () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, removeItem: (key: string) => { values.delete(key); } };
    values.set(ACQUISITION_KEY, JSON.stringify({ capturedAt: 100, acquisition: { source: 'bing', medium: 'organic', landingPath: '/docs/' } }));
    expect(readAcquisition(storage, 101)?.source).toBe('bing');
    expect(readAcquisition(storage, 31 * 86400000)).toBeUndefined();
    expect(values.size).toBe(0);
    expect(readAcquisition({ getItem: () => { throw new Error('blocked'); }, removeItem: () => {} })).toBeUndefined();
  });
  it('sends only the bounded fields through OAuth', () => {
    const query = new URLSearchParams(acquisitionQuery({ source: 'google', medium: 'organic', landingPath: '/docs/' }).slice(1));
    expect(Object.fromEntries(query)).toEqual({ acq_source: 'google', acq_medium: 'organic', acq_landing_path: '/docs/' });
  });
});
