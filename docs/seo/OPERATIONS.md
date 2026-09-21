# UnityIDE search acquisition: launch and 90-day operations

Prepared 2026-09-21. This is an execution runbook, not a deployment record or a ranking forecast. The site, API, and editor changes exist in the working tree; remote deployment, indexing, and real-user conversion measurement must be verified separately. Use [BASELINE.md](BASELINE.md) for observed live-site evidence and [EDITORIAL.md](EDITORIAL.md) for article evidence and publication requirements.

## Outcome, audience, and working budget

The business outcome is more people successfully using UnityIDE with a Unity project. Report **identified activated users** and **unlinked activated installs** separately. A download click, account signup, first launch, and successful connection are different milestones. The primary acquisition question is which helpful pages attract people who eventually connect a project, not which page produces the largest impression count.

Serve global English-speaking Unity developers: learners, independent developers, and professional teams. Organize pages by task and decision rather than producing near-identical pages for each audience. Keep platform requirements visible: an unsupported platform visitor is not an onboarding failure to solve with more persuasive copy.

Reserve 15–25 hours weekly. A normal 20-hour week allocates 8 hours to research, reproduction and one useful content improvement; 4 to onboarding or site fixes; 3 to relevant community participation and individual outreach; 2 to measurement; and 3 to corrections, evidence capture and review. In launch weeks, move content time into deployment and measurement checks. Publish only what can be substantiated; a blocked reproduction is a reason to retain a draft.

