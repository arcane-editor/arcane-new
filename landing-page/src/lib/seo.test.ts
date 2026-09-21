import { describe, expect, it } from 'vitest';
import { canonicalUrl, jsonLd, pageTitle } from './seo';

describe('page metadata', () => {
  it('uses directory canonicals without breaking root or asset paths', () => {
    expect(canonicalUrl('/features')).toBe('https://unityide.app/features/');
    expect(canonicalUrl('/features/')).toBe('https://unityide.app/features/');
    expect(canonicalUrl('/')).toBe('https://unityide.app/');
    expect(canonicalUrl('/sitemap.xml')).toBe('https://unityide.app/sitemap.xml');
  });
  it('does not repeat the brand suffix', () => {
    expect(pageTitle('About UnityIDE')).toBe('About UnityIDE');
    expect(pageTitle('Privacy Policy')).toBe('Privacy Policy — UnityIDE');
  });
  it('escapes script endings without changing JSON values', () => {
    const data = { headline: '</script><script>alert(1)</script>' };
    expect(jsonLd(data)).not.toContain('<');
    expect(JSON.parse(jsonLd(data))).toEqual(data);
  });
});
