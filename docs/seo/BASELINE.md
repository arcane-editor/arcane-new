# Search baseline — 21 September 2026

## Verified Google Search Console access

The `unityide.app` Domain property was added to the marketing account and ownership was automatically verified through an existing domain-provider record. No DNS records or credentials were changed. The sitemap index `https://unityide.app/sitemap-index.xml` was submitted successfully; Search Console displayed **Success**, submitted/read 21 September 2026, with zero discovered pages immediately after submission. That initial zero is a processing state, not evidence that the site has no indexed pages.

URL Inspection returned **URL is on Google / Page is indexed** for all five priority URLs. For each, crawling and indexing were allowed, the page fetch succeeded, Googlebot smartphone was used, and the Google-selected canonical was the inspected URL, matching the declared canonical.

| Inspected URL | Last crawl, as displayed by Search Console | Sitemap discovery note |
| --- | --- | --- |
| `https://unityide.app/` | 16 September 2026, 08:29:28 | No referring sitemaps detected |
| `https://unityide.app/features/` | 18 September 2026, 10:30:33 | Temporary processing error |
| `https://unityide.app/pricing/` | 21 September 2026, 14:23:44 | No referring sitemaps detected |
| `https://unityide.app/docs/getting-started/installation/` | 14 September 2026, 21:49:17 | No referring sitemaps detected |
| `https://unityide.app/docs/unity-integration/asset-pipeline/` | 1 September 2026, 15:42:22 | No referring sitemaps detected |

Times above retain the UI display; its timezone was not independently established. These are stored-index results, not live-test results. No indexing requests were submitted for the unchanged live pages.

- **Manual actions:** No issues detected.
- **Security issues:** No issues detected.
- **Performance:** Processing data, “please check again in a day or so”; queries, clicks and impressions unavailable. No ranking/traffic export can yet be recorded.
- **Page Indexing overview:** Processing data when the property was opened. The five URL inspections are a sample, not a complete inventory.
- **Crawl stats:** No data available yet, report disabled.
- **Settings robots report:** No robots.txt file, report disabled on the newly added property. Earlier direct site checks found the public robots file accessible; recheck this report after processing rather than treating its initial state as an HTTP failure.

The observed problem is therefore not complete absence from Google's index. Query relevance, search impressions, positions and click-through rate remain unmeasured until reporting becomes available.

## Bing status

Bing Webmaster Tools was opened and the marketing Google account selected. Its Google consent screen requests the account's name, profile picture and email. Automatic approval review blocked continuing without specific user approval for this cross-service disclosure. Approval has been requested; no Bing property verification or sitemap submission has been completed.

## Adoption and performance baseline

The new first-successful-connection instrumentation, account acquisition association and protected Growth report are local changes. They have not been deployed and have no historical activation data. Existing download events remain separate. Do not populate activation metrics from downloads, first launches or estimates.

Search Console's Core Web Vitals report says **not enough usage data in the last 90 days** for both mobile and desktop. Field percentiles are unavailable; a repeatable laboratory performance baseline has not yet been collected. Layout checks are not performance measurements. No ranking gain, speed improvement or 90-day growth percentage is claimed.

## Next data collection

1. Return to the [verified property](https://search.google.com/search-console?resource_id=sc-domain%3Aunityide.app) after initial processing. Export query/page/country/device metrics for a complete 28-day window if available.
2. Separate branded queries matching UnityIDE / Unity IDE brand spelling from nonbranded workflow queries; manually review ambiguous “Unity IDE” category queries rather than discarding the whole category as branded.
3. Record selected canonical and indexing status for the three new public content pages after an approved deployment. Recheck sitemap discovery, staging `noindex`, redirects and real 404 responses live.
4. Once the activation pipeline is deployed, use the protected Growth report for observed install/user outcomes. Report acquisition coverage and unknown attribution alongside totals.
5. Keep Search Console query metrics and website conversions as distinct reports; join to product activation only through the implemented signup/account association. The plan's report template is in [OPERATIONS.md](OPERATIONS.md).
