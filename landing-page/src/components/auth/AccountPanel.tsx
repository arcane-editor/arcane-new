import { useState, useEffect, useCallback } from "react";
import {
    getStoredToken, setStoredToken, clearStoredToken,
    apiGetMe, apiForgot, apiChangePassword,
    authErrorMessage, type MeResponse,
} from "@/lib/auth";
import { authInputClass, authPrimaryBtnClass, authErrorBannerClass } from "./AuthShell";
import { Skeleton, SkeletonGroup } from "@/components/ui/skeleton";

type State = "loading" | "ready" | "retry";

export default function AccountPanel() {
    const [state, setState] = useState<State>("loading");
    const [token, setToken] = useState("");
    const [me, setMe] = useState<MeResponse | null>(null);
    const [toast, setToast] = useState<{ msg: string; type: "success" | "error" } | null>(null);

    // Change password
    const [currentPassword, setCurrentPassword] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [pwError, setPwError] = useState("");
    const [pwSubmitting, setPwSubmitting] = useState(false);

    // Set a password (Google-only accounts)
    const [setPwSent, setSetPwSent] = useState(false);

    const showToast = useCallback((msg: string, type: "success" | "error" = "success") => {
        setToast({ msg, type });
        setTimeout(() => setToast(null), 3000);
    }, []);

    const loadMe = useCallback(async (t: string) => {
        setState("loading");
        try {
            const data = await apiGetMe(t);
            setToken(t);
            setMe(data);
            setState("ready");
        } catch (err) {
            const status = (err as { status?: number }).status;
            if (status === 401 || status === 403) {
                // Server has confirmed the token is invalid — actually log out.
                clearStoredToken();
                window.location.href = "/auth?return=/account";
                return;
            }
            // Transient network/5xx failure: don't destroy a possibly-valid
            // session over it. Keep the token and offer a retry instead.
            setToken(t);
            setState("retry");
        }
    }, []);

    useEffect(() => {
        const t = getStoredToken();
        if (!t) { window.location.href = "/auth?return=/account"; return; }
        void loadMe(t);
    }, [loadMe]);

    const handleChangePassword = async () => {
        if (!currentPassword || !newPassword) { setPwError("Both fields are required."); return; }
        if (newPassword.length < 8) { setPwError(authErrorMessage("weak_password")); return; }
        setPwSubmitting(true);
        setPwError("");
        try {
            const data = await apiChangePassword(token, currentPassword, newPassword);
            // The server minted a fresh JWT (version bump kills every other
            // session, including the old token in THIS browser) — store it.
            setStoredToken(data.token);
            setToken(data.token);
            setCurrentPassword("");
            setNewPassword("");
            showToast("Password changed. Other sessions were signed out.");
        } catch (err) {
            setPwError(authErrorMessage((err as Error).message));
        }
        setPwSubmitting(false);
    };

    const handleSetPassword = async () => {
        if (!me) return;
        try {
            // Google-only account: reuse the reset flow for the user's own email.
            await apiForgot(me.user.email);
            setSetPwSent(true);
        } catch {
            showToast("Something went wrong. Please try again.", "error");
        }
    };

    const handleSignOut = () => {
        clearStoredToken();
        window.location.href = "/";
    };

    if (state === "loading") {
        // Shaped like the cards below (profile rows, then the password form) so
        // nothing shifts when the data lands.
        return (
            <SkeletonGroup label="Loading your account" className="space-y-6">
                <div className="glass rounded-2xl p-6">
                    <div className="space-y-4">
                        <div className="flex items-center justify-between">
                            <Skeleton className="h-3 w-14" />
                            <Skeleton className="h-3 w-48" />
                        </div>
                        <div className="flex items-center justify-between">
                            <Skeleton className="h-3 w-24" />
                            <Skeleton className="h-3 w-10" />
                        </div>
                    </div>
                </div>
                <div className="glass rounded-2xl p-6">
                    <Skeleton className="h-4 w-36" />
                    <div className="mt-5 max-w-sm space-y-3">
                        <Skeleton className="h-10 w-full rounded-md" />
                        <Skeleton className="h-10 w-full rounded-md" />
                        <Skeleton className="h-10 w-full rounded-md" />
                    </div>
                </div>
            </SkeletonGroup>
        );
    }

    if (state === "retry" || !me) {
        return (
            <div className="glass flex flex-col items-center gap-4 rounded-2xl p-8 text-center">
                <p className="text-sm text-muted-foreground">
                    Couldn't reach the server. Your session is still valid — try again.
                </p>
                <button
                    className="h-10 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground transition-all hover:bg-primary/90"
                    onClick={() => void loadMe(token)}
                >
                    Retry
                </button>
            </div>
        );
    }

    const rowClass = "flex items-center justify-between py-3 border-b border-border/30";
    const labelClass = "text-sm text-muted-foreground";

    return (
        // Page chrome (container, heading, tabs) belongs to AccountTabs now —
        // this renders only the Account tab's own cards.
        <div>
            {/* Profile */}
            <div className="glass rounded-2xl p-6 mb-6">
                <div className={rowClass}>
                    <span className={labelClass}>Email</span>
                    <span className="text-sm text-foreground flex items-center gap-2">
                        {me.user.email}
                        {me.user.emailVerified ? (
                            <span className="rounded-full bg-green-500/10 border border-green-500/20 px-2 py-0.5 text-[11px] font-semibold text-green-500">
                                Verified
                            </span>
                        ) : (
                            <span className="rounded-full bg-destructive/10 border border-destructive/20 px-2 py-0.5 text-[11px] font-semibold text-destructive">
                                Unverified
                            </span>
                        )}
                    </span>
                </div>
                {!me.user.emailVerified && (
                    <div className="flex items-center justify-between py-3 border-b border-border/30">
                        <span className="text-xs text-muted-foreground">
                            AI features stay locked until you verify your email.
                        </span>
                        {/* Links rather than resending inline: verification is a
                            code now, and /verify is the one place to type it. */}
                        <a
                            href="/verify"
                            className="h-8 shrink-0 inline-flex items-center rounded-md px-3 text-xs font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-all"
                        >
                            Enter code
                        </a>
                    </div>
                )}
                {/* Shown only when linked. There is no "Connect" action here on
                    purpose: the callback resolves the account by verified email,
                    so connecting while signed in under a different address would
                    silently switch accounts rather than link this one.
                    (The Google row stays retired — its button is still gone, so
                    no new account can reach a google-linked state.) */}
                {me.githubLinked && (
                    <div className="flex items-center justify-between py-3 border-b border-border/30">
                        <span className={labelClass}>GitHub</span>
                        <span className="text-sm text-foreground">Connected</span>
                    </div>
                )}
                <div className="flex items-center justify-between py-3">
                    <span className={labelClass}>AI requests used</span>
                    <span className="text-sm font-mono text-foreground">{me.usage.totalRequests}</span>
                </div>
            </div>

            {/* Password */}
            <div className="glass rounded-2xl p-6 mb-6">
                <h2 className="font-display text-lg font-bold mb-4">
                    {me.hasPassword ? "Change password" : "Set a password"}
                </h2>

                {me.hasPassword ? (
                    <>
                        {pwError && <div className={authErrorBannerClass}>{pwError}</div>}
                        <div className="flex flex-col gap-3 max-w-sm">
                            <input
                                className={authInputClass}
                                placeholder="Current password"
                                type="password"
                                autoComplete="current-password"
                                value={currentPassword}
                                onChange={e => setCurrentPassword(e.target.value)}
                            />
                            <input
                                className={authInputClass}
                                placeholder="New password (min 8 characters)"
                                type="password"
                                autoComplete="new-password"
                                value={newPassword}
                                onChange={e => setNewPassword(e.target.value)}
                                onKeyDown={e => { if (e.key === "Enter") handleChangePassword(); }}
                            />
                            <button className={authPrimaryBtnClass} onClick={handleChangePassword} disabled={pwSubmitting}>
                                {pwSubmitting ? "Updating…" : "Update password"}
                            </button>
                        </div>
                    </>
                ) : setPwSent ? (
                    <p className="text-muted-foreground text-sm">
                        We've emailed <span className="text-foreground">{me.user.email}</span> a link to set
                        a password. It expires in 30 minutes.
                    </p>
                ) : (
                    <>
                        <p className="text-muted-foreground text-sm mb-4">
                            {/* Only OAuth signups reach a passwordless state, so name
                                the provider this account actually used. */}
                            You sign in with {me.githubLinked ? "GitHub" : "Google"}. Add a
                            password to also sign in with email.
                        </p>
                        <button
                            className="h-10 rounded-md px-4 bg-secondary text-secondary-foreground text-sm font-semibold hover:bg-secondary/80 transition-all"
                            onClick={handleSetPassword}
                        >
                            Email me a set-password link
                        </button>
                    </>
                )}
            </div>

            {/* Sign out */}
            <div className="glass rounded-2xl p-6">
                <div className="flex items-center justify-between">
                    <div>
                        <h2 className="font-display text-lg font-bold">Sign out</h2>
                        <p className="text-muted-foreground text-xs mt-1">Signs this browser out of UnityIDE.</p>
                    </div>
                    <button
                        className="h-9 rounded-md px-4 text-sm font-semibold bg-destructive/10 border border-destructive/20 text-destructive hover:bg-destructive/20 transition-all"
                        onClick={handleSignOut}
                    >
                        Sign out
                    </button>
                </div>
            </div>

            {/* Toast */}
            {toast && (
                <div className={`fixed bottom-5 right-5 rounded-lg px-4 py-3 text-sm font-medium text-white z-50 animate-[fadeIn_0.2s_ease] ${
                    toast.type === "success" ? "bg-green-600" : "bg-destructive"
                }`}>
                    {toast.msg}
                </div>
            )}
        </div>
    );
}
