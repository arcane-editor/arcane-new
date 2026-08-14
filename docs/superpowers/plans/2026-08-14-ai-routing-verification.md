# AI Routing — Pre-Launch Verification

## Blocking

- [ ] **Dashboard rates.** Confirm `openai/gpt-5.6-luna` and `xai/grok-4.6`
      against the Cloudflare dashboard. The plan uses vendor list prices;
      Cloudflare serves some third-party models via resellers at a multiple
      (`deepseek-v4-pro` is ~4x DeepSeek's own rate). If they differ, update
      MODEL_CATALOG and re-run `test/costs.test.ts`.
- [ ] **Luna long-context cached rate.** MODEL_CATALOG assumes $0.04 above
      272k. Confirm or correct.
- [ ] **Grok sub-threshold cached rate.** MODEL_CATALOG charges cache hits at
      the full $2.00 input rate. Confirm whether a discount exists.
- [ ] **Inline reasoning tokens.** Send 20 FIM requests to
      `@cf/zai-org/glm-4.7-flash` and measure p50/p95 latency and output token
      counts. If it emits reasoning tokens, tab completion is unusable —
      roll back to `@cf/qwen/qwen2.5-coder-32b-instruct` (already in the
      catalog) and re-derive INLINE_DAILY_CAP from the higher per-suggestion
      cost.

## Before scaling

- [ ] **Workers AI rate limits.** Confirm the per-account request/minute limit
      for `@cf/zai-org/glm-5.2` and whether it is raisable.
- [ ] **Luna agentic quality.** Run `editor/tooling/unity-eval/presets.ts`
      against `openai/gpt-5.6-luna` and compare to the committed baselines.
      Luna ranks #36 on agentic benchmarks and it is the default tier.
- [ ] **Prompt caching observability.** Confirm `cacheReadTokens` is non-zero
      on a repeated-prefix request. If it stays 0, cached-rate savings are
      invisible to metering and debits over-charge relative to true cost.

## Secrets

- [ ] Rotate the leaked MiniMax key in `editor/.env` (outstanding from the
      2026-08-03 runbook — deleting the code path does not revoke the key).
- [ ] Delete Worker secrets `MINIMAX_API_KEY`, `MOONSHOT_API_KEY`, and
      `CF_ACCOUNT_ID` if unused elsewhere.

## Billing

- [ ] **Top-up pack Dodo products — do NOT create new ones by default.** The
      plan originally called for renaming `topup_1000`/`topup_5000` to
      `topup_1600`/`topup_7500` and creating matching Dodo products under
      `DODO_PRODUCT_TOPUP_1600` / `_7500`. That was deliberately reversed
      during implementation (Ruling 2 — see "Top-up pack ids intentionally
      kept" under **Billing / cost** below): the pack ids and their
      `DODO_PRODUCT_TOPUP_1000` / `DODO_PRODUCT_TOPUP_5000` env vars are
      unchanged and still point at the live provisioned Dodo products — only
      the `credits` each pack pays out changed (1000→1600 for $16, 5000→7500
      for $75). No Dodo Dashboard action is required for launch. Only
      provision `topup_1600`/`topup_7500` products if the owner later
      chooses to do a cosmetic Dodo-side rename.
- [ ] Confirm existing subscribers receive the new grant at renewal, not
      immediately.

## End-to-end

- [ ] Send a real chat turn at each tier and confirm the model in
      `request_logs` matches `INTENSITY_CONFIG`.
- [ ] Confirm a Free account gets 403 `tier_not_available` on Deep Think.
- [ ] Confirm an older editor build sending `super` still works.

---

## Left undone

- [ ] **Task 11 was deliberately skipped.**
      `editor/src/features/ai-panel/components/EffortSelector.tsx` still
      renders four effort levels including `Extra High` (`super`), because the
      file holds uncommitted work belonging to the repository owner. To
      finish: reduce `LEVELS` from 4 entries to 3 (drop the `super` entry),
      relabel `low`→`Standard`, `mid`→`Deep Think`, `high`→`Max`, change the
      bar renderer from `[1,2,3,4].map` to `[1,2,3].map`, and confirm the
      fallback resolves to `low`. Descriptions: Standard "Day-to-day coding",
      Deep Think "Extended reasoning for tricky problems", Max "Maximum
      capability for complex work". Until this lands, `bun run dev` (no `tsc`
      gate) can still emit a runtime `'super'`, which now falls through
      `normalizeEffort` to `'mid'` — a turn cap of 16 instead of the old 20.
      Harmless, but wrong.

---

## Deferred findings from implementation

Pulled from the Tasks 1-13 execution ledger
(`.superpowers/sdd/2026-08-14-ai-routing-and-pricing/progress.md`) so they are
not lost once that workspace is cleaned up. Items marked **(resolved)** were
verified against the current `arcane-server/` source while writing this
checklist; everything else is still open as recorded.

### Billing / cost

- [ ] **Top-up pack ids intentionally kept (Ruling 2).** The plan called for
      renaming `topup_1000`/`topup_5000` to `topup_1600`/`topup_7500` along
      with their `DODO_PRODUCT_TOPUP_*` env vars. Those env vars carry LIVE
      provisioned Dodo product ids in `wrangler.toml`
      (`pdt_0NkmTqYT7iVPq8SPBf7n9`, `pdt_0NkmTqZeNlpTNdXx4fGlx`) and are
      referenced in `src/types.ts` and `test/billing-webhook.test.ts`.
      Renaming would orphan real products and needs an owner-gated Dodo
      change. Decision made: keep the ids and env var names, change only
      `credits` (1000→1600, 5000→7500) so the price × 100 rule holds. No
      action needed unless the owner wants to do the Dodo-side rename later.
- [ ] **`estimateCost` computed twice per `recordUsage` call** (once for
      cost, once inside `billedMicro`) — a deliberate tradeoff made in Task 3
      for `billedMicro`'s independent testability. Not a bug; flagged in case
      it shows up in a profile.
- [ ] **Double D1 read on the chat gate path (Ruling 8, parked).**
      `chat.ts:78` fetches `getUserBillingRow` for the tier gate, then
      `checkAiBudget` → `refreshAndGetBalance` (`credits.ts:23`) fetches it
      again — two D1 reads per chat request, including for paid users. Real,
      but it's a latency/cost issue, not a correctness one. Fixing it changes
      `checkAiBudget`'s signature across all 4 AI routes to save one cheap D1
      read; nothing downstream depends on the current shape.
- [ ] **Sequential awaits in `inline-allowance.ts`.** `getUserBillingRow` and
      `getInlineSpend` are awaited sequentially at `inline-allowance.ts:39,43`
      even though they're independent; `Promise.all` would save one D1
      round-trip per inline (tab-completion) request.

### Routing

- [ ] **`ALLOWED_TIERS` typed as `string[]`**, not a `'low'|'mid'|'high'`
      union (`tiers.ts:44`). A typo'd tier name would type-check silently.
      Verbatim from the brief; tighten the type when convenient.
- [ ] **Default-intensity fallback unified (Ruling 5) — (resolved).**
      `chat.ts:26` used to hardcode `getIntensityConfig('mid')` as the
      no-level fallback, contradicting `DEFAULT_INTENSITY = 'low'` and the
      spec's "Standard is auto-selected." Combined with Task 6's gate, a
      free user sending no level would have resolved to `'mid'` for the
      model while being gated on `'low'`. Fixed in Task 6: both the gate and
      model resolution now read `DEFAULT_INTENSITY` — confirmed in
      `chat.ts:22,47` (`getIntensityConfig(tier)?.model ?? getIntensityConfig(DEFAULT_INTENSITY)!.model`,
      `body.metadata?.reasoningLevel ?? DEFAULT_INTENSITY`).
- [ ] **`DEFAULT_INTENSITY` unused until wired — (resolved).** Task 4
      exported `DEFAULT_INTENSITY` before anything consumed it; Task 6 wired
      it into `chat.ts` (see above), so it's live today.
- [ ] **`skipCache` silently dropped if `CF_AI_GATEWAY_ID` is ever unset.**
      `llm-router.ts:36` only builds the gateway object when the env var is
      truthy; without it, the SDK falls back to the account default gateway,
      which has a real cache. Not live today — the var is set in prod and
      dev, empty only in `wrangler.test.toml:19`. Worth a guard or a startup
      assertion before it becomes live somewhere unexpected.
- [ ] **Two independent `'super'→'high'` normalizations** exist
      (`tiers.ts:53` and `plans.ts:48`) that must stay in agreement — they do
      today, but nothing enforces it if one changes without the other.

### Tests

- [ ] **Cross-task test ordering (Ruling 1) — (resolved).** Task 7's test
      imports `utcMonthKey` from `inline-allowance.ts`, a symbol Task 8
      creates. Resolved by executing Task 7 and Task 8 strictly in that order
      and moving the `utcMonthKey` assertion out of Task 7's test into
      Task 8's, where the symbol is actually defined.
- [ ] **`estimateCost` clamp edge cases untested.** `cachedTokens >
      inputTokens` and negative token counts have no test; the clamp at
      `costs.ts:171-172` is unverified. Inherited from the brief's fixture.
- [ ] **`billedMicro` import placement.** `test/usage.test.ts:105` imports it
      mid-file instead of with the top-of-file imports. Cosmetic.
- [ ] **Unused import in `test/usage.test.ts:6`.** `usdToMicro` is imported
      but no longer used (`noUnusedLocals` is `false`, so CI doesn't catch
      it).
- [ ] **Plan-mandated test deletions restored (Ruling 6) — (resolved).** The
      plan's Task 5 Step 1 prescribed a whole-file replacement of
      `test/llm-router.test.ts` that would have deleted 3 `convertMessages`
      null-content regression tests (guarding a real production bug —
      `content: null` is OpenAI's convention for a tool-call-only assistant
      turn, and `typeof null === 'object'` sends it down the array branch and
      throws, 500-ing the rest of the conversation) and all 5
      `streamCompletion` generator tests, which would have left the function
      Task 5 rewrote — including the usage/`cacheReadTokens` mapping that
      feeds billing — completely untested. Both restored in Task 5's fix
      round; full suite green afterward.
- [ ] **Task 2 test regression caught and fixed in Task 5 (Ruling 7) —
      (resolved).** `billing-webhook.test.ts` and `inline-allowance.test.ts`
      had been RED since Task 2 changed `TOPUP_PACKS` credits (1000→1600) and
      `INLINE_DAILY_CAP` (300/4000→600/1200) without updating their
      assertions; it went unnoticed for three tasks because each dispatch
      only ran its own focused test file. Fixed in Task 5's round. **Process
      change adopted for the rest of the run:** every dispatch must run the
      FULL suite before commit and report the pass/fail count.
- [ ] **No end-to-end HTTP test for the tier gate.** The test env has no AI
      binding, so a regression in the actual field path or the 403 response
      body shape would not be caught by any test.
- [ ] **No route-level test for inline spend recording.** Nothing exercises
      the `realMicro`/`addInlineSpend` call end-to-end — the
      `GATEWAY_FEE`-only formula (deliberately no `MARGIN`, since inline is
      free to the user) is correct by inspection, but a future edit that
      reintroduces `MARGIN` there would not be caught.
- [ ] **Duplicate test content.** `fim.test.ts:58-68` largely duplicates
      `fim.test.ts:14-24` (both from the brief).

### Cleanup

- [ ] **Worked on the live branch, not a worktree (Ruling 3).** A worktree
      from HEAD would have dropped 47 files of uncommitted editor work
      belonging to the repo owner. Server tasks had a clean tree so this was
      safe; every implementer was instructed to `git add` only the files
      their task named, never `git add -A`. No action needed — recorded so
      the reasoning isn't lost.
- [ ] **Stale `SAFETY_BUFFER` comment (Ruling 4) — (resolved).** A stale
      comment at `src/lib/usage.ts:38` was flagged during Task 2 but
      deliberately left for Task 3, since Task 3 Step 3 rewrites that exact
      docblock by design. Confirmed gone from `usage.ts` in the current tree.
- [ ] **Dead `FALLBACK_MODEL` map — (resolved).** `llm-router.ts:197-200`
      referenced model ids already removed from the catalog; Task 5 deleted
      it as part of the external-provider-routing removal. Confirmed absent
      from the current `llm-router.ts`.
- [ ] **`@ai-sdk/openai-compatible` is a dead dependency.** Still present at
      `package.json:27` (`"@ai-sdk/openai-compatible": "^2.0.30"`) after the
      external-provider routing it supported was deleted in Task 5. One-line
      removal.
- [ ] **Retire unused secrets/env vars.** `MINIMAX_API_KEY` and
      `MOONSHOT_API_KEY` are still declared in `src/types.ts`'s `AppEnv`
      (confirmed present), and `CF_ACCOUNT_ID` is still in `wrangler.toml`
      (lines 48, 122) and `wrangler.test.toml` (line 20). The spec lists all
      three for retirement; no task in the plan owns deleting them — this is
      the same item as the **Secrets** section above, restated here because
      it was explicitly routed to this checklist from Task 5's notes.
- [ ] **Verify `package-lock.json` on a clean checkout.** Beyond the one
      added dependency, the lockfile churned (removed `@emnapi/*` entries,
      re-stamped peer-dependency flags). Run `npm ci` on a clean checkout in
      CI before merge to make sure it resolves cleanly.
- [ ] **Unused DB index.** `idx_inline_spend_month` (on `month_key` alone,
      `migrations/0019_inline_spend.sql:12` — confirmed present) is unused by
      either `getInlineSpend` or `addInlineSpend`, both of which query on the
      composite primary key. Plan-mandated as written; plausibly there for
      future admin/reporting queries rather than a mistake.
- [ ] **No dedicated editor pricing route.** Both the `tier_gated` CTA and
      the low-credits CTA in the editor call `openBilling()`, which opens
      `/account` — there's no `/pricing`-equivalent route inside the editor
      app itself today. Worth deciding whether the account page's billing
      panel is sufficient or a dedicated upsell surface is wanted.