Google describes SEO as improving discovery, comprehension and usefulness, and explicitly does not promise first-place rankings. Assess meaningful changes over weeks while keeping technical breakages on a much faster response cycle. [Google SEO Starter Guide](https://developers.google.com/search/docs/fundamentals/seo-starter-guide)

## Launch sequence and acceptance gates

The order is **migration 0025 → server → editor → site** in each environment. Use the project's existing environment and release workflows. Do not introduce a second deployment path, rename protected Cloudflare resources, or change issuers to make names look consistent.

### Prepare one reviewable release

1. Record the commit/ref, package versions, intended environment, migration name, owner, validation results, known limitations, and rollback versions in a release checklist. Preserve unrelated working-tree changes.
2. Inspect `0025_activation_acquisition.sql`. It creates `install_activations` and `user_acquisition`; it does not backfill historic acquisition or activation and does not replace `app_installs`.
3. Run server `bun run check:types` and its Vitest script `bun run test` from `arcane-server/`. Run landing `bunx tsc --noEmit`, `bun run test`, and `bun run build` from `landing-page/`; include the editorial and generated-HTML SEO checks currently present in the package. Run `bun run verify` from `editor/`. A skipped or blocked runtime check remains unverified; copy the actual outcome into the release record.
4. Confirm the three documented commercial pages pass publication checks. Keep all four technical guides drafted until their specific reproductions pass. A general editor test suite does not verify every new tutorial instruction.
5. Inspect the built pages on mobile and desktop, keyboard navigation, page titles/descriptions, canonical URLs, visible source notices, related links and setup CTAs. Confirm draft article paths are absent from generated output and sitemap. Compare rendered HTML and initial HTML where client rendering is involved.

### Validate in the development environment

| Step | Action | Evidence required before moving on |
| --- | --- | --- |
| 1. Database | Apply migration 0025 to the development database through the existing migration workflow. | Both new tables and expected indexes exist; old install and account records remain intact. |
| 2. API | Deploy the matching development server. | Register/activation/association contract works; wrong proof is refused; invalid or revoked auth is refused; existing `/v1/install` still behaves as before. |
| 3. Editor | Build the instrumented development editor and open a disposable supported Unity project. | Real compatible bridge connection produces one milestone; another window, reconnect, restart and retry produce no second activation. A failed or mismatched connection produces none. |
| 4. Website | Deploy the matching development website. | Admin report loads after admin sign-in; tables, date controls and CSV export work; public metadata and content render; no draft guide is published. |
| 5. Failure cases | Repeat with network loss before reporting, then reconnect; sign in after anonymous activation. | Pending events survive and are acknowledged later; authenticated identity is associated once; login is not required to record anonymous activation. |
| 6. Channel separation | Examine the development records and report behavior. | `dev` records do not enter the release-only report. The development report may correctly be empty. Do not send fake release-channel conversions merely to populate it. |

Browser acquisition capture deliberately runs only on `unityide.app` and `www.unityide.app`, not the development host. Validate the pure capture/serialization behavior with local tests in development. Validate actual live-host capture only after approved live rollout, using a fresh disposable browser profile and a controlled internal account whose records can be recognized in the release log. Never manufacture an organic search visit; use a clearly labeled internal campaign such as `utm_source=internal_qa&utm_medium=test`. Separately confirm that GPC/DNT or blocked storage leaves capture absent without breaking signup.

### Obtain explicit approval for the live rollout

Repository instructions require explicit confirmation for production operations. Present the tested ref, target environments, migration, release artifacts, proposed deployment sequence and rollback plan for approval. This runbook is not that approval, and completing development checks is not authorization to deploy.

After approval, repeat migration → server → editor → site. Record the first release version containing instrumentation and the rollout timestamp in UTC. Use that date as the earliest defensible start of comparable activation cohorts. Publish the three documented commercial pages with the site; leave the four guides unpublished.

### Live acceptance and rollback

- Verify public pages return the intended status, content, canonical host and index directives; check apex/www and HTTP/HTTPS behavior. Inspect robots and sitemap delivery. Confirm account/auth routes stay excluded and no sensitive URL is submitted.
- Exercise one first launch and real project connection, then repeated connection and later sign-in. Confirm one activation, one immutable account association, and no proof or account identifier in the public response. Validate the admin report and exported CSV against those controlled records.
- Confirm a ordinary signup without acquisition remains unattributed; acquisition is optional and cannot block signup. Existing Reddit attribution must still work independently.
- Check server errors and rejected registration/activation requests after rollout. A credential mismatch must not be “fixed” by overwriting pinned proofs or rebinding an install to a different account.
- If the site has a regression, restore the previous static deployment. If the API has a regression, restore the previous compatible server version; preserve additive tables and collected records. The editor outbox can retry pending reporting after service recovery. Do not delete state files or database tables as a routine rollback.
- Record incomplete gates plainly. No deploy, indexing result, live activation result, or runtime article check is complete merely because this checklist exists.

## Search-console setup and index triage

Confirm ownership/access to the `unityide.app` domain property in Google Search Console and the corresponding Bing Webmaster Tools site. The historical cutover runbook left Search Console work outstanding; do not infer current account state from that dated note. Save who owns access and where the exports are stored without copying account credentials into the repository.

After approved publication:

1. Submit the actual live sitemap URL, `https://unityide.app/sitemap-index.xml`, and check the child sitemap responses. Compare submitted URLs with the published content inventory.
2. Inspect `/`, `/features/ai/`, `/compare/rider/`, `/compare/vscode/`, and the installation docs. Save indexing status, crawl date, user-declared canonical and Google-selected canonical. A browser 200 is not proof of indexing.
3. Use URL Inspection to request recrawling of a small number of important changed pages. Submission is a discovery request, not a guarantee; do not repeatedly resubmit the same URL expecting faster results. [Google recrawl guidance](https://developers.google.com/search/docs/crawling-indexing/ask-google-to-recrawl)
4. For an excluded page, first determine whether it is intentionally excluded, unavailable, redirected, blocked from crawling, marked noindex, canonicalized elsewhere, or crawled without being selected for indexing. Fix the demonstrated cause; do not rewrite every title in response to one status.
5. Validate structured data against the visible content. Do not add invented ratings, hidden FAQs, or a new schema type as a ranking promise. Search appearance eligibility and actual display are separate. [Google structured-data guidance](https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data)

### The old Arcane domain is a separate decision

The [cutover runbook](../unityide-cutover-runbook.md) deliberately detached the old domain. This work does not silently reverse that decision. Inventory valuable old public URLs and their current status, referral traffic and genuine incoming links. Present a separate proposed one-to-one redirect map for relevant public marketing/docs URLs, with ownership and operational impact, before requesting approval. Do not redirect every retired URL to the homepage or restore retired API/release infrastructure as part of an SEO fix.

If an approved site move uses redirects, follow Google's current migration process, including verification, URL mapping and monitoring; decide whether its Change of Address workflow applies only after the required setup exists. [Google site-move guidance](https://developers.google.com/search/docs/crawling-indexing/site-move-with-url-changes)

## Dashboard dictionary and interpretation

Open the **Growth** tab in the existing admin panel. The component defaults to the last 28 calendar days including today. The UI uses inclusive “From” and “Through” dates; the API accepts inclusive `from` and exclusive `to` in UTC, up to 366 days. The API's own no-parameter default is 84 days, so use explicit dates when comparing exports.

Endpoint: `GET /v1/admin/acquisition-report?from=YYYY-MM-DD&to=YYYY-MM-DD`, using existing admin authorization. Never place an admin token in a URL, report CSV, screenshot or command pasted into a shared document.

| Metric | System of record / calculation | What it can and cannot answer |
| --- | --- | --- |
| Search impressions | GSC Search results, filtered by query/page/country/device as needed | Visibility in reported Google results. Not page visits or unique people. |
| Search clicks | GSC Search results | Google search visits initiated from results. Not every search engine and not an install. |
| Search CTR | GSC clicks / impressions for the same filter and period | Use with position, query intent and result context. A sitewide CTR change can reflect a changed query mix. |
| Average position | GSC definition for the chosen query/page filters | A diagnostic trend, not a universal rank checked from one browser. |
| Website/download event | Existing browser measurement and custom GTM event `download`, property `downloadPlatform` | A click on a download link. Verify the configured destination before claiming a report exists in GA4 or another account. Blocking and repeat clicks affect counts. |
| First launches | `weekly[].firstLaunches` from release-channel `app_installs` | Existing first-run ping. It can run even if editor boot fails; it is not successful onboarding. |
| Activated installs | `weekly[].activatedInstalls` | First reported compatible bridge connection for a recognized, successfully opened Unity root. Deduplicated per install UUID. No project data leaves the app. |
| Identified activated users | `weekly[].identifiedActivatedUsers` | First activation per server-authenticated account across its associated installs. An anonymous install is not assumed to be a unique person. |
| Unlinked activated installs | `weekly[].unlinkedActivatedInstalls` | Activated install records currently without an associated account. Do not add this count to account counts and label the result “unique users.” |
| Measurement enrollments | `weekly[].measurementEnrollments` | Proof enrollment, performed during activation reporting. Not a denominator for activation rate or an instrumentation-coverage count. |
| Known-source coverage | Source rows other than `unattributed`, divided by identified activated users in the report | Coverage among identified users only. It says nothing about the acquisition source of unlinked installs. |
| Organic-attributed identified activations | Sum `acquisition[].identifiedActivatedUsers` where `medium = organic` | Saved first-touch signup attribution joined to an account and activation. No per-keyword attribution and no deterministic attribution for every anonymous download. |
| Referral-attributed identified activations | The corresponding acquisition rows with `medium = referral` | A saved referring hostname; not an endorsement and not necessarily a backlink discovered by a crawler. |
| Mature seven-day denominator | `mature7DayCohort.eligibleFirstLaunches` | Release first-launch receipts in the requested date range whose full seven-day window has elapsed. Includes unactivated installs. |
| Reported activation within seven days | `activatedWithin7Days / eligibleFirstLaunches` | Receipt-based install cohort rate. Do not use a week’s activations divided by that week’s launches as a substitute. Show numerator and denominator with the percentage. |
| Receipt-order gaps | `activationReceiptOrderGaps` | Activation arrived before a separately retried first-launch ping. Timing is uncertain for these installs; they remain in the denominator but do not count as established within-seven-day receipts. |

Use Google's definitions when reading Search Console fields rather than mixing them with website analytics definitions. [Search Console Performance report](https://support.google.com/webmasters/answer/7576553)

### Measurement limits that must stay visible

- The report is **release channel only**. `dev` and unknown channels are excluded. A development rollout cannot establish release acquisition performance.
- New events are not backfilled. Start comparable cohorts after the instrumented editor release; record rollout version/date next to each comparison. Older versions can continue creating first-launch records without activation reporting.
- Timestamps are **server receipt times**, not the original offline event time. Offline retry can shift a week or move a connection outside the seven-day window. The explicit receipt-order-gap count exposes one additional ordering failure.
- Later sign-in can associate an earlier anonymous activation, changing historic identified/unlinked totals and source attribution. Keep export timestamps and compare like-for-like snapshots. Account deletion can also change identifiable counts.
- Acquisition is saved at signup and joined only when an install is authenticated. Reinstallations, multiple devices and shared machines affect install/user relationships. First authenticated ownership is retained; signing into a second account does not overwrite it.
- Browser capture retains first touch for up to 30 days. Recognized paid click markers are classified as paid; known search referrers become organic; unknown search hosts remain referrals; an absent referrer is direct/none; absent account acquisition stays unattributed. Do not combine those categories into organic.
- GSC queries and account activations cannot be joined to individual people. Use page/topic aggregates to investigate likely contribution, explicitly labeled as an inference.
- Public install/activation reporting is client-reported, not remote attestation. A proof protects an enrolled install against later replacement; legacy enrollment is trust on first use. These records are measurement, never authorization for access or billing.

### Weekly report ritual

Every Monday, spend two hours on the latest complete available search period and a separately labeled mature activation cohort. Keep the timezone and date filters consistent across exports.

1. Export GSC page/query data for 28 days and the preceding 28 days. Split branded (`UnityIDE`, unambiguous Arcane legacy variants) from nonbranded demand; manually review ambiguous `unity ide` queries rather than declaring all of them branded.
2. Export the admin report for matching calendar dates, plus a mature cohort ending at least seven days before the current date. Preserve the exact `from`, exclusive `to`, export timestamp and instrumented version/date.
3. Record the five most relevant landing pages: search clicks, representative query intent, saved-source identified activations where available, corrections, and next action. Do not manufacture sessions or conversion rates for pages lacking a trustworthy denominator.
4. Inspect acquisition coverage and unlinked counts before interpreting a drop in organic-attributed users. Check missing capture, storage blocking, privacy signals and login timing; do not solve missing attribution by fingerprinting.
5. Choose one primary change for the next week. Keep a change log with page, hypothesis, change date, primary measure and review date. Avoid changing a title, introduction, CTA and audience simultaneously when trying to learn which change helped.

Operational targets for the first 90 days: every intended public URL has reviewed metadata and a working setup path; no drafted guide leaks into public routes/sitemap; every published technical guide has recorded runtime evidence; weekly reporting runs consistently; activation events deduplicate correctly. Establish numeric growth targets only after two to four weeks of usable post-rollout baseline. Zero rankings or a fixed “top 3 by day 90” promise is not an acceptance criterion.

## Topic ownership, reader task, and CTA map

These query families are targeting hypotheses, not measured search volumes. Validate demand with observed GSC queries and reader questions; do not fabricate keyword difficulty or traffic estimates.

| Page | Reader task / query family | Primary next step | Supporting link | Current publication state |
| --- | --- | --- | --- | --- |
| `/` | Find a Unity IDE / code editor for Unity | `/#download` | Installation and platform requirements | Existing product page; site edits require rollout |
| `/features/ai/` | Evaluate AI-assisted Unity coding | Installation guide, then Unity package setup | AI modes, connection guide, pricing | Documented overview ready for publication review |
| `/compare/rider/` | Compare Rider with UnityIDE | Evaluate one disposable project | Installation, AI feature page, VS Code comparison | Documentation-based comparison ready; no hands-on benchmark claimed |
| `/compare/vscode/` | Compare a configured VS Code setup with UnityIDE | Follow setup requirements and evaluate one project | Microsoft setup source, installation, AI feature page | Documentation-based comparison ready; no hands-on benchmark claimed |
| `/docs/getting-started/installation/` | Install successfully on a supported platform | Install the application and connect its Unity package | Unity extension and first-project guides | Existing support documentation; verify current release accuracy |
| `/blog/unity-intellisense-not-working/` | Restore Unity C# completion | Complete the diagnostic sequence | Relevant editor setup, then installation if evaluation is appropriate | Draft; cross-editor walkthrough unverified |
| `/blog/rename-unity-serialized-fields/` | Preserve saved serialized values when renaming | Reproduce and verify the safe change | Asset/GUID docs and relevant product overview | Draft; asset import/runtime evidence missing |
| `/blog/unity-ui-toolkit-query-null/` | Resolve UQuery name/type/tree mismatch | Reproduce the failing query and verify the fix | AI feature page and connection guide | Draft; UXML query runtime evidence missing |
| `/blog/unity-prefab-merge-conflicts/` | Handle scene/prefab merge conflicts | Test the merge workflow in a disposable project | Relevant feature/asset documentation | Draft; merge and reimport verification missing |

The shared editorial layout already includes source links, the publisher identity, visible evidence scope, filtered related entries, installation/package setup links and a correction link. Keep those instead of burying the answer under a signup gate. Do not link publicly to a guide that is still excluded by the publication filter.

## Twelve-week action schedule

Weeks start relative to the approved rollout, not automatically on the date this file was written. A blocked prerequisite moves the dependent work; it does not justify skipping evidence.

| Week | Work within 15–25 hours | Deliverable / exit condition |
| --- | --- | --- |
| 1 | Finish development gates and release record; confirm console ownership; inspect index/canonical failures; resolve tutorial licensing access in a disposable test environment. | Reviewable deployment packet, index inventory and owner list. No unsupported guide is published. |
| 2 | After approval, execute staged live rollout; inspect the three commercial URLs and setup funnel; submit sitemap; capture controlled acquisition/activation evidence. | Dated rollout version and first real report. Clearly separate controlled QA records from business outcomes. |
| 3 | Test and refine the IntelliSense draft on explicitly named Unity/IDE/package versions; capture source screenshots/log excerpts that contain no private project data. | Publish only if its walkthrough passes editorial gates; otherwise fix the reproduction and keep draft status. |
| 4 | Test the serialized-field rename guide with a saved non-default value and reopened project; record before/after asset evidence. Begin two relevant, individually reviewed outreach drafts. | One substantiated article or a documented blocker; first 28-day search/report review when data exists. |
| 5 | Test UXML query mismatches and the exact repair, including the scope of any Play Mode claim. Improve installation language using actual failed-onboarding reports. | Verified guide and one demonstrated onboarding correction, or retained draft with specific missing evidence. |
| 6 | Run the prefab merge case with independent edits, merge, reimport and inspection; distinguish automatic merge success from ambiguous conflicts needing human resolution. | Evidence-qualified guide; no “safe for every prefab conflict” claim. |
| 7 | Review indexed page/query pairs and internal links. Expand the best-supported article’s missing case rather than publishing a near duplicate. Inspect slow mobile pages with real measurements. | One content improvement and one measured technical fix if justified. |
| 8 | Run a controlled reader evaluation of a recurrent Unity task. Ask for permission before publishing feedback; retain critical findings. Refresh comparisons against current primary documentation. | A versioned evaluation record; source corrections; no invented testimonial or benchmark. |
| 9 | Follow up once with relevant reviewers who have not opted out. Answer genuine Unity questions with a useful explanation and an affiliation disclosure where a product link is appropriate. | Outreach log with relevance, responses and corrections; no link-volume quota. |
| 10 | Examine pages with impressions but weak response for the actual query/position mix. Revise one title or opening paragraph where intent is mismatched; inspect CTA/setup failures separately. | Logged hypothesis, single material page change and review date. |
| 11 | Build the next content brief from an observed query or repeated support issue. Reuse the evidence-gated article system; assess whether an existing page should answer it instead. | Tested or research-ready brief with explicit intent owner, not a generated-content backlog. |
| 12 | Compare post-rollout mature cohorts, acquisition coverage and nonbranded search trends; review guide accuracy and unresolved technical debt. | Written 90-day assessment: what changed, what is attributable, what remains uncertain, and the next three prioritized actions. |

If there is no usable runtime license after week 2, prioritize improving the three documented pages, setup docs and measurement while arranging legitimate test access. The current four guide drafts remain blocked by missing runtime evidence; the prepared sample project is not a completed test. See [EDITORIAL.md](EDITORIAL.md) and [sample verification instructions](unity-samples/README.md).

### Months four through six

- **Month 4:** Deepen the topic with the strongest combination of demonstrated reader need and relevant activations. Add one evidence-backed case study or technical guide every one to two weeks only when the work fits the budget. Improve the existing pages before expanding the number of URLs.
- **Month 5:** Reproduce the highest-value workflows across another supported Unity version or platform. Publish the actual limits and failure cases. Collaborate with a credible teacher/tool author on a genuinely useful example if both parties agree; disclose sponsorship where applicable.
- **Month 6:** Re-audit the index inventory, canonical behavior, mobile experience and source dates. Consolidate overlapping pages where the evidence shows they answer the same task; use reviewed URL mappings for any removal. Reassess audience and spending from actual demand and activation, not assumed keyword volume.

## Distribution and outreach drafts — not sent

Maintain a small list of relevant Unity educators, newsletter editors, maintainers and community threads. Prefer someone whose current work directly relates to the exact example. Check the recipient/channel’s publication and self-promotion rules before drafting. These templates are not authorization to send messages or publish community posts.

### Educator or newsletter editor

**Subject:** A reproducible Unity example for [specific topic]

> Hi [name], I build UnityIDE. Your [specific lesson/article] covers [relevant problem]. We prepared a [guide/example] showing [narrow outcome], with [actual tested versions] and the failure cases we could reproduce: [public URL]. It may be useful to readers working through that problem. If you spot an error or a missing case, I would appreciate the correction. No link or mention is expected.

Use this only after the guide is public and tested. Replace every placeholder with verified information. Do not describe a documentation-based comparison as a tested example.

### Product reviewer

**Subject:** UnityIDE for a specific Unity workflow you cover

> Hi [name], I build UnityIDE, an independent IDE for Unity developers. Your work on [specific workflow] prompted this note. Our documented setup and limits are here: [URL]. If you choose to evaluate it, a useful trial is [one bounded task] on a disposable project. I can answer setup questions; any review should reflect your own result. Our own comparison is documentation-based and clearly says so.

Do not request a favorable score, guaranteed backlink, undisclosed paid placement, or a review of functionality the release does not ship.

### Community answer outline

> [Explain the likely cause in the question’s actual version/configuration.] Try [two or three precise checks], and confirm [observable result]. [Link a primary source where it helps.] Disclosure: I work on UnityIDE. We also documented [the same narrow issue] here [public URL], including [verified limitation].

The answer must be useful without clicking the product link. Omit the link if the community prohibits self-promotion or the guide does not directly answer the question. Do not bulk-post variations of the same answer.

### Before a human sends or publishes

- Verify recipient relevance, channel rules, public URL status and all factual claims.
- Disclose the UnityIDE affiliation; disclose any actual sponsorship. Keep a record of permission for quotes, screenshots, names or case-study participation.
- Check that the destination delivers the promised example and has a relevant setup CTA. A four-guide draft URL must not be used as a public destination.
- Use coarse campaign labels for owned outbound links if measurement is useful. The current acquisition schema stores source, medium, landing pathname and referring hostname; it does not retain campaign names or person-specific tracking IDs.
- Record sent date only after a real send, plus result/correction and next step. Follow up at most once when appropriate; stop on rejection or opt-out. No automated outreach has been created.

## Privacy and access checklist

The implemented browser record stores first-touch source, medium, public landing pathname and optional referrer hostname for up to 30 days. It excludes search terms, query strings and referrer paths; capture respects Global Privacy Control and Do Not Track. Auth/account URLs do not become acquisition landing pages. Signup may carry this minimal record to the existing account flow. Read the current [privacy policy source](../../landing-page/src/pages/privacy.astro) before changing the data model or retention statement.

Activation shares the existing install UUID and retains a separate random proof, OS, application version and release channel. Local path checks establish that the matching Unity root connected; project paths/names/content, auth callback URLs and bearer credentials are not included in the event payload. The proof is hashed server-side and is not exposed in report responses or exports.

Restrict growth exports to existing authorized admins. The report contains aggregate acquisition/milestone counts rather than emails or project data. Do not add raw user identifiers, proofs or secrets to the weekly worksheet. Account acquisition is deleted with its account; historical activation records can become unlinked. Installation-level retention and deletion requests should follow the published policy and support process, not an assumed automatic TTL that the code does not implement.

## Report files and CSV templates

The admin **Export CSV** action downloads one CSV with `weekly`, `acquisition`, `mature_7_day_cohort`, and `note` rows. Preserve it unedited as the snapshot; the filename includes the selected dates. Its core columns are:

```csv
section,from_utc_inclusive,to_utc_exclusive,week_start_utc,source,medium,landing_path,first_launches,activated_installs,identified_activated_users,unlinked_activated_installs,measurement_enrollments,mature_first_launches,reported_activation_within_7_days,note
```

Use this separate human-maintained weekly summary header; leave unavailable fields blank rather than entering fabricated zeroes:

```csv
exported_at_utc,period_from_utc,period_to_exclusive_utc,instrumented_editor_version,instrumentation_rollout_utc,gsc_nonbranded_impressions,gsc_nonbranded_clicks,gsc_branded_clicks,identified_activated_users,organic_attributed_identified_activations,referral_attributed_identified_activations,unlinked_activated_installs,known_source_identified_users,unattributed_identified_users,mature_first_launches,reported_activation_within_7_days,activation_receipt_order_gaps,pages_published,pages_updated,primary_change,next_review_date,limitations
```

Keep a per-page review sheet with this header:

```csv
period_from_utc,period_to_exclusive_utc,page_path,intent_owner,publication_status,gsc_clicks,gsc_impressions,representative_queries,identified_activations_by_saved_landing_page,evidence_reference,change_made,review_date
```

Do not divide saved landing-page activations by GSC clicks and present the result as an exact user funnel: attribution windows, account association, consent/storage behavior, cross-device use and reporting times differ. Label comparisons as aggregate diagnostic evidence.

## Decision rules for the weekly review

| Observed pattern | Next action |
| --- | --- |
| Intended URL unavailable, blocked, incorrectly noindexed or canonicalized elsewhere | Fix the demonstrated technical cause before writing another article. |
| Page indexed with relevant impressions, few clicks | Inspect actual queries, positions and result wording; test a truthful intent-matched title/description. |
| Page receives relevant visitors but setup questions repeat | Improve requirements and setup instructions; verify the exact failed step. |
| First launches rise but mature activation does not | Investigate supported OS/version, bridge setup and product failures; content volume is not the first remedy. |
| Organic-attributed counts drop while coverage also drops | Investigate attribution collection and login coverage before declaring SEO failure. |
| Guide reproduction fails or a reader disproves a claim | Correct the claim, qualify the limitation, or return the guide to draft; record a substantive update when republishing. |
| Little data after a short period | Keep the baseline, inspect discovery/indexing and use interviews/support evidence. Do not assert a statistically meaningful winner. |
| A topic earns useful visits and successful user outcomes | Improve its evidence, examples and internal links; prepare the next distinct reader task in the same area. |
