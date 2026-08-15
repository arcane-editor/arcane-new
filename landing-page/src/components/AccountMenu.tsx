import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, CreditCard, LogOut, Settings, ShieldAlert } from "lucide-react";
import {
    getStoredToken, clearStoredToken, decodeToken, apiGetMe, type MeResponse,
} from "@/lib/auth";
import { initialsFromEmail, planLabel } from "@/lib/user-display";

/** `unknown` covers the pre-hydration frame — the island is pre-rendered at
 *  build time, so localStorage isn't readable until the effect runs. Rendering
 *  a reserved-width placeholder for it avoids the flash of "Log in" that the
 *  old navbar showed before swapping to "Account". */
export type AuthState = "unknown" | "signed-out" | "signed-in";

export interface AuthSummary {
    state: AuthState;
    email: string;
    me: MeResponse | null;
    meFailed: boolean;
    /** Idempotent: fetches once, then serves the cached result. */
    loadMe: () => void;
    signOut: () => void;
}

/**
 * Identity for the navbar, at zero network cost on page load.
 *
 * The email comes out of the JWT already in localStorage, so the avatar paints
 * on hydration with no request and no layout shift. Plan and credits are the
 * only things that need the server, and they're fetched lazily the first time
 * the menu opens — the navbar is on every page, so a /me call per page load
 * would be pure waste.
 */
export function useAuthSummary(): AuthSummary {
    const [state, setState] = useState<AuthState>("unknown");
    const [email, setEmail] = useState("");
    const [me, setMe] = useState<MeResponse | null>(null);
    const [meFailed, setMeFailed] = useState(false);
    const fetching = useRef(false);

    useEffect(() => {
        const read = () => {
            const token = getStoredToken();
            const claims = token ? decodeToken(token) : null;
            if (token && claims?.email) {
                setEmail(claims.email);
                setState("signed-in");
            } else {
                setEmail("");
                setMe(null);
                setState("signed-out");
            }
        };
        read();
        // Signing out on /account (or in another tab) must update this navbar
        // too. Re-reads on any storage event rather than matching the key,
        // which auth.ts keeps private.
        window.addEventListener("storage", read);
        return () => window.removeEventListener("storage", read);
    }, []);

    const loadMe = useCallback(() => {
        if (me || fetching.current) return;
        const token = getStoredToken();
        if (!token) return;
        fetching.current = true;
        void apiGetMe(token)
            .then(data => { setMe(data); setMeFailed(false); })
            .catch((err: { status?: number }) => {
                if (err.status === 401 || err.status === 403) {
                    // Server says the token is dead — actually sign out.
                    clearStoredToken();
                    setState("signed-out");
                } else {
                    // Transient: keep the session, just show no plan/credits.
                    setMeFailed(true);
                }
            })
            .finally(() => { fetching.current = false; });
    }, [me]);

    const signOut = useCallback(() => {
        clearStoredToken();
        window.location.href = "/";
    }, []);

    return { state, email, me, meFailed, loadMe, signOut };
}

export function Avatar({ email, className = "" }: { email: string; className?: string }) {
    return (
        <span
            className={`grid h-9 w-9 shrink-0 place-items-center rounded-full border border-primary/30 bg-primary/15 font-display text-xs font-bold tracking-wide text-primary ${className}`}
        >
            {initialsFromEmail(email)}
        </span>
    );
}

/** Reuses the "Beta" chip treatment from the wordmark rather than inventing a
 *  second badge style for the same job. */
function PlanChip({ plan }: { plan: string | undefined }) {
    return (
        <span className="rounded-md border border-primary/30 bg-primary/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-primary">
            {planLabel(plan)}
        </span>
    );
}

function Skeleton({ className = "" }: { className?: string }) {
    return <span className={`inline-block animate-pulse rounded bg-muted-foreground/20 ${className}`} />;
}

const itemClass =
    "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-primary/10 hover:text-foreground focus-visible:bg-primary/10 focus-visible:text-foreground focus-visible:outline-none";

