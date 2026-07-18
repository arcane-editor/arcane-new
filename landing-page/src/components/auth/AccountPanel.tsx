import { useState, useEffect, useCallback } from "react";
import {
    getStoredToken, setStoredToken, clearStoredToken,
    apiGetMe, apiResendVerification, apiForgot, apiChangePassword,
    authErrorMessage, type MeResponse,
} from "@/lib/auth";
import { authInputClass, authPrimaryBtnClass, authErrorBannerClass } from "./AuthShell";

type State = "loading" | "ready" | "retry";

export default function AccountPanel() {
    const [state, setState] = useState<State>("loading");
    const [token, setToken] = useState("");
    const [me, setMe] = useState<MeResponse | null>(null);
    const [toast, setToast] = useState<{ msg: string; type: "success" | "error" } | null>(null);

    // Resend verification
    const [resending, setResending] = useState(false);

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

    const handleResend = async () => {
        setResending(true);
        try {
            await apiResendVerification(token);
            showToast("Verification email sent — check your inbox.");
        } catch (err) {
            showToast(authErrorMessage((err as Error).message), "error");
        }
        setResending(false);
    };

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
        return (
            <div className="min-h-[60vh] flex items-center justify-center">
                <div className="text-muted-foreground text-sm">Loading...</div>
            </div>
        );
    }

    if (state === "retry" || !me) {
        return (
            <div className="min-h-[60vh] flex flex-col items-center justify-center gap-4 px-4 text-center">
                <p className="text-muted-foreground text-sm">Couldn't reach the server. Please try again.</p>
                <button
                    className="h-10 rounded-md px-4 bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-all"
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
        <div className="container mx-auto px-4 py-24 max-w-2xl">
            <h1 className="font-display text-2xl font-bold mb-1">Your Account</h1>
            <p className="text-muted-foreground text-sm mb-8">Manage how you sign in to Arcane</p>

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
                        <button
                            className="h-8 shrink-0 rounded-md px-3 text-xs font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-all disabled:opacity-50"
                            onClick={handleResend}
                            disabled={resending}
                        >
                            {resending ? "Sending…" : "Resend email"}
                        </button>
                    </div>
                )}
                <div className={rowClass}>
                    <span className={labelClass}>Google</span>
                    <span className="text-sm text-foreground">{me.googleLinked ? "Connected" : "Not connected"}</span>
                </div>
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
                            You sign in with Google. Add a password to also sign in with email.
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
                        <p className="text-muted-foreground text-xs mt-1">Signs this browser out of Arcane.</p>
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
