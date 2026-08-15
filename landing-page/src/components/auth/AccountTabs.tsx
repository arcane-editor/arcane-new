import { useCallback, useEffect, useRef, useState } from "react";
import { getStoredToken } from "@/lib/auth";
import { Skeleton, SkeletonGroup } from "@/components/ui/skeleton";
import AccountPanel from "./AccountPanel";
import BillingPanel from "../billing/BillingPanel";
import { resolveInitialTab, type TabId } from "@/lib/account-tab";


const TABS: { id: TabId; label: string; hint: string }[] = [
    { id: "account", label: "Account", hint: "How you sign in" },
    { id: "billing", label: "Billing", hint: "Plan and credits" },
];

/** Mirrors the real card stack so the page keeps its shape while loading. */
function PageSkeleton() {
    return (
        <SkeletonGroup label="Loading your account" className="space-y-6">
            <div className="glass rounded-2xl p-6">
                <Skeleton className="h-4 w-24" />
                <div className="mt-5 space-y-4">
                    <Skeleton className="h-3 w-full max-w-sm" />
                    <Skeleton className="h-3 w-full max-w-xs" />
                    <Skeleton className="h-3 w-full max-w-[14rem]" />
                </div>
            </div>
            <div className="glass rounded-2xl p-6">
                <Skeleton className="h-4 w-32" />
                <div className="mt-5 space-y-3">
                    <Skeleton className="h-10 w-full max-w-sm rounded-md" />
                    <Skeleton className="h-10 w-full max-w-sm rounded-md" />
                </div>
            </div>
        </SkeletonGroup>
    );
}

/**
 * Page shell for /account. Owns the header, the tab bar and the signed-in
 * guard; each panel still fetches its own data (they read different endpoints)
 * and keeps its own retry handling.
 *
 * A tab is mounted the first time it is opened and then stays mounted behind
 * `hidden`, so switching back is instant instead of refetching.
 */
export default function AccountTabs() {
    const [tab, setTab] = useState<TabId>("account");
    // Deliberately starts false on both server and client: the first render
    // must match the server's HTML, and the hash is only readable after mount.
    const [hydrated, setHydrated] = useState(false);
    const [seen, setSeen] = useState<TabId[]>(["account"]);
    const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

    const activate = useCallback((next: TabId, updateHash = true) => {
        setTab(next);
        setSeen(prev => (prev.includes(next) ? prev : [...prev, next]));
        if (updateHash) {
            // replaceState, not push: Back should leave the account page, not
            // walk through every tab the user glanced at.
            history.replaceState(null, "", next === "account" ? location.pathname : `#${next}`);
        }
    }, []);

    useEffect(() => {
        if (!getStoredToken()) {
            window.location.href = "/auth?return=/account";
            return;
        }
        // updateHash stays false here: rewriting the URL now would drop the
        // ?checkout=success that BillingPanel reads on mount.
        activate(resolveInitialTab(window.location.search, window.location.hash), false);
        setHydrated(true);
        // The navbar links to /account#billing; if we are already on the page
        // that is a hash change with no navigation, so react to it.
        const onHashChange = () =>
            activate(resolveInitialTab(window.location.search, window.location.hash), false);
        window.addEventListener("hashchange", onHashChange);
        return () => window.removeEventListener("hashchange", onHashChange);
    }, [activate]);

    const onKeyDown = (e: React.KeyboardEvent) => {
        const i = TABS.findIndex(t => t.id === tab);
        const next =
            e.key === "ArrowRight" ? (i + 1) % TABS.length
            : e.key === "ArrowLeft" ? (i - 1 + TABS.length) % TABS.length
            : e.key === "Home" ? 0
            : e.key === "End" ? TABS.length - 1
            : -1;
        if (next < 0) return;
        e.preventDefault();
        const target = TABS[next]!;
        activate(target.id);
        tabRefs.current[target.id]?.focus();
    };

    return (
        <div className="container mx-auto max-w-2xl px-4 pb-24 pt-24">
            <h1 className="font-display text-2xl font-bold">Your account</h1>
            <p className="mb-6 mt-1 text-sm text-muted-foreground">
                {TABS.find(t => t.id === tab)?.hint}
            </p>

            {/* Same treatment as the sign-in / create-account tabs on /auth, so
                the two read as one system rather than two tab styles. */}
            <div
                role="tablist"
                aria-label="Account sections"
                onKeyDown={onKeyDown}
                className="mb-6 flex gap-1 border-b border-border/50"
            >
                {TABS.map(t => {
                    const selected = t.id === tab;
                    return (
                        <button
                            key={t.id}
                            ref={el => { tabRefs.current[t.id] = el; }}
                            role="tab"
                            id={`tab-${t.id}`}
                            aria-selected={selected}
                            aria-controls={`panel-${t.id}`}
                            tabIndex={selected ? 0 : -1}
                            onClick={() => activate(t.id)}
                            className={`border-b-2 px-4 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:bg-primary/10 ${
                                selected
                                    ? "border-primary text-primary"
                                    : "border-transparent text-muted-foreground hover:text-foreground"
                            }`}
                        >
                            {t.label}
                        </button>
                    );
                })}
            </div>

            {!hydrated ? (
                <PageSkeleton />
            ) : (
                TABS.filter(t => seen.includes(t.id)).map(t => (
                    <div
                        key={t.id}
                        role="tabpanel"
                        id={`panel-${t.id}`}
                        aria-labelledby={`tab-${t.id}`}
                        hidden={t.id !== tab}
                    >
                        {t.id === "account" ? <AccountPanel /> : <BillingPanel />}
                    </div>
                ))
            )}
        </div>
    );
}
