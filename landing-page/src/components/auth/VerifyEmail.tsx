import { useState, useEffect } from "react";
import {
    apiVerifyEmail, apiResendVerification, apiGetMe,
    getStoredToken, setStoredToken, authErrorMessage,
} from "@/lib/auth";
import { loadEditorLoginRequest } from "@/lib/editor-login";
import { AuthShell, authInputClass, authPrimaryBtnClass, authErrorBannerClass } from "./AuthShell";

type Status = "boot" | "entry" | "done";

/** Standalone code entry for an account that is signed in but unverified.
 *  The main path is the step shown inline after signup in AuthHub; this page
 *  is where /account sends someone who left before finishing. */
export default function VerifyEmail() {
    const [status, setStatus] = useState<Status>("boot");
    const [token, setToken] = useState("");
    const [email, setEmail] = useState("");
    const [code, setCode] = useState("");
    const [error, setError] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [resending, setResending] = useState(false);

    useEffect(() => {
        void (async () => {
            // Strip any legacy ?token= link so an old email can't leave a stale
            // credential sitting in history.
            if (window.location.search) {
                window.history.replaceState(null, "", window.location.pathname);
            }
            const stored = getStoredToken();
            if (!stored) {
                window.location.href = "/auth";
                return;
            }
            try {
                const me = await apiGetMe(stored);
                if (me.user.emailVerified) {
                    setStatus("done");
                    return;
                }
                setToken(stored);
                setEmail(me.user.email);
                setStatus("entry");
            } catch {
                window.location.href = "/auth";
            }
        })();
    }, []);

    const handleVerify = async () => {
        if (submitting) return;
        if (code.length !== 6) { setError("Enter the 6-digit code from your email."); return; }
        setSubmitting(true);
        setError("");
        try {
            const data = await apiVerifyEmail(code, token);
            setStoredToken(data.token);
            if (loadEditorLoginRequest()) {
                // An editor sign-in was mid-flight — resume it through the hub.
                window.location.href = "/auth";
                return;
            }
            setStatus("done");
        } catch (err) {
            setError(authErrorMessage((err as Error).message));
            setSubmitting(false);
        }
    };

    const handleResend = async () => {
        if (resending) return;
        setResending(true);
        setError("");
        try {
            await apiResendVerification(token);
            setCode("");
        } catch (err) {
            setError(authErrorMessage((err as Error).message));
        } finally {
            setResending(false);
        }
    };

    if (status === "boot") {
        return (
            <AuthShell>
                <p className="text-muted-foreground text-sm text-center">Loading…</p>
            </AuthShell>
        );
    }

    if (status === "done") {
        return (
            <AuthShell>
                <h1 className="font-display text-2xl font-bold mb-2 text-center">Email verified</h1>
                <p className="text-muted-foreground text-sm text-center">
                    You're all set — AI features are now unlocked.
                </p>
                <a href="/account" className="block mt-4 text-center text-primary text-sm hover:underline">
                    Go to your account
                </a>
            </AuthShell>
        );
    }

    return (
        <AuthShell>
            <h1 className="font-display text-2xl font-bold mb-1 text-center">Verify your email</h1>
            <p className="text-muted-foreground text-sm mb-6 text-center">
                Enter the 6-digit code sent to <span className="text-foreground">{email}</span>.
            </p>

            {error && <div className={authErrorBannerClass}>{error}</div>}

            <div className="flex flex-col gap-3">
                <input
                    className={`${authInputClass} text-center text-lg tracking-[0.4em] font-mono`}
                    placeholder="000000"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    autoFocus
                    value={code}
                    onChange={e => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    onKeyDown={e => { if (e.key === "Enter") handleVerify(); }}
                />
                <button className={authPrimaryBtnClass} onClick={handleVerify} disabled={submitting}>
                    {submitting ? "Verifying…" : "Verify email"}
                </button>
            </div>

            <button
                className="mt-4 block w-full text-center text-primary text-sm hover:underline disabled:opacity-50"
                onClick={handleResend}
                disabled={resending}
            >
                {resending ? "Sending…" : "Send a new code"}
            </button>
            <a href="/account" className="block mt-3 text-center text-muted-foreground text-xs hover:text-foreground">
                Back to your account
            </a>
        </AuthShell>
    );
}
