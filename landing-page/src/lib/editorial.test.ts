import { describe, expect, it } from 'vitest';
import { editorialSchema } from './editorial-schema';
import { editorialPath, editorialStructuredData, isPublished, type EditorialEntry } from './editorial';

const base = {
  title: 'A practical Unity example',
  description: 'A practical Unity example with clearly stated evidence and useful reproduction steps.',
  topic: 'Unity development',
  author: { name: 'UnityIDE team', url: '/about/' },
  draft: false,
  publishedAt: '2026-09-21',
  researchedAt: '2026-09-21',
  verification: { status: 'documented', summary: 'Facts checked against the cited official documentation; no runtime test claimed.' },
  testedVersions: [],
  sources: [{ title: 'Official documentation', url: 'https://docs.unity3d.com/', accessedAt: '2026-09-21' }],
  related: [],
};

describe('editorial publication gates', () => {
  it('keeps untested technical guides out while allowing explicit documentation comparisons', () => {
    expect(editorialSchema('blog').safeParse(base).success).toBe(false);
    expect(editorialSchema('comparisons').safeParse(base).success).toBe(true);
    expect(editorialSchema('blog').safeParse({ ...base, draft: true }).success).toBe(true);
  });

  it('requires a publication date and rejects pending evidence for public pages', () => {
    expect(editorialSchema('features').safeParse({ ...base, publishedAt: undefined }).success).toBe(false);
    expect(editorialSchema('comparisons').safeParse({ ...base, verification: { ...base.verification, status: 'pending' } }).success).toBe(false);
  });

  it('requires both actual versions and an evidence reference for tested guides', () => {
    const verified = { ...base, verification: { status: 'tested', summary: 'Actual narrow fixture run; unrelated workflows remain unverified.', evidence: 'docs/seo/evidence/example.md' } };
    expect(editorialSchema('blog').safeParse(verified).success).toBe(false);
    expect(editorialSchema('blog').safeParse({ ...verified, testedVersions: [{ tool: 'Unity', version: '6000.3.5f2', platform: 'macOS' }] }).success).toBe(true);
  });

  it('requires an explained substantive update after publication', () => {
    expect(editorialSchema('comparisons').safeParse({ ...base, updatedAt: '2026-09-22' }).success).toBe(false);
    expect(editorialSchema('comparisons').safeParse({ ...base, updatedAt: '2026-09-20', updateNote: 'Changed a claim.' }).success).toBe(false);
    expect(editorialSchema('comparisons').safeParse({ ...base, updatedAt: '2026-09-22', updateNote: 'Updated the supported platform list.' }).success).toBe(true);
  });

  it('requires meaningful alt text and attribution when an image is supplied', () => {
    expect(editorialSchema('comparisons').safeParse({ ...base, image: { src: '/example.png', alt: 'A real project screenshot' } }).success).toBe(false);
    expect(editorialSchema('comparisons').safeParse({ ...base, image: { src: '/example.png', alt: 'A real project screenshot', credit: 'UnityIDE team' } }).success).toBe(true);
  });

  it('excludes drafts and future releases from every route/list consumer', () => {
    const data = editorialSchema('comparisons').parse(base);
    const now = new Date('2026-09-21T12:00:00Z');
    expect(isPublished({ data }, now)).toBe(true);
    expect(isPublished({ data: { ...data, draft: true } }, now)).toBe(false);
    expect(isPublished({ data: { ...data, publishedAt: new Date('2026-09-22') } }, now)).toBe(false);
    expect(isPublished({ data: { ...data, publishedAt: undefined } }, now)).toBe(false);
  });
});

describe('editorial structured data', () => {
  const entry = { id: 'rider', collection: 'comparisons', data: editorialSchema('comparisons').parse(base) } as EditorialEntry;
  it('uses canonical section URLs and an organization author without fabricated update dates', () => {
    expect(editorialPath(entry)).toBe('/compare/rider/');
    const [breadcrumbs, article] = editorialStructuredData(entry, new URL('https://unityide.app/'));
    expect(breadcrumbs['@type']).toBe('BreadcrumbList');
    expect(article['@type']).toBe('Article');
    expect(article.url).toBe('https://unityide.app/compare/rider/');
    expect(article.author).toEqual({ '@type': 'Organization', name: 'UnityIDE team', url: 'https://unityide.app/about/' });
    expect(article).not.toHaveProperty('dateModified');
    expect(article).not.toHaveProperty('aggregateRating');
    expect(article).not.toHaveProperty('reviewRating');
  });

  it('does not label a product feature page as an editorial review or article', () => {
    const graphs = editorialStructuredData({ ...entry, id: 'ai', collection: 'features' }, new URL('https://unityide.app/'));
    expect(graphs).toHaveLength(1);
    expect(graphs[0]['@type']).toBe('BreadcrumbList');
  });
});
