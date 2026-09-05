import { useState, useEffect } from "react";
import { getStoredToken } from "@/lib/auth";
import { apiGetPlans, apiStartCheckout, BillingError, type PlanTier } from "@/lib/billing";

// Marketing blurb per tier (prices come from the API so they never drift
// from the server's src/config/tiers.ts; the copy itself stays credit-free
// per the owner directive — see AI_USAGE_COPY below).
const TAGLINES: Record<string, string> = {
    free: "Core IDE, plus a one-time AI trial to try it out.",
    starter: "Everyday AI, tab completion, and external agents.",
    pro: "Everything in Starter, plus Deep Think for tricky problems.",
    max: "Everything, unlocked — including Max mode for the hardest sessions.",
};

/** OWNER DIRECTIVE: user-facing surfaces never show raw credit numbers — this
 *  replaces the old `{monthlyCredits} credits/mo` line with credit-free copy
 *  describing relative AI usage per tier. */
const AI_USAGE_COPY: Record<string, string> = {
    free: "One-time AI trial included",
    starter: "Monthly AI usage included",
    pro: "~5× Starter's AI usage",
    max: "~11× Starter's AI usage",
};

/** Effort-tier access per the new ladder — mirrors the server's
 *  ALLOWED_TIERS (free/starter -> low only, pro -> +mid, max -> +high). */
const EFFORT_ACCESS_COPY: Record<string, string> = {
    free: "Standard",
    starter: "Standard",
    pro: "Standard + Deep Think",
    max: "Standard, Deep Think & Max",
};

/**
 * What the band renders when /v1/billing/plans does not answer.
 *
 * The API stays the source of truth — this is never merged with a live response
 * and never used to start a checkout. It exists so an unreachable worker costs
 * the page its live prices instead of its entire pricing section, which is what
 * "Couldn't load plans. Please refresh." did at the bottom of the home page.
 *
 * Transcribed from `arcane-server/src/config/tiers.ts`, the same file the API
 * serves from. `monthlyCredits` is carried to satisfy PlanTier and is never
 * rendered — user-facing surfaces do not show raw credit numbers.
 */
const FALLBACK_TIERS: PlanTier[] = [
    { id: "free", name: "Free", priceUsd: 0, monthlyCredits: 150, order: 0 },
    { id: "starter", name: "Starter", priceUsd: 5, monthlyCredits: 387, order: 1 },
    { id: "pro", name: "Pro", priceUsd: 25, monthlyCredits: 2097, order: 2 },
    { id: "max", name: "Max", priceUsd: 50, monthlyCredits: 4235, order: 3 },
];

/** `$0`, not "Free" — the tier is ALREADY named Free, so returning "Free"
 *  here rendered the card as "Free / Free / 150 credits/mo". Every price row
 *  now has the same shape ($N + /mo), which is what lets the row scan. */
function fmtPrice(usd: number): string {
    return `$${usd}`;
}

/**
 * `page` — the standalone /pricing route: h1, tall top padding to clear the
 *   fixed navbar.
 * `section` — a band inside the landing page: h2 (the hero already owns the
 *   only h1), section padding matching its siblings, and an #pricing anchor.
 *
 * Both render the SAME tiers fetched from /v1/billing/plans, so prices can
 * never drift from the server's config/tiers.ts — which is why this is a
 * variant rather than a second, hardcoded marketing component.
 */
export interface PricingTableProps {
    variant?: 'page' | 'section';
}

