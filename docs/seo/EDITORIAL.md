# UnityIDE editorial system and publication evidence

Prepared 2026-09-21. This record is for maintainers; it is not a public testimonial
or evidence that the site has been deployed or indexed.

## Content inventory and intent ownership

| Destination | Search intent | Status |
| --- | --- | --- |
| `/` | Unity IDE / code editor for Unity | Existing product page |
| `/features/ai/` | AI code editor for Unity | Ready as a documented product overview |
| `/compare/rider/` | UnityIDE vs Rider / Rider alternative for Unity | Ready as a source-reviewed comparison, not hands-on |
| `/compare/vscode/` | UnityIDE vs VS Code for Unity | Ready as a source-reviewed comparison, not hands-on |
| `/blog/unity-intellisense-not-working/` | Diagnose missing Unity C# completion | Draft; tutorial walkthrough unverified |
| `/blog/rename-unity-serialized-fields/` | Preserve serialized values during a field rename | Draft; Unity asset import test not run |
| `/blog/unity-ui-toolkit-query-null/` | Diagnose UQuery name/type/tree mismatches | Draft; Unity UXML query test not run |
| `/blog/unity-prefab-merge-conflicts/` | Configure and verify UnityYAMLMerge | Draft; prefab merge and reimport test not run |

No near-duplicate generic "Unity IDE" landing pages were added. Setup remains in
the existing docs. The comparison hub helps readers choose a comparison; it is
not an unsupported "best IDE" ranking. Public related links include only entries
that pass the publication filter. Drafts have no generated article routes.

## What was actually verified

Primary product/documentation pages were read for the relevant claims. The
frontmatter lists URLs and access dates for each entry. Competitor comparisons
are visibly disclosed as publisher-written and documentation-based. They make
no measured performance, relative reliability, or universal superiority claim.

The focused editorial suite passed 8 tests on 2026-09-21. It checks draft and
future-date exclusion, publication evidence requirements, substantive-update
metadata, image attribution, canonical paths, organization authorship, and
absence of invented review/rating schema. It does not test Unity behavior.

The built-site audit also passed on 2026-09-21: 34 HTML pages, 25 sitemap URLs,
three published editorial pages, and four excluded drafts. It parses the actual
HTML to check titles, descriptions, H1s, canonicals, social metadata, JSON-LD,
internal destinations, and fragment targets. An empty blog hub receives
`noindex` and is excluded from the sitemap; publishing the first guide enables
both automatically on the next build. This verifies local build output, not
Google indexing or a deployed response.

An isolated Unity 6000.3.5f2 project was prepared under `unity-samples/`. The
attempted headless execution could not acquire the required local license:
the licensing client repeatedly failed to connect and reported the missing
`com.unity.editor.headless` entitlement. No `Evidence/report.json` was produced.
This is **unverified**, not a passing runtime test. The four technical guides
therefore remain `draft: true`.

A separate existing IntelliSense verification may establish facts about the
tested UnityIDE language server. It does not, by itself, establish that every
step of the new cross-editor troubleshooting article was executed. Retain that
distinction when considering publication.

## How to publish or substantively update an entry

1. Read the rendered article and validate its sources against the current
   supported release. Recheck competitor integrations and licensing links.
2. Execute the relevant reproduction in an appropriately licensed disposable
   Unity project. Preserve exact command, Unity/IDE/package versions, OS,
   expected result, actual result, limitations, and a concise evidence record.
3. Fix or remove claims the check did not establish. The sample project covers
   narrow asset import, query matching, and independent prefab edits; it does
   not cover all migrations, Play Mode UI lifecycle, or ambiguous merges.
4. Set `verification.status: tested`, record `verification.evidence` and
   `testedVersions`, add the actual publication date, then set `draft: false`.
   Documentation-only product pages and comparisons can use `documented` but
   must retain the visible limitations notice.
5. For a later meaningful revision, add `updatedAt` and explain the change in
   `updateNote`. Do not bump freshness dates for builds or cosmetic edits.
6. Run `bun run test src/lib/editorial.test.ts`, `bun run build`,
   `bun run check:seo`, and the site's full validation. Inspect generated HTML and sitemap for the intended routes,
   metadata, heading links, and absence of draft content. Check mobile layout.

Schemas reject pending evidence for public entries and require test metadata
for a public technical guide. This is a guard against accidental publication,
not a substitute for reviewing the evidence file itself.

## Author and image policy

The author is the real publishing team, linked to `/about/`. No fictional named
reviewer, customer quote, review score, screenshot, or recording was created.
The content does not require a decorative cover image. If adding a real image,
frontmatter requires a local path, meaningful alt text, and credit; include a
source URL where relevant and verify the right to publish it. Do not describe a
mockup as a captured product run.

## Files and extension points

`src/content.config.ts` defines `blog`, `comparisons`, and `features` collections.
`editorial-schema.ts` owns metadata validation. `editorial.ts` owns the shared
publication predicate, route mapping, and Article/BreadcrumbList data.
`EditorialLayout.astro` renders sources, test scope, TOC, filtered related
entries, and setup links. It uses LandingLayout's typed metadata props.

All collection routes use the same publication predicate, including the
index and related-content consumers. Keep future feeds/search indexes on this
predicate too. A scheduled date is evaluated at build time; publication needs
a new build. No background publishing automation was added.

`scripts/lib/editorial-inventory.ts` validates the same frontmatter schema for
the sitemap's empty-hub gate and the built-output audit. It reuses Astro's
installed YAML parser. `scripts/check-seo.ts` reuses Astro's HTML parser, checks
actual output, and exits nonzero on failures. Neither script calls analytics,
submits sitemaps, or contacts a search engine.

## Repository brand audit

The repository-root brand audit still fails on four protected-resource token
counts. The coordinating review identified existing drift plus three legitimate
new D1-binding references from acquisition tracking. No protected identifiers
were renamed in the editorial work, and the baseline was not changed. Resolve
and document that baseline separately before treating the repository audit as
passed; the successful website audit does not override it.
