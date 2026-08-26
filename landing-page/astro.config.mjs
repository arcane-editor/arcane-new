// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import react from '@astrojs/react';
import tailwind from '@astrojs/tailwind';

export default defineConfig({
	integrations: [
		starlight({
			title: 'UnityIDE Docs',
			customCss: ['./src/styles/starlight-overrides.css'],
			sidebar: [
				{
					label: 'Getting Started',
					items: [
						{ label: 'Installation', slug: 'docs/getting-started/installation' },
						{ label: 'Unity Extension', slug: 'docs/getting-started/unity-extension' },
					{ label: 'Opening Your First Project', slug: 'docs/getting-started/first-project' },
					],
				},
				{
					label: 'Editor Basics',
					autogenerate: { directory: 'docs/editor-basics' },
				},
				{
					label: 'Unity Integration',
					items: [
						{ label: 'Unity Editor Connection', slug: 'docs/unity-integration/scene-inspector' },
						{ label: 'Project Knowledge Graph', slug: 'docs/unity-integration/gameobject-browser' },
						{ label: 'GUID & Asset Resolution', slug: 'docs/unity-integration/asset-pipeline' },
					],
				},
				{
					label: 'AI Features',
					items: [
						{ label: 'Chat Modes & Reasoning', slug: 'docs/ai-features/autocompletion' },
						{ label: 'AI Tools Reference', slug: 'docs/ai-features/inline-chat' },
						{ label: 'Settings & Configuration', slug: 'docs/ai-features/code-generation' },
					],
				},
				{
					label: 'Troubleshooting',
					items: [
						{ label: 'Common Issues', slug: 'docs/api-reference/extensions' },
					],
				},
			],
			components: {
				SiteTitle: './src/components/starlight/SiteTitle.astro',
			},
		}),
		react(),
		tailwind({ applyBaseStyles: false }),
	],
});
