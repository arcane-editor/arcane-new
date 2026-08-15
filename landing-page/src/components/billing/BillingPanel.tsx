import { useState, useEffect, useCallback } from "react";
import { getStoredToken, clearStoredToken } from "@/lib/auth";
import {
    apiGetUsage, apiGetPlans, apiStartCheckout, apiOpenPortal,
    BillingError, type UsageResponse, type PlanTier, type TopupPack,
} from "@/lib/billing";

type State = "loading" | "ready" | "retry";

function planLabel(id: string, tiers: PlanTier[]): string {
    return tiers.find(t => t.id === id)?.name ?? (id.charAt(0).toUpperCase() + id.slice(1));
}

function fmtDate(iso: string | null): string {
    if (!iso) return "—";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export default function BillingPanel() {
    const [state, setState] = useState<State>("loading");
    const [token, setToken] = useState("");
    const [usage, setUsage] = useState<UsageResponse | null>(null);
    const [tiers, setTiers] = useState<PlanTier[]>([]);
    const [topups, setTopups] = useState<TopupPack[]>([]);
    const [busy, setBusy] = useState<string | null>(null);
    const [notice, setNotice] = useState<{ msg: string; type: "success" | "error" | "info" } | null>(null);

    const load = useCallback(async (t: string) => {
        setState("loading");
        try {
            const [u, plans] = await Promise.all([apiGetUsage(t), apiGetPlans().catch(() => null)]);
            setToken(t);
            setUsage(u);
            if (plans) { setTiers(plans.tiers); setTopups(plans.topups); }
            setState("ready");
        } catch (err) {
            const status = (err as BillingError).status;
            if (status === 401 || status === 403) {
                clearStoredToken();
                window.location.href = "/auth?return=/account";
                return;
            }
            setToken(t);
            setState("retry");
        }
    }, []);

    useEffect(() => {
        const t = getStoredToken();
        if (!t) { window.location.href = "/auth?return=/account"; return; }
        // Returning from a successful Dodo checkout — the webhook may lag a beat,
        // so tell the user and reload the balance.
        if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("checkout") === "success") {
            setNotice({ msg: "Payment received — your credits will appear here shortly.", type: "success" });
            window.history.replaceState({}, "", "/account");
        }
        void load(t);
    }, [load]);

    const buyTopup = async (packId: string) => {
        setNotice(null);
        setBusy(packId);
        try {
            const { checkoutUrl } = await apiStartCheckout(token, { pack: packId });
            window.location.href = checkoutUrl;
        } catch (err) {
            handleCheckoutError(err);
            setBusy(null);
        }
    };

    const manage = async () => {
        setNotice(null);
        setBusy("portal");
        try {
            const { portalUrl } = await apiOpenPortal(token);
            window.location.href = portalUrl;
        } catch (err) {
            handleCheckoutError(err);
            setBusy(null);
        }
    };

    const handleCheckoutError = (err: unknown) => {
        if (err instanceof BillingError && (err.code === "billing_unconfigured" || err.code === "product_unconfigured")) {
            setNotice({ msg: "Billing is launching soon — check back shortly.", type: "info" });
        } else if (err instanceof BillingError && (err.status === 401 || err.status === 403)) {
            clearStoredToken();
            window.location.href = "/auth?return=/account";
        } else {
            setNotice({ msg: err instanceof Error ? err.message : "Something went wrong.", type: "error" });
        }
    };

    if (state === "loading") {
        return <div className="container mx-auto px-4 max-w-2xl"><div className="glass rounded-2xl p-6 text-sm text-muted-foreground">Loading billing…</div></div>;
    }
    if (state === "retry" || !usage) {
        return (
            <div className="container mx-auto px-4 max-w-2xl">
                <div className="glass rounded-2xl p-6 flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Couldn't load billing.</span>
                    <button className="h-9 rounded-md px-4 text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-all" onClick={() => void load(token)}>Retry</button>
                </div>
            </div>
        );
    }

    const isFree = usage.plan === "free";
    const monthlyGrant = tiers.find(t => t.id === usage.plan)?.monthlyCredits ?? 0;
    const planRemaining = usage.credits.plan;
    const pct = monthlyGrant > 0 ? Math.max(0, Math.min(100, (planRemaining / monthlyGrant) * 100)) : 0;

    const rowClass = "flex items-center justify-between py-3 border-b border-border/30";
    const labelClass = "text-sm text-muted-foreground";

    return (
        // `id` is the anchor the navbar's "Plans & billing" item jumps to —
        // account settings and billing share one page, so the menu scrolls
        // rather than pretending they are separate destinations.
        <div id="billing" className="container mx-auto px-4 max-w-2xl pb-24 scroll-mt-24">
            {notice && (
                <div className={`rounded-lg px-4 py-2 text-sm mb-4 border ${
                    notice.type === "success" ? "border-green-500/30 bg-green-500/10 text-green-500"
                    : notice.type === "error" ? "border-destructive/30 bg-destructive/10 text-destructive"
                    : "border-primary/30 bg-primary/10 text-primary"
                }`}>{notice.msg}</div>
            )}

            {/* Plan + credits */}
            <div className="glass rounded-2xl p-6 mb-6">
                <div className="flex items-center justify-between mb-4">
                    <h2 className="font-display text-lg font-bold">Plan &amp; credits</h2>
                    <span className="rounded-full bg-primary/15 border border-primary/30 px-2.5 py-0.5 text-xs font-bold text-primary capitalize">
                        {planLabel(usage.plan, tiers)}
                    </span>
                </div>

                <div className="mb-2 flex items-baseline justify-between">
                    <span className="text-sm text-muted-foreground">Credits remaining</span>
                    <span className="font-mono text-sm text-foreground">
                        {Math.round(usage.credits.balance).toLocaleString()}
                        {monthlyGrant > 0 && <span className="text-muted-foreground"> / {monthlyGrant.toLocaleString()} plan</span>}
                    </span>
                </div>
                <div className="h-2 w-full rounded-full bg-muted/40 overflow-hidden">
                    <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
                </div>
                {usage.credits.topup > 0 && (
                    <p className="text-xs text-muted-foreground mt-2">
                        + {Math.round(usage.credits.topup).toLocaleString()} top-up credits (never expire)
                    </p>
                )}

                <div className={rowClass + " mt-4"}>
                    <span className={labelClass}>{isFree ? "Free credits refresh" : "Renews"}</span>
                    <span className="text-sm text-foreground">{fmtDate(usage.planPeriodEnd)}</span>
                </div>
                <div className="flex items-center justify-between py-3">
                    <span className={labelClass}>Requests this period</span>
                    <span className="text-sm font-mono text-foreground">{usage.currentPeriod.totalRequests}</span>
                </div>

                <div className="flex flex-wrap gap-3 mt-4">
                    <a href="/pricing" className="h-10 leading-10 rounded-md px-4 bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-all">
                        {isFree ? "Upgrade plan" : "Change plan"}
                    </a>
                    {!isFree && (
                        <button
                            onClick={manage}
                            disabled={busy === "portal"}
                            className="h-10 rounded-md px-4 bg-secondary text-secondary-foreground text-sm font-semibold hover:bg-secondary/80 transition-all disabled:opacity-50"
                        >
                            {busy === "portal" ? "Opening…" : "Manage subscription"}
                        </button>
                    )}
                </div>
            </div>

            {/* Top-ups */}
            {topups.length > 0 && (
                <div className="glass rounded-2xl p-6">
                    <h2 className="font-display text-lg font-bold mb-1">Buy extra credits</h2>
                    <p className="text-muted-foreground text-sm mb-4">One-time top-ups that never expire — used after your plan credits run out.</p>
                    <div className="flex flex-wrap gap-3">
                        {topups.map(p => (
                            <button
                                key={p.id}
                                onClick={() => buyTopup(p.id)}
                                disabled={busy === p.id}
                                className="flex-1 min-w-[150px] glass rounded-xl p-4 text-left hover:border-primary/40 transition-all disabled:opacity-50"
                            >
                                <div className="font-mono text-base font-bold text-foreground">{p.credits.toLocaleString()} credits</div>
                                <div className="text-sm text-primary font-semibold mt-1">{busy === p.id ? "Starting…" : `$${p.priceUsd}`}</div>
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
