import { useState, useEffect } from "react";
import { getStoredToken, clearStoredToken, apiAuthorizeDevice, authErrorMessage } from "@/lib/auth";
import { AuthShell, authInputClass, authPrimaryBtnClass, authErrorBannerClass } from "./AuthShell";

type State = "loading" | "signin" | "form" | "done";

export default function DeviceAuthorize() {
    const [state, setState] = useState<State>("loading");
    const [userCode, setUserCode] = useState("");
    const [token, setToken] = useState("");
    const [error, setError] = useState("");
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const prefill = params.get("user_code");
        if (prefill) setUserCode(prefill.toUpperCase());
        // Keep ?user_code= in the URL: it must survive the sign-in round trip
        // (it's a short-lived pairing code, not a secret credential).
        const t = getStoredToken();
        if (!t) { setState("signin"); return; }
        setToken(t);
        setState("form");
    }, []);

    // Round-trip through /auth preserving the code via the internal ?return= param.
    const signInHref = `/auth?return=${encodeURIComponent(
        userCode ? `/auth/device?user_code=${encodeURIComponent(userCode)}` : "/auth/device"
    )}`;

    const handleAuthorize = async () => {
        const code = userCode.trim().toUpperCase();
        if (!code) { setError("Enter the code shown in the editor."); return; }
        setSubmitting(true);
        setError("");
        try {
            await apiAuthorizeDevice(token, code);
            setState("done");
        } catch (err) {
            const status = (err as { status?: number }).status;
            if (status === 401 || status === 403) {
                clearStoredToken();
                setState("signin");
                setError("Your session expired — sign in again.");
            } else {
                setError(authErrorMessage((err as Error).message));
            }
        }
        setSubmitting(false);
    };

    if (state === "loading") {
        return (
            <AuthShell>
                <p className="text-muted-foreground text-sm text-center">Loading…</p>
            </AuthShell>
        );
    }

    if (state === "signin") {
        return (
            <AuthShell>
                <h1 className="font-display text-2xl font-bold mb-2 text-center">Connect your editor</h1>
                {error && <div className={authErrorBannerClass}>{error}</div>}
                <p className="text-muted-foreground text-sm mb-5 text-center">
                    Sign in first, then you'll come back here to approve the code from Arcane.
                </p>
                <a
                    href={signInHref}
                    className="block h-10 leading-10 w-full rounded-md bg-primary text-primary-foreground text-sm font-semibold text-center hover:bg-primary/90 transition-all"
                >
                    Sign in to continue
                </a>
            </AuthShell>
        );
    }

    if (state === "done") {
        return (
            <AuthShell>
                <h1 className="font-display text-2xl font-bold mb-2 text-center">Device authorized</h1>
                <p className="text-muted-foreground text-sm text-center">
                    Return to the editor — it will finish signing in on its own within a few seconds.
                </p>
                <a href="/account" className="block mt-4 text-center text-primary text-sm hover:underline">Manage your account</a>
            </AuthShell>
        );
    }

    return (
        <AuthShell>
            <h1 className="font-display text-2xl font-bold mb-1 text-center">Connect your editor</h1>
            <p className="text-muted-foreground text-sm mb-6 text-center">
                Enter the code shown in Arcane to sign the editor in.
            </p>

            {error && <div className={authErrorBannerClass}>{error}</div>}

            <div className="flex flex-col gap-3">
                <input
                    className={`${authInputClass} text-center font-mono tracking-widest uppercase`}
                    placeholder="CODE"
                    autoComplete="off"
                    spellCheck={false}
                    value={userCode}
                    onChange={e => setUserCode(e.target.value.toUpperCase())}
                    onKeyDown={e => { if (e.key === "Enter") handleAuthorize(); }}
                />
                <button className={authPrimaryBtnClass} onClick={handleAuthorize} disabled={submitting}>
                    {submitting ? "Authorizing…" : "Authorize device"}
                </button>
            </div>

            <a href="/" className="block mt-4 text-center text-muted-foreground text-xs hover:text-foreground">Back to home</a>
        </AuthShell>
    );
}
