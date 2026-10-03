import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { editorialInventory } from './lib/editorial-inventory';
import { editorialPath, isPublished } from '../src/lib/editorial';
import { canonicalUrl, SITE_URL } from '../src/lib/seo';

// Astro already depends on rehype. Resolve from Astro instead of depending on
// hoisting or matching HTML with regular expressions.
const localRequire = createRequire(import.meta.url);
const astroRequire = createRequire(localRequire.resolve('astro/package.json'));
const { rehype } = await import(pathToFileURL(astroRequire.resolve('rehype')).href);
type Node = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: Node[] };
const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const errors: string[] = [];
const warnings: string[] = [];
const privateRoute = /^\/(auth|account|admin|forgot|reset|verify)(\/|$)/;
const origin = new URL(SITE_URL).origin;

if (!existsSync(join(dist, 'index.html'))) {
  console.error('SEO audit needs the built site. Run bun run build first.');
  process.exit(1);
}

function allFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    return entry.isDirectory() ? allFiles(file) : [file];
  });
}

function walk(node: Node, visit: (node: Node) => void) {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}
function text(node: Node): string {
  return node.type === 'text' ? node.value ?? '' : (node.children ?? []).map(text).join('');
}
function attr(node: Node, name: string): string {
  const value = node.properties?.[name];
  return Array.isArray(value) ? value.join(' ') : value === undefined ? '' : String(value);
}
function routeFor(file: string): string {
  const path = relative(dist, file).replace(/\\/g, '/');
  return path === 'index.html' ? '/' : `/${path.replace(/index\.html$/, '')}`;
}
function check(condition: unknown, message: string) { if (!condition) errors.push(message); }

const pages = new Map<string, {
  file: string; nodes: Node[]; ids: Set<string>; noindex: boolean; canonical: string; graphs: Record<string, unknown>[];
}>();
for (const file of allFiles(dist).filter((file) => file.endsWith('.html'))) {
  const tree = rehype().parse(readFileSync(file, 'utf8')) as Node;
  const nodes: Node[] = [];
  walk(tree, (node) => { if (node.type === 'element') nodes.push(node); });
  const route = routeFor(file);
  const meta = (name: string) => nodes.filter((node) => node.tagName === 'meta' && (attr(node, 'name') === name || attr(node, 'property') === name));
  const noindex = meta('robots').some((node) => /\bnoindex\b/i.test(attr(node, 'content')));
  const canonicals = nodes.filter((node) => node.tagName === 'link' && attr(node, 'rel').split(' ').includes('canonical'));
  const canonical = canonicals.length === 1 ? attr(canonicals[0], 'href') : '';
  const graphs: Record<string, unknown>[] = [];
  for (const script of nodes.filter((node) => node.tagName === 'script' && attr(node, 'type') === 'application/ld+json')) {
    try {
      const data = JSON.parse(text(script));
      check(data && typeof data === 'object', `${route}: JSON-LD must contain an object or graph.`);
      const entries = Array.isArray(data) ? data : Array.isArray(data?.['@graph']) ? data['@graph'] : [data];
      for (const entry of entries) {
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) graphs.push(entry);
        else errors.push(`${route}: JSON-LD graph contains a non-object entry.`);
      }
    } catch { errors.push(`${route}: invalid JSON-LD.`); }
  }
  const ids = new Set(nodes.map((node) => attr(node, 'id')).filter(Boolean));
  pages.set(route, { file, nodes, ids, noindex, canonical, graphs });
  if (privateRoute.test(route)) check(noindex, `${route}: private route must have noindex.`);
  if (noindex || route === '/404.html') continue;
  const titles = nodes.filter((node) => node.tagName === 'title');
  check(titles.length === 1 && text(titles[0]).trim().length > 0, `${route}: needs exactly one nonempty title.`);
  check(meta('description').length === 1 && attr(meta('description')[0], 'content').trim().length > 0, `${route}: needs one nonempty description.`);
  check(nodes.filter((node) => node.tagName === 'h1' && text(node).trim()).length === 1, `${route}: needs one nonempty static H1.`);
  check(canonical === canonicalUrl(route), `${route}: canonical must be ${canonicalUrl(route)}.`);
  for (const name of ['og:title', 'og:description', 'og:url']) {
    check(meta(name).length === 1 && attr(meta(name)[0], 'content'), `${route}: missing or duplicate ${name}.`);
  }
  if (meta('og:url').length === 1) check(attr(meta('og:url')[0], 'content') === canonical, `${route}: og:url and canonical disagree.`);
  if (meta('og:image').length === 0) warnings.push(`${route}: no social preview image.`);
}

