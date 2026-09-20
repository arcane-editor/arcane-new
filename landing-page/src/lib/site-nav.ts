/**
 * Every link that appears in site chrome, in one place.
 *
 * The Navbar and the Footer used to keep separate hardcoded copies of
 * overlapping data, and they drifted. The Footer wrote the download target as
 * `/#download`; the Navbar wrote it as `#download`. A bare fragment resolves
 * against the CURRENT document, and the only `id="download"` on the site lives
 * in `DownloadSection.astro`, which only `index.astro` mounts — so the nav's
 * primary CTA did nothing at all on /pricing, /features, /feedback and
 * /account, for as long as those pages have existed.
 *
 * Four surfaces read this file now: `Navbar.tsx`, `Footer.astro`, and the two
 * Starlight overrides that give the docs the same header and footer as the
 * rest of the site. A link cannot go stale on one of them again.
 */

export type NavLink = { label: string; href: string };

/**
 * The one download target, root-relative on purpose.
 *
 * On the home page a browser treats `/#download` as an in-page jump, so this
 * single form is correct from everywhere and there is no page-aware branch to
 * get wrong (and no SSR/hydration mismatch to introduce by trying).
 */
export const DOWNLOAD_HREF = '/#download';

/** Order mirrors the funnel: what it does, what it costs, how to use it. */
export const navLinks: NavLink[] = [
  { label: 'Features', href: '/features' },
  { label: 'Pricing', href: '/pricing' },
  { label: 'Docs', href: '/docs/' },
];

/**
 * The docs header is already inside /docs, so "Docs" would point at the page
 * you are standing on. Feedback takes the slot instead — it is the one thing a
 * reader who just failed to follow an instruction actually wants.
 */
export const docsNavLinks: NavLink[] = [
  { label: 'Features', href: '/features' },
  { label: 'Pricing', href: '/pricing' },
  { label: 'Feedback', href: '/feedback' },
];

export type FooterColumn = { title: string; links: NavLink[] };

export const footerColumns: FooterColumn[] = [
  {
    title: 'Product',
    links: [
      { label: 'Features', href: '/features' },
      { label: 'Download', href: DOWNLOAD_HREF },
      { label: 'Pricing', href: '/pricing' },
    ],
  },
  {
    title: 'Documentation',
    links: [
      { label: 'Getting started', href: '/docs/getting-started/installation/' },
      { label: 'Unity package setup', href: '/docs/getting-started/unity-extension/' },
      { label: 'All docs', href: '/docs/' },
    ],
  },
  {
    title: 'Contact',
    links: [{ label: 'Send feedback', href: '/feedback' }],
  },
];

/**
 * Privacy and Terms, in the footer's bottom bar rather than as a fifth column.
 *
 * These are the two links this file's header called out as "the two that should
 * come back, and they need real pages behind them". They do now —
 * `src/pages/privacy.astro` and `src/pages/terms.astro`.
 *
 * They sit beside the copyright line instead of in `footerColumns` for two
 * reasons: it is where a reader looks for them, and `Footer.astro` pins its
 * grid at `[2fr_1fr_1fr_1fr]`, so a fourth column would silently wrap on
 * desktop. Both footers render this array, so they cannot drift apart.
 */
export const legalLinks: NavLink[] = [
  { label: 'Privacy', href: '/privacy' },
  { label: 'Terms', href: '/terms' },
];

/**
 * Unity is a trademark of Unity Technologies. A plain non-affiliation line is
 * the standard way to use an engine's name descriptively, and it belongs on
 * every page that carries the footer — including the 16 docs pages, which
 * shipped without it until the docs got a real footer.
 */
export const TRADEMARK_NOTICE =
  'UnityIDE is an independent product and is not affiliated with, endorsed by, ' +
  'or sponsored by Unity Technologies. Unity is a trademark of Unity Technologies.';
