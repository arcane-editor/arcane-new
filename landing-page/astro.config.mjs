// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import react from '@astrojs/react';
import tailwind from '@astrojs/tailwind';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
	// The single most load-bearing line in this file for search.
	// Starlight only emits <link rel="canonical">, og:url and the sitemap link
	// when `site` is set (see @astrojs/starlight/utils/head.ts) — with it unset,
	// every one of the ~16 docs pages shipped with none of the three, and
	// @astrojs/sitemap cannot run at all.
	site: 'https://unityide.app',
	integrations: [
		sitemap({
			// Pages behind sign-in or carrying one-time tokens. They also send
			// `noindex` from LandingLayout; this keeps them out of the sitemap so
			// we are not simultaneously submitting and disallowing them.
			//
			// Anchored at the START of the path and matching a whole segment.
			// An end-anchored version let /auth/success/ through — it ends in
			// "success", not "auth" — which is exactly the contradictory state
			// this filter exists to prevent.
			filter: (page) =>
				!/^\/(auth|account|admin|forgot|reset|verify)(\/|$)/.test(new URL(page).pathname),
		}),
		starlight({
			title: 'UnityIDE Docs',
			description:
				'Documentation for UnityIDE — the AI-powered IDE built for Unity developers.',
			// Same reason as LandingLayout: these were a render-blocking @import
			// at the top of starlight-overrides.css, so the font request could
			// not even be discovered until that stylesheet had parsed.
			head: [
				{ tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.googleapis.com' } },
				{ tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: true } },
				{
					tag: 'link',
					attrs: {
						rel: 'stylesheet',
						href: 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Space+Grotesk:wght@300;400;500;600;700&family=Inter:wght@300;400;500;600;700;800&display=swap',
					},
				},
			],
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
