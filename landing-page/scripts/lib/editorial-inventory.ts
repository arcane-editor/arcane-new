import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { editorialSchema } from '../../src/lib/editorial-schema';
import { isPublished, type EditorialEntry } from '../../src/lib/editorial';

// Reuse the YAML parser already shipped with Astro; no shell-only YAML parsing
// and no assumptions about npm/pnpm/Bun's physical dependency directory layout.
const localRequire = createRequire(import.meta.url);
const astroRequire = createRequire(localRequire.resolve('astro/package.json'));
const yaml = astroRequire('js-yaml') as { load(value: string): unknown };
const contentRoot = fileURLToPath(new URL('../../src/content/', import.meta.url));

function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    return entry.isDirectory() ? markdownFiles(file) : entry.name.endsWith('.md') ? [file] : [];
  });
}

export function editorialInventory(): (EditorialEntry & { sourceFile: string })[] {
  return (['blog', 'comparisons', 'features'] as const).flatMap((collection) => {
    const directory = join(contentRoot, collection);
    return markdownFiles(directory).map((file) => {
      const source = readFileSync(file, 'utf8');
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)?.[1];
      if (!frontmatter) throw new Error(`Missing editorial frontmatter: ${relative(dirname(contentRoot), file)}`);
      const data = editorialSchema(collection).parse(yaml.load(frontmatter));
      return {
        collection, id: relative(directory, file).replace(/\\/g, '/').replace(/\.md$/, ''),
        data, body: source.slice(source.indexOf(frontmatter) + frontmatter.length), sourceFile: file,
      } as EditorialEntry & { sourceFile: string };
    });
  });
}

export function hasPublishedGuides(): boolean {
  return editorialInventory().some((entry) => entry.collection === 'blog' && isPublished(entry));
}