// Duplicate metadata often means a page silently fell back to the home copy.
for (const kind of ['title', 'description'] as const) {
  const seen = new Map<string, string>();
  for (const [route, page] of pages) {
    if (page.noindex || route === '/404.html') continue;
    const node = page.nodes.find((node) => kind === 'title' ? node.tagName === 'title' : node.tagName === 'meta' && attr(node, 'name') === 'description');
    const value = node ? (kind === 'title' ? text(node) : attr(node, 'content')).trim() : '';
    if (!value) continue;
    check(!seen.has(value), `${route}: duplicate ${kind} shared with ${seen.get(value)}.`);
    seen.set(value, route);
  }
}

const sitemapFiles = allFiles(dist).filter((file) => /^sitemap-\d+\.xml$/.test(relative(dist, file)));
check(sitemapFiles.length > 0, 'Missing generated sitemap URL file.');
const sitemapUrls = sitemapFiles.flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]));
check(new Set(sitemapUrls).size === sitemapUrls.length, 'Sitemap contains duplicate URLs.');
const sitemapPaths = new Set<string>();
for (const value of sitemapUrls) {
  let url: URL;
  try { url = new URL(value); } catch { errors.push(`Sitemap has an invalid URL: ${value}`); continue; }
  sitemapPaths.add(url.pathname);
  check(url.origin === origin && !url.search && !url.hash, `Sitemap URL must be canonical HTTPS without parameters: ${value}`);
  const page = pages.get(url.pathname);
  check(page && !page.noindex && !privateRoute.test(url.pathname), `Sitemap includes absent/private/noindex page: ${url.pathname}`);
  check(page?.canonical === value, `Sitemap and canonical disagree: ${url.pathname}`);
}
for (const [route, page] of pages) {
  if (!page.noindex && route !== '/404.html') check(sitemapPaths.has(route), `${route}: indexable page missing from sitemap.`);
}

const inventory = editorialInventory();
for (const entry of inventory) {
  const route = editorialPath(entry);
  const page = pages.get(route);
  if (!isPublished(entry)) {
    check(!page && !sitemapPaths.has(route), `${route}: unpublished content leaked into the build or sitemap.`);
    continue;
  }
  check(page && sitemapPaths.has(route), `${route}: published content is absent.`);
  if (!page) continue;
  const articles = page.graphs.filter((item) => item['@type'] === 'Article');
  check(page.graphs.some((item) => item['@type'] === 'BreadcrumbList'), `${route}: missing breadcrumbs schema.`);
  if (entry.collection === 'features') check(articles.length === 0, `${route}: product feature page must not be presented as an Article.`);
  else {
    check(articles.length === 1, `${route}: needs one Article schema.`);
    const article = articles[0];
    if (article) {
      check(article.headline === entry.data.title, `${route}: Article headline differs from the visible content.`);
      check(article.datePublished === entry.data.publishedAt?.toISOString(), `${route}: Article publication date differs from frontmatter.`);
      check(article.dateModified === entry.data.updatedAt?.toISOString(), `${route}: Article has an invented or incorrect update date.`);
      check(!('reviewRating' in article) && !('aggregateRating' in article), `${route}: unexpected rating schema.`);
    }
  }
}
const publishedGuides = inventory.filter((entry) => entry.collection === 'blog' && isPublished(entry));
check(pages.get('/blog/')?.noindex === (publishedGuides.length === 0), '/blog/: empty-state indexing must match the guide publication gate.');

for (const [route, page] of pages) {
  if (!inventory.some((entry) => editorialPath(entry) === route && isPublished(entry))) {
    check(!page.graphs.some((item) => item['@type'] === 'Article'), `${route}: unexpected editorial Article schema.`);
  }
  if (route !== '/' && route !== '/features/') {
    check(!page.graphs.some((item) => item['@type'] === 'SoftwareApplication'), `${route}: software schema leaked outside product pages.`);
  }
}

