import { useState, useEffect } from "react";
import { apiReset, setStoredToken, authErrorMessage } from "@/lib/auth";
import { AuthShell, authInputClass, authPrimaryBtnClass, authErrorBannerClass } from "./AuthShell";

export default function ResetPassword() {
    // "loading": not yet read from the URL — the SSG-rendered HTML freezes on
    // this state, so it must never say "Invalid link" before hydration runs.
    // null: read, and genuinely missing. Otherwise: the token string.
    const [resetToken, setResetToken] = useState<string | null | "loading">("loading");
    const [password, setPassword] = useState("");
    const [confirm, setConfirm] = useState("");
    const [error, setError] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [done, setDone] = useState(false);
    const [signedInEmail, setSignedInEmail] = useState("");

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        setResetToken(params.get("token"));
        window.history.replaceState(null, "", window.location.pathname);
    }, []);

    const handleSubmit = async () => {
        if (!resetToken || resetToken === "loading") return;
        if (password.length < 8) { setError(authErrorMessage("weak_password")); return; }
        if (password !== confirm) { setError("Passwords don't match."); return; }
        setSubmitting(true);
        setError("");
        try {
            const data = await apiReset(resetToken, password);
            // Fresh JWT: the reset bumped token_version, so every OTHER session
            // is now signed out. Store the new one — this browser stays in.
            setStoredToken(data.token);
            setSignedInEmail(data.user.email);
            setDone(true);
        } catch (err) {
            setError(authErrorMessage((err as Error).message));
        }
        setSubmitting(false);
    };

    if (done) {
        return (
            <AuthShell>
                <h1 className="font-display text-2xl font-bold mb-2 text-center">Password updated</h1>
                <p className="text-muted-foreground text-sm text-center">
                    You're signed in here. All other sessions have been signed out.
                </p>
                {signedInEmail && (
                    <p className="text-muted-foreground text-xs text-center mt-2">
                        You're now signed in as {signedInEmail}.
                    </p>
                )}
                <a href="/account" className="block mt-4 text-center text-primary text-sm hover:underline">Go to your account</a>
            </AuthShell>
        );
    }

    if (resetToken === "loading") {
        return (
            <AuthShell>
                <p className="text-muted-foreground text-sm text-center">Loading…</p>
            </AuthShell>
        );
    }

    if (resetToken === null) {
        return (
            <AuthShell>
                <h1 className="font-display text-2xl font-bold mb-3 text-center">Invalid link</h1>
                <div className={authErrorBannerClass}>
                    This reset link is missing its token. Request a new one below.
                </div>
                <a href="/forgot" className="block mt-4 text-center text-primary text-sm hover:underline">Request a new link</a>
            </AuthShell>
        );
    }

    return (
        <AuthShell>
            <h1 className="font-display text-2xl font-bold mb-1 text-center">Choose a new password</h1>
            <p className="text-muted-foreground text-sm mb-6 text-center">Minimum 8 characters.</p>

            {error && <div className={authErrorBannerClass}>{error}</div>}

            <div className="flex flex-col gap-3">
                <input
                    className={authInputClass}
                    placeholder="New password"
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") handleSubmit(); }}
                />
                <input
                    className={authInputClass}
                    placeholder="Confirm new password"
                    type="password"
                    autoComplete="new-password"
                    value={confirm}
                    onChange={e => setConfirm(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") handleSubmit(); }}
                />
                <button className={authPrimaryBtnClass} onClick={handleSubmit} disabled={submitting}>
                    {submitting ? "Updating…" : "Update password"}
                </button>
            </div>

            <a href="/forgot" className="block mt-4 text-center text-muted-foreground text-xs hover:text-foreground">
                Link expired? Request a new one
            </a>
        </AuthShell>
    );
}