/** Identity block + credits, shared by the desktop popover and the mobile sheet. */
export function AccountSummaryBlock({ email, me, meFailed }: Pick<AuthSummary, "email" | "me" | "meFailed">) {
    return (
        <>
            <div className="flex items-center gap-3 px-1 py-2">
                <Avatar email={email} />
                <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{email}</p>
                    <div className="mt-1">
                        {me ? <PlanChip plan={me.user.plan} /> : meFailed ? null : <Skeleton className="h-4 w-12" />}
                    </div>
                </div>
            </div>

            <div className="flex items-center justify-between px-2.5 py-2">
                <span className="text-xs text-muted-foreground">AI credits</span>
                {me ? (
                    <span className="font-mono text-sm text-foreground">
                        {Math.round(me.user.credits ?? 0).toLocaleString()}
                    </span>
                ) : meFailed ? (
                    <span className="text-xs text-muted-foreground">unavailable</span>
                ) : (
                    <Skeleton className="h-4 w-10" />
                )}
            </div>

            {me && !me.user.emailVerified && (
                <a
                    href="/verify"
                    className="mx-1 mb-1 flex items-center gap-2 rounded-md border border-primary/30 bg-primary/10 px-2.5 py-2 text-xs text-primary transition-colors hover:bg-primary/15"
                >
                    <ShieldAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    Verify your email to use AI features
                </a>
            )}
        </>
    );
}

/** Desktop avatar trigger + popover. */
export default function AccountMenu({ email, me, meFailed, loadMe, signOut }: Omit<AuthSummary, "state">) {
    const [open, setOpen] = useState(false);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                setOpen(false);
                triggerRef.current?.focus();
            }
        };
        const onPointerDown = (e: MouseEvent) => {
            const target = e.target as Node;
            if (!panelRef.current?.contains(target) && !triggerRef.current?.contains(target)) {
                setOpen(false);
            }
        };
        document.addEventListener("keydown", onKeyDown);
        document.addEventListener("mousedown", onPointerDown);
        return () => {
            document.removeEventListener("keydown", onKeyDown);
            document.removeEventListener("mousedown", onPointerDown);
        };
    }, [open]);

    const toggle = () => {
        // Click, never hover: a hover menu is unreachable by keyboard and fires
        // on every accidental pass on touch.
        if (!open) loadMe();
        setOpen(o => !o);
    };

    return (
        <div className="relative ml-2">
            <button
                ref={triggerRef}
                onClick={toggle}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label="Account menu"
                className="group flex items-center gap-1 rounded-full pr-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
                {/* Glow belongs on the circle, not the trigger: the trigger is a
                    pill (avatar + chevron), so a shadow there reads as a smear
                    beside the avatar rather than a ring around it. */}
                <Avatar
                    email={email}
                    className={`transition-shadow ${open ? "border-primary/60 glow-orange-sm" : "group-hover:border-primary/50"}`}
                />
                <ChevronDown
                    className={`h-3.5 w-3.5 text-muted-foreground transition-transform duration-200 ${open ? "rotate-180" : ""}`}
                    aria-hidden="true"
                />
            </button>

            {open && (
                <div
                    ref={panelRef}
                    role="menu"
                    aria-label="Account"
                    className="glass-strong absolute right-0 top-full z-50 mt-2 w-64 rounded-xl p-1.5 shadow-2xl"
                >
                    <AccountSummaryBlock email={email} me={me} meFailed={meFailed} />

                    <div className="my-1 h-px bg-border/50" />

                    <a href="/account" role="menuitem" className={itemClass}>
                        <Settings className="h-4 w-4 shrink-0" aria-hidden="true" />
                        Account settings
                    </a>
                    <a href="/account#billing" role="menuitem" className={itemClass}>
                        <CreditCard className="h-4 w-4 shrink-0" aria-hidden="true" />
                        Plans &amp; billing
                    </a>

                    <div className="my-1 h-px bg-border/50" />

                    <button
                        type="button"
                        role="menuitem"
                        onClick={signOut}
                        className={`${itemClass} hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive`}
                    >
                        <LogOut className="h-4 w-4 shrink-0" aria-hidden="true" />
                        Sign out
                    </button>
                </div>
            )}
        </div>
    );
}