// The home page identifies the site separately from the software it offers.
// Keep this tied to the canonical URL so aliases do not become separate sites.
const websites = pages.get('/')?.graphs.filter((item) => item['@type'] === 'WebSite') ?? [];
check(websites.length === 1, '/: needs exactly one WebSite schema for the site name.');
if (websites.length === 1) {
  check(websites[0].name === 'UnityIDE', '/: WebSite name must match the visible UnityIDE brand.');
  check(websites[0].url === canonicalUrl('/'), '/: WebSite URL must match the canonical home page.');
}

// Validate rendered links and fragments, including noindex/private pages.
// The one download alias is tested through the actual emitted edge handler.
const workerFile = join(dist, '_worker.js');
const worker = existsSync(workerFile) ? (await import(pathToFileURL(workerFile).href)).default : undefined;
const badLinks = new Set<string>();
for (const [route, page] of pages) {
  for (const node of page.nodes.filter((node) => node.tagName === 'a')) {
    const href = attr(node, 'href');
    if (!href || /^(mailto:|tel:|javascript:)/i.test(href)) continue;
    let target: URL;
    try { target = new URL(href, new URL(route, SITE_URL)); } catch { badLinks.add(`${route}: invalid link ${href}`); continue; }
    if (target.origin !== origin) continue;
    let targetPath = target.pathname;
    let destination = pages.get(targetPath) ?? pages.get(`${targetPath.replace(/\/$/, '')}/`);
    const assetPath = join(dist, decodeURIComponent(targetPath));
    if (!destination && existsSync(assetPath) && statSync(assetPath).isFile()) continue;
    if (!destination && worker) {
      const response = await worker.fetch(new Request(target), { ASSETS: { fetch: async () => new Response(null, { status: 404 }) } });
      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        target = new URL(response.headers.get('location')!, target);
        targetPath = target.pathname;
        destination = pages.get(targetPath) ?? pages.get(`${targetPath.replace(/\/$/, '')}/`);
      }
    }
    if (!destination) { badLinks.add(`${route}: missing internal destination ${targetPath}`); continue; }
    if (target.hash && !target.hash.startsWith('#:~:text=')) {
      const fragment = decodeURIComponent(target.hash.slice(1));
      if (fragment && !destination.ids.has(fragment)) badLinks.add(`${route}: missing fragment ${targetPath}#${fragment}`);
    }
  }
}
errors.push(...badLinks);
const robots = readFileSync(join(dist, 'robots.txt'), 'utf8');
check(robots.includes(`${SITE_URL}/sitemap-index.xml`), 'robots.txt does not advertise the canonical sitemap index.');
// Every page on this static public site must remain crawlable: indexable pages
// expose their canonical, and private route shells expose their noindex tag.
// Google cannot apply noindex to a URL that robots.txt prevents it from fetching.
// https://developers.google.com/search/docs/crawling-indexing/block-indexing
const disallowedPaths = [...robots.matchAll(/^[ \t]*disallow[ \t]*:[ \t]*([^#\r\n]*)/gim)]
  .map((match) => match[1].trim()).filter(Boolean);
check(disallowedPaths.length === 0,
  `robots.txt must allow crawling so canonical and noindex directives can be read; found Disallow: ${disallowedPaths.join(', ')}.`);

if (warnings.length) console.warn(`SEO notes (${warnings.length}):\n${warnings.map((message) => `  - ${message}`).join('\n')}`);
if (errors.length) {
  console.error(`SEO audit failed (${errors.length}):\n${errors.map((message) => `  - ${message}`).join('\n')}`);
  process.exit(1);
}
console.log(`SEO audit passed: ${pages.size} HTML pages, ${sitemapUrls.length} sitemap URLs, ${inventory.filter((entry) => isPublished(entry)).length} published editorial pages, ${inventory.filter((entry) => !isPublished(entry)).length} excluded drafts/future entries. Canonicals, metadata, structured data, internal links and fragment targets checked.`);
