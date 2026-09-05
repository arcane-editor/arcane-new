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
    const [loadError, setLoadError] = useState("");
    const [busy, setBusy] = useState<string | null>(null);
    const [notice, setNotice] = useState("");

    useEffect(() => {
        setAuthed(!!getStoredToken());
        apiGetPlans()
            .then(p => setTiers([...p.tiers].sort((a, b) => a.order - b.order)))
            .catch(() => setLoadError("Couldn't load plans. Please refresh."));
    }, []);

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
                isSection ? 'py-16 sm:py-28' : 'pt-32 pb-24'
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
                    <h2 className="font-display text-step2 font-semibold tracking-tight text-foreground sm:text-step3">
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

            {loadError ? (
                <p className="text-center text-muted-foreground text-sm py-16">{loadError}</p>
            ) : !tiers ? (
                <p className="text-center text-muted-foreground text-sm py-16">Loading plans…</p>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5 mt-10">
                    {tiers.map(t => {
                        const highlight = t.id === "pro";
                        const isFree = t.id === "free";
                        return (
                            <div
                                key={t.id}
                                className={`glass rounded-2xl p-6 flex flex-col transition-all duration-300 hover:-translate-y-1 hover:border-primary/40 ${
                                    highlight ? "border-primary/40 ring-1 ring-primary/30" : ""
                                }`}
                            >
                                {/* Rendered in EVERY card, hidden where it doesn't apply.
                                    Mounting it only on the highlighted one pushed that
                                    card's name, price, credits and tagline ~56px below
                                    its neighbours, so nothing in the row lined up. */}
                                <span
                                    aria-hidden={!highlight}
                                    className={`self-start mb-3 rounded-full border px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider ${
                                        highlight
                                            ? "bg-primary/15 border-primary/30 text-primary"
                                            : "invisible border-transparent"
                                    }`}
                                >
                                    Most popular
                                </span>
                                <h3 className="font-display text-lg font-bold">{t.name}</h3>
                                <div className="mt-2 mb-1 flex items-baseline gap-1">
                                    <span className="font-display text-3xl font-bold">{fmtPrice(t.priceUsd)}</span>
                                    <span className="text-muted-foreground text-sm">/mo</span>
                                </div>
                                {/* Credit-free per the owner directive — no raw credit numbers
                                    on user-facing surfaces (admin panel is exempt). */}
                                <p className="text-sm text-foreground/80 font-mono">
                                    {AI_USAGE_COPY[t.id] ?? ""}
                                </p>
                                <p className="text-muted-foreground text-xs mt-3 min-h-[2.5rem]">
                                    {TAGLINES[t.id] ?? ""}
                                </p>
                                {/* Effort-tier access isn't in the API's PlanTier shape (it's a
                                    routing concept, not a billing one) — this mirrors the server's
                                    ALLOWED_TIERS. */}
                                <p className="text-foreground/70 text-xs font-mono mb-6">
                                    {EFFORT_ACCESS_COPY[t.id] ?? ""}
                                </p>

                                {/* mt-auto, not mt-6: the grid stretches every card to the
                                    tallest, and without this the slack fell BELOW the
                                    button — leaving each CTA (and its divider) at a
                                    different height. Bottom-anchoring puts the slack
                                    above the rule instead, so all four line up. */}
                                <div className="mt-auto pt-5 border-t border-border/30">
                                    {isFree ? (
                                        <a
                                            href="/#download"
                                            className="block text-center h-10 leading-10 rounded-md px-4 bg-secondary text-secondary-foreground text-sm font-semibold hover:bg-secondary/80 transition-all"
                                        >
                                            Download UnityIDE
                                        </a>
                                    ) : (
                                        <button
                                            onClick={() => subscribe(t.id)}
                                            disabled={busy === t.id}
                                            className={`w-full h-10 rounded-md px-4 text-sm font-semibold transition-all disabled:opacity-50 ${
                                                highlight
                                                    ? "bg-primary text-primary-foreground hover:bg-primary/90"
                                                    : "bg-secondary text-secondary-foreground hover:bg-secondary/80"
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
            )}

            <p className="text-center text-muted-foreground text-xs mt-10">
                Prices in USD. Billing is handled securely by Dodo Payments. Manage or cancel anytime from your{" "}
                <a href="/account" className="text-primary hover:underline">account</a>.
            </p>
        </section>
    );
}
