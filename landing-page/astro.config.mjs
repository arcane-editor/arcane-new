// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import react from '@astrojs/react';
import tailwind from '@astrojs/tailwind';
import sitemap from '@astrojs/sitemap';

/**
 * The docs' code theme, wired to the five meanings in `src/styles/lp-tokens.css`.
 *
 * Hex rather than `var(--blue)` because Expressive Code does colour maths on
 * these at build time to derive borders and contrast, and it cannot resolve a
 * CSS custom property in Node. They mirror the tokens exactly:
 *
 *   violet  #c792ea  a C# keyword
 *   blue    #7cb7ff  a type — something the tool resolved
 *   green   #6fe3a5  a literal value
 *   gold    #f5c26b  a number
 *   faint   #6f747d  grey: what the tool has not been asked to understand
 *
 * The payoff is that a C# snippet in the docs and the same snippet open in
 * UnityIDE are coloured identically. That is the difference between docs that
 * describe the product and docs that look like it.
 */
const docsCodeTheme = {
	name: 'unityide-docs',
	type: 'dark',
	colors: {
		'editor.background': '#0f1114',
		'editor.foreground': '#e8e6e1',
		'editor.selectionBackground': '#252b38',
		'editorLineNumber.foreground': '#3a4150',
		'editorLineNumber.activeForeground': '#8a8f98',
	},
	tokenColors: [
		{
			scope: ['comment', 'punctuation.definition.comment'],
			settings: { foreground: '#6f747d', fontStyle: 'italic' },
		},
		{
			scope: [
				'keyword',
				'keyword.control',
				'keyword.operator.new',
				'keyword.operator.expression',
				'storage',
				'storage.type',
				'storage.modifier',
				'variable.language',
				'constant.language',
			],
			settings: { foreground: '#c792ea' },
		},
		{
			scope: ['string', 'string.quoted', 'string.template', 'punctuation.definition.string'],
			settings: { foreground: '#6fe3a5' },
		},
		{
			scope: ['constant.numeric', 'constant.character', 'constant.other'],
			settings: { foreground: '#f5c26b' },
		},
		{
			scope: [
				'entity.name.type',
				'entity.name.class',
				'entity.other.inherited-class',
				'support.type',
				'support.class',
				'support.type.property-name',
				'entity.name.tag',
			],
			settings: { foreground: '#7cb7ff' },
		},
		{
			scope: ['entity.name.function', 'support.function', 'meta.function-call'],
			settings: { foreground: '#e8e6e1' },
		},
		{
			scope: ['variable', 'variable.other', 'meta.definition.variable.name', 'support.variable'],
			settings: { foreground: '#e8e6e1' },
		},
		{
			scope: ['punctuation', 'meta.brace', 'keyword.operator'],
			settings: { foreground: '#8a8f98' },
		},
		{ scope: ['invalid', 'invalid.illegal'], settings: { foreground: '#ff6f6f' } },
	],
};

export default defineConfig({
	// The single most load-bearing line in this file for search.
	// Starlight only emits <link rel="canonical">, og:url and the sitemap link
	// when `site` is set (see @astrojs/starlight/utils/head.ts) — with it unset,
	// every one of the ~16 docs pages shipped with none of the three, and
	// @astrojs/sitemap cannot run at all.
	site: 'https://unityide.app',
	// `scripts/unity-extension-channel.mjs` publishes `unityide.app/download` (and
	// `/download#dev`) as the Unity package's download URL, and neither route has
	// ever existed — every reader who followed it from the package manager got a
	// 404. The download section lives on the home page, so the URL is redirected
	// rather than duplicated into a second page with its own build-time manifest
	// fetch and its own claim on the same search result.
	redirects: { '/download': '/#download' },
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
			// The landing page's exact pair — Bricolage Grotesque for structure,
			// IBM Plex Mono for text that IS machine output. The docs used to load
			// Inter, Space Grotesk and JetBrains Mono instead, three faces used
			// nowhere else on the site, so crossing from / to /docs/ re-downloaded a
			// whole font stack to arrive somewhere that looked unrelated.
			//
			// Kept as a <link> rather than an @import at the top of
			// starlight-overrides.css: as an @import the request could not be
			// discovered until that stylesheet had parsed.
			head: [
				{ tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.googleapis.com' } },
				{ tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: true } },
				{
					tag: 'link',
					attrs: {
						rel: 'stylesheet',
						href: 'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,300..800&family=IBM+Plex+Mono:ital,wght@0,400;0,500;1,400&display=swap',
					},
				},
			],
			customCss: ['./src/styles/starlight-overrides.css'],
			expressiveCode: {
				themes: [docsCodeTheme],
				useDarkModeMediaQuery: false,
				styleOverrides: {
					borderColor: '#1f2329',
					borderRadius: '10px',
					codeFontFamily: "'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
					codeFontSize: '0.8125rem',
					uiFontFamily: "'Bricolage Grotesque', ui-sans-serif, system-ui, -apple-system, sans-serif",
					frames: {
						// `--ec-frm-edBg` used to resolve to `--sl-color-gray-7`, which the
						// old overrides file never defined — so the tab bar above every
						// code block fell through to Starlight's LIGHT-mode default.
						editorActiveTabBackground: '#0f1114',
						editorActiveTabForeground: '#e8e6e1',
						editorActiveTabBorderColor: '#1f2329',
						editorTabBarBackground: '#0c0e12',
						editorTabBarBorderBottomColor: '#1f2329',
						editorBackground: '#0f1114',
						terminalBackground: '#0f1114',
						terminalTitlebarBackground: '#0c0e12',
						terminalTitlebarForeground: '#8a8f98',
						terminalTitlebarBorderBottomColor: '#1f2329',
						frameBoxShadowCssValue: 'none',
					},
				},
			},
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
				// The marketing nav, in the header's otherwise-empty right-hand slot.
				// Overriding `SocialIcons` rather than `Header` keeps Starlight's
				// search box and mobile menu working untouched.
				SocialIcons: './src/components/starlight/SiteNav.astro',
				// Pagination, then the real site footer — including the Unity
				// non-affiliation line, which all 16 docs pages shipped without.
				Footer: './src/components/starlight/SiteFooter.astro',
				// The page header, as the IDE's own breadcrumb bar.
				PageTitle: './src/components/starlight/PageTitle.astro',
				// Starlight has no `defaultTheme` option; its provider reads
				// localStorage and prefers-color-scheme. The site is dark-only, so the
				// provider is replaced rather than fought.
				ThemeProvider: './src/components/starlight/ThemeProvider.astro',
			},
		}),
		react(),
		tailwind({ applyBaseStyles: false }),
	],
});
