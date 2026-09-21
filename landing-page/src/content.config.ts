import { defineCollection } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';
import { glob } from 'astro/loaders';
import { editorialSchema } from './lib/editorial-schema';

export const collections = {
	docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
	blog: defineCollection({
		loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
		schema: editorialSchema('blog'),
	}),
	comparisons: defineCollection({
		loader: glob({ pattern: '**/*.md', base: './src/content/comparisons' }),
		schema: editorialSchema('comparisons'),
	}),
	features: defineCollection({
		loader: glob({ pattern: '**/*.md', base: './src/content/features' }),
		schema: editorialSchema('features'),
	}),
};