export default function PricingTable({ variant = 'page' }: PricingTableProps) {
    const isSection = variant === 'section';
    const [tiers, setTiers] = useState<PlanTier[] | null>(null);
    const [authed, setAuthed] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    const [notice, setNotice] = useState("");

    useEffect(() => {
        setAuthed(!!getStoredToken());
        apiGetPlans()
            .then(p => setTiers([...p.tiers].sort((a, b) => a.order - b.order)))
            // Leaving `tiers` null is the whole error path now: it puts the band
            // in its `stale` state, which renders FALLBACK_TIERS and disarms the
            // checkout CTAs. Logged rather than swallowed so a broken worker is
            // still visible in the console.
            .catch((err) => console.warn("[pricing] /v1/billing/plans unavailable", err));
    }, []);

    // `stale` means these are the transcribed prices, not the served ones —
    // true while the fetch is in flight AND after it fails, because the two are
    // indistinguishable to a visitor and both call for the same caution. It is
    // the flag that keeps the fallback honest: the footnote says the live
    // figures are still coming, and every paid CTA becomes a link to /pricing
    // instead of a checkout button. Starting a purchase from a price this
    // component is not certain of is the one thing it must never do.
    //
    // Rendering the fallback from the first paint (rather than a "Loading
    // plans…" line) also means the band never changes height under the reader.
    const stale = !tiers;
    const shown = tiers ?? FALLBACK_TIERS;

    const subscribe = async (tierId: string) => {
        setNotice("");
        const token = getStoredToken();
        if (!token) {
            // Send them to sign in, then straight back to pricing.
            window.location.href = "/auth?return=/pricing";
            return;
        }
        setBusy(tierId);
        try {
            const { checkoutUrl } = await apiStartCheckout(token, { tier: tierId });
            window.location.href = checkoutUrl;
        } catch (err) {
            if (err instanceof BillingError && (err.code === "billing_unconfigured" || err.code === "product_unconfigured")) {
                setNotice("Paid plans are launching soon — check back shortly.");
            } else if (err instanceof BillingError && (err.status === 401 || err.status === 403)) {
                window.location.href = "/auth?return=/pricing";
                return;
            } else {
                setNotice(err instanceof Error ? err.message : "Could not start checkout.");
            }
            setBusy(null);
        }
    };

    return (
        <section
            id={isSection ? 'pricing' : undefined}
            className={`container mx-auto px-4 max-w-6xl ${
                isSection ? 'py-16 sm:py-20' : 'pt-32 pb-24'
            }`}
        >
            {/*  The sub-headline used to explain the credit system in detail —
                 "a monthly pool of AI credits… bigger models cost more… top up
                 anytime" — directly under a heading, while every card below it
                 obeys the OWNER DIRECTIVE a few lines down in this same file:
                 user-facing surfaces never show raw credit numbers. It also
                 argued for the metering model that STANDOUT-FEATURES.md names
                 as the thing the market is in revolt against. One line replaces
                 it, and the cards carry the detail they were already carrying. */}
            <div className={isSection ? 'mb-12 sm:mb-16' : 'mb-4'}>
                {isSection ? (
                    <h2 className="font-display text-step2 font-semibold tracking-tight text-foreground">
                        Pricing
                    </h2>
                ) : (
                    <h1 className="font-display text-step2 font-semibold tracking-tight text-foreground sm:text-step3">
                        Pricing
                    </h1>
                )}
                <p className={`max-w-[54ch] text-muted-foreground ${
                    isSection ? 'mt-4 text-step1 leading-relaxed' : 'mt-3 text-mini'
                }`}>
                    The IDE is free. Paid plans add AI usage and the bigger reasoning modes.
                </p>
            </div>

            {notice && (
                <div className="mx-auto max-w-md text-center rounded-lg border border-primary/30 bg-primary/10 px-4 py-2 text-sm text-primary mb-6">
                    {notice}
                </div>
            )}

            {/* `shown` is the ladder to render. When /v1/billing/plans cannot be
                reached this used to be a single grey sentence — "Couldn't load
                plans. Please refresh." — sitting alone in a 16rem-tall band at
                the bottom of the home page, which is the last thing a visitor
                who is ready to pay should meet. FALLBACK_TIERS keeps the section
                whole; `stale` is what stops it lying about the prices, and it is
                also why the paid CTAs go to /pricing rather than to checkout. */}
            <div className="grid grid-cols-1 gap-5 mt-10 md:grid-cols-2 lg:grid-cols-4">
                    {shown.map(t => {
                        const highlight = t.id === "pro";
                        const isFree = t.id === "free";
                        return (
                            <div
                                key={t.id}
                                className={`flex flex-col rounded-plane border bg-panel p-6 ${
                                    highlight ? "border-primary/40" : "border-border"
                                }`}
                            >
                                {/* Rendered in EVERY card, hidden where it doesn't apply.
                                    Mounting it only on the highlighted one pushed that
                                    card's name, price, credits and tagline ~56px below
                                    its neighbours, so nothing in the row lined up. */}
                                <span
                                    aria-hidden={!highlight}
                                    className={`self-start mb-3 rounded-chip px-2 py-0.5 font-mono text-micro ${
                                        highlight ? "bg-primary/10 text-primary" : "invisible"
                                    }`}
                                >
                                    Most popular
                                </span>
                                <h3 className="text-base font-semibold text-foreground">{t.name}</h3>
                                <div className="mt-2 mb-1 flex items-baseline gap-1.5">
                                    <span className="font-display text-step2 font-semibold tabular-nums text-foreground">
                                        {fmtPrice(t.priceUsd)}
                                    </span>
                                    <span className="text-mini text-muted-foreground">/mo</span>
                                </div>
                                {/* Credit-free per the owner directive — no raw credit numbers
                                    on user-facing surfaces (admin panel is exempt). */}
                                <p className="font-mono text-mini text-primary">
                                    {AI_USAGE_COPY[t.id] ?? ""}
                                </p>
                                <p className="mt-3 min-h-[2.75rem] text-mini leading-relaxed text-muted-foreground">
                                    {TAGLINES[t.id] ?? ""}
                                </p>
                                {/* Effort-tier access isn't in the API's PlanTier shape (it's a
                                    routing concept, not a billing one) — this mirrors the server's
                                    ALLOWED_TIERS. */}
                                <p className="mb-6 font-mono text-micro text-muted-foreground">
                                    {EFFORT_ACCESS_COPY[t.id] ?? ""}
                                </p>

                                {/* mt-auto, not mt-6: the grid stretches every card to the
                                    tallest, and without this the slack fell BELOW the
                                    button — leaving each CTA (and its divider) at a
                                    different height. Bottom-anchoring puts the slack
                                    above the rule instead, so all four line up. */}
                                <div className="mt-auto border-t border-border pt-5">
                                    {isFree ? (
                                        <a
                                            href="/#download"
                                            className="block h-10 rounded-panel bg-raised px-4 text-center text-mini font-semibold leading-10 text-foreground transition-colors hover:bg-selected"
                                        >
                                            Download UnityIDE
                                        </a>
                                    ) : stale ? (
                                        // Not a link. The earlier version sent
                                        // people to /pricing, which is a dead
                                        // round-trip from the /pricing page
                                        // itself — and checkout cannot work
                                        // anyway while the billing service is
                                        // the thing that is unreachable.
                                        <button
                                            disabled
                                            className="h-10 w-full cursor-not-allowed rounded-panel bg-raised px-4 text-mini font-semibold text-muted-foreground"
                                        >
                                            Temporarily unavailable
                                        </button>
                                    ) : (
                                        <button
                                            onClick={() => subscribe(t.id)}
                                            disabled={busy === t.id}
                                            className={`h-10 w-full rounded-panel px-4 text-mini font-semibold transition-colors disabled:opacity-50 ${
                                                highlight
                                                    ? "bg-primary text-primary-foreground hover:bg-primary-lit"
                                                    : "bg-raised text-foreground hover:bg-selected"
                                            }`}
                                        >
                                            {busy === t.id ? "Starting…" : authed ? "Choose plan" : "Sign in to subscribe"}
                                        </button>
                                    )}
                                </div>
                            </div>
                        );
                    })}
            </div>

            <p className="mt-10 text-center text-mini text-muted-foreground">
                {stale
                    ? "These are our standard plan prices, shown while we reach the billing service. Refresh to load the live figures and subscribe."
                    : "Prices in USD. Billing is handled securely by Dodo Payments."}{" "}
                {!stale && (
                    <>
                        Manage or cancel anytime from your{" "}
                        <a href="/account" className="text-primary underline decoration-primary/30 underline-offset-4 hover:decoration-primary">account</a>.
                    </>
                )}
            </p>
        </section>
    );
}
