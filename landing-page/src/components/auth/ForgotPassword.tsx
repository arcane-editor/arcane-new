import { useState } from "react";
import { apiForgot } from "@/lib/auth";
import { AuthShell, authInputClass, authPrimaryBtnClass, authErrorBannerClass } from "./AuthShell";

export default function ForgotPassword() {
    const [email, setEmail] = useState("");
    const [sent, setSent] = useState(false);
    const [error, setError] = useState("");
    const [submitting, setSubmitting] = useState(false);

    const handleSubmit = async () => {
        if (!email) { setError("Enter your email address."); return; }
        setSubmitting(true);
        setError("");
        try {
            await apiForgot(email);
            // Server always answers {ok:true} — identical UX for known and
            // unknown emails (anti-enumeration). Never branch on existence.
            setSent(true);
        } catch {
            setError("Something went wrong. Please try again.");
        }
        setSubmitting(false);
    };

    if (sent) {
        return (
            <AuthShell>
                <h1 className="font-display text-2xl font-bold mb-2 text-center">Check your inbox</h1>
                <p className="text-muted-foreground text-sm text-center">
                    If an account exists for <span className="text-foreground">{email}</span>, a password
                    reset link is on its way. The link expires in 30 minutes.
                </p>
                <a href="/auth" className="block mt-4 text-center text-primary text-sm hover:underline">Back to sign in</a>
            </AuthShell>
        );
    }

    return (
        <AuthShell>
            <h1 className="font-display text-2xl font-bold mb-1 text-center">Reset your password</h1>
            <p className="text-muted-foreground text-sm mb-6 text-center">
                Enter your email and we'll send you a reset link.
            </p>

            {error && <div className={authErrorBannerClass}>{error}</div>}

            <div className="flex flex-col gap-3">
                <input
                    className={authInputClass}
                    placeholder="Email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") handleSubmit(); }}
                />
                <button className={authPrimaryBtnClass} onClick={handleSubmit} disabled={submitting}>
                    {submitting ? "Sending…" : "Send reset link"}
                </button>
            </div>

            <a href="/auth" className="block mt-4 text-center text-muted-foreground text-xs hover:text-foreground">Back to sign in</a>
        </AuthShell>
    );
}
