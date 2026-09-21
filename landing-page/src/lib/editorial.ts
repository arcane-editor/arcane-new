import type { CollectionEntry } from 'astro:content';

export type EditorialEntry = CollectionEntry<'blog'> | CollectionEntry<'comparisons'> | CollectionEntry<'features'>;

export function isPublished(entry: Pick<EditorialEntry, 'data'>, now = new Date()): boolean {
  return !entry.data.draft && Boolean(entry.data.publishedAt && entry.data.publishedAt <= now);
}

export function editorialPath(entry: Pick<EditorialEntry, 'collection' | 'id'>): string {
  const section = entry.collection === 'comparisons' ? 'compare' : entry.collection;
  return `/${section}/${entry.id}/`;
}

export function dateLabel(date: Date): string {
  return new Intl.DateTimeFormat('en', { dateStyle: 'long', timeZone: 'UTC' }).format(date);
}

export function editorialStructuredData(entry: EditorialEntry, site: URL): Record<string, unknown>[] {
  const data = entry.data;
  const pageUrl = new URL(editorialPath(entry), site).href;
  const section = entry.collection === 'blog' ? { name: 'Guides', url: '/blog/' }
    : entry.collection === 'comparisons' ? { name: 'Compare', url: '/compare/' }
      : { name: 'Features', url: '/features/' };
  const breadcrumbs = {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'UnityIDE', item: site.href },
      { '@type': 'ListItem', position: 2, name: section.name, item: new URL(section.url, site).href },
      { '@type': 'ListItem', position: 3, name: data.title, item: pageUrl },
    ],
  };
  // Product features are pages, not reviews or technical articles.
  if (entry.collection === 'features') return [breadcrumbs];
  return [breadcrumbs, {
    '@context': 'https://schema.org', '@type': 'Article',
    headline: data.title, description: data.description,
    mainEntityOfPage: pageUrl, url: pageUrl,
    datePublished: data.publishedAt?.toISOString(),
    ...(data.updatedAt ? { dateModified: data.updatedAt.toISOString() } : {}),
    author: { '@type': 'Organization', name: data.author.name, url: new URL(data.author.url, site).href },
    publisher: { '@type': 'Organization', name: 'UnityIDE', url: site.href },
    ...(data.image ? { image: new URL(data.image.src, site).href } : {}),
  }];
}
