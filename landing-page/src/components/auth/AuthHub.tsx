import { useState, useEffect, useRef } from "react";
import {
    getStoredToken, setStoredToken, clearStoredToken,
    apiLogin, apiSignup, apiGetMe, apiWebExchange, apiEditorGrant,
    googleStartUrl, authErrorMessage, isKnownAuthErrorCode,
} from "@/lib/auth";
import {
    parseEditorLoginParams, saveEditorLoginRequest, loadEditorLoginRequest,
    clearEditorLoginRequest, saveEditorHandoff, buildCallbackUrl,
    sanitizeInternalReturn, savePostAuthReturn, takePostAuthReturn, clearPostAuthReturn,
} from "@/lib/editor-login";
import TurnstileWidget, { turnstileEnabled } from "./TurnstileWidget";
import { AuthShell, authInputClass, authPrimaryBtnClass, authErrorBannerClass } from "./AuthShell";

type HubState = "boot" | "hard-error" | "forms";
type Tab = "signin" | "signup";

export default function AuthHub() {
    const [state, setState] = useState<HubState>("boot");
    const [bootMessage, setBootMessage] = useState("Loading…");
    const [hardError, setHardError] = useState("");
    const [banner, setBanner] = useState("");
    const [editorPending, setEditorPending] = useState(false);
    const [tab, setTab] = useState<Tab>("signin");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [formError, setFormError] = useState("");
    const [submitting, setSubmitting] = useState(false);
    // Ref, not state: the Turnstile callback fires outside React's render cycle
    // and the token is only read on submit.
    const turnstileToken = useRef("");
    // Populated by TurnstileWidget's onReady once the widget has rendered.
    const turnstileReset = useRef<(() => void) | null>(null);

    /** Post-login continuation: editor grant → /auth/success; else internal return → /account. */
    const afterAuthenticated = async (token: string): Promise<void> => {
        const pending = loadEditorLoginRequest();
        if (pending) {
            // The editor grant supersedes any previously-saved internal return —
            // discard it now so it can't linger into a later, unrelated login.
            clearPostAuthReturn();
            setState("boot");
            setBootMessage("Connecting to Arcane…");
            try {
                const grant = await apiEditorGrant(token, {
                    attemptId: pending.attemptId,
                    challenge: pending.challenge,
                });
                saveEditorHandoff({
                    deepLink: buildCallbackUrl(pending.target, grant.code, pending.state),
                    code: grant.code,
                });
                clearEditorLoginRequest();
                window.location.href = "/auth/success";
            } catch (err) {
                clearEditorLoginRequest();
                setHardError(
                    `Couldn't finish signing in to the editor: ${authErrorMessage((err as Error).message)} ` +
                    "You are signed in on this site — return to Arcane and click Sign in again."
                );
                setState("hard-error");
            }
            return;
        }
        window.location.href = takePostAuthReturn() ?? "/account";
    };

    useEffect(() => {
        void (async () => {
            const params = new URLSearchParams(window.location.search);

            // (1) Editor deep-link request — validate BEFORE anything else.
            if (params.get("flow") === "editor") {
                const parsed = parseEditorLoginParams(params);
                if (!parsed.ok) {
                    window.history.replaceState(null, "", window.location.pathname);
                    setHardError(parsed.error);
                    setState("hard-error");
                    return;
                }
                saveEditorLoginRequest(parsed.request);
            }

            // (2) Capture, then strip, remaining params (codes/errors must not linger in history).
            const ret = sanitizeInternalReturn(params.get("return"));
            if (ret) savePostAuthReturn(ret);
            const code = params.get("code");
            const errorParam = params.get("error");
            if (window.location.search) {
                window.history.replaceState(null, "", window.location.pathname);
            }

            setEditorPending(loadEditorLoginRequest() !== null);

            // (3) Google return: swap the one-time ?code= for a session token.
            if (code) {
                setBootMessage("Signing you in…");
                try {
                    const data = await apiWebExchange(code);
                    setStoredToken(data.token);
                    await afterAuthenticated(data.token);
                } catch (err) {
                    setBanner(authErrorMessage((err as Error).message));
                    setState("forms");
                }
                return;
            }

            // (4) Redirect errors (e.g. google_not_configured, google_oauth_failed).
            // errorParam is attacker-controllable (it's a raw query param), so unlike
            // API-returned errors we do NOT fall back to echoing it verbatim — only
            // known codes get their mapped copy; anything else gets a generic banner.
            if (errorParam) {
                setBanner(isKnownAuthErrorCode(errorParam) ? authErrorMessage(errorParam) : "Something went wrong signing in.");
                setState("forms");
                return;
            }

            // (5)/(6) Existing session?
            const token = getStoredToken();
            if (token) {
                try {
                    await apiGetMe(token); // server-side validation (catches expiry/version bump)
                    await afterAuthenticated(token);
                    return;
                } catch (err) {
                    const status = (err as { status?: number }).status;
                    if (status === 401 || status === 403) {
                        // Server has confirmed the token is invalid — actually log out.
                        clearStoredToken();
                    } else {
                        // Transient network/5xx failure: don't destroy a possibly-valid
                        // session over it. Keep the token, fall through to the
                        // signed-out forms with a non-destructive banner.
                        setBanner("Couldn't reach the server. Please try again.");
                    }
                }
            }

            // (7) No session — show the forms.
            setState("forms");
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleSubmit = async () => {
        if (submitting) return;
        if (!email || !password) { setFormError("Email and password are required."); return; }
        if (tab === "signup" && password.length < 8) { setFormError(authErrorMessage("weak_password")); return; }
        setSubmitting(true);
        setFormError("");
        try {
            const data = tab === "signin"
                ? await apiLogin(email, password, turnstileToken.current || undefined)
                : await apiSignup(email, password, turnstileToken.current || undefined);
            setStoredToken(data.token);
            await afterAuthenticated(data.token);
        } catch (err) {
            // Turnstile tokens are single-use — the consumed token must not be
            // resent on retry, or every subsequent attempt fails at the server.
            turnstileReset.current?.();
            turnstileToken.current = "";
            setFormError(authErrorMessage((err as Error).message));
            setSubmitting(false);
        }
    };

    if (state === "boot") {
        return (
            <AuthShell>
                <p className="text-muted-foreground text-sm text-center">{bootMessage}</p>
            </AuthShell>
        );
    }

    if (state === "hard-error") {
        return (
            <AuthShell wide>
                <h1 className="font-display text-2xl font-bold mb-3 text-center">Can't continue</h1>
                <div className={authErrorBannerClass}>{hardError}</div>
                <a href="/" className="block mt-4 text-center text-primary text-sm hover:underline">Back to home</a>
            </AuthShell>
        );
    }

    return (
        <AuthShell>
            <h1 className="font-display text-2xl font-bold mb-1 text-center">
                {tab === "signin" ? "Sign in" : "Create account"}
            </h1>
            <p className="text-muted-foreground text-sm mb-6 text-center">
                {editorPending
                    ? "The Arcane editor is asking to sign in. Finish here and you'll be sent back to the app."
                    : "Sign in to Arcane to use AI features"}
            </p>

            {banner && <div className={authErrorBannerClass}>{banner}</div>}

            {/* Tabs */}
            <div className="flex gap-1 border-b border-border/50 mb-5">
                {([["signin", "Sign in"], ["signup", "Create account"]] as [Tab, string][]).map(([id, label]) => (
                    <button
                        key={id}
                        onClick={() => { setTab(id); setFormError(""); }}
                        className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                            tab === id
                                ? "border-primary text-primary"
                                : "border-transparent text-muted-foreground hover:text-foreground"
                        }`}
                    >
                        {label}
                    </button>
                ))}
            </div>

            {formError && <div className={authErrorBannerClass}>{formError}</div>}

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
                <input
                    className={authInputClass}
                    placeholder={tab === "signup" ? "Password (min 8 characters)" : "Password"}
                    type="password"
                    autoComplete={tab === "signup" ? "new-password" : "current-password"}
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") handleSubmit(); }}
                />

                {turnstileEnabled() && (
                    <TurnstileWidget
                        onToken={t => { turnstileToken.current = t; }}
                        onReady={reset => { turnstileReset.current = reset; }}
                    />
                )}

                <button className={authPrimaryBtnClass} onClick={handleSubmit} disabled={submitting}>
                    {submitting ? "Working…" : tab === "signin" ? "Sign In" : "Create Account"}
                </button>
            </div>

            {tab === "signin" && (
                <a href="/forgot" className="block mt-3 text-center text-primary text-sm hover:underline">
                    Forgot password?
                </a>
            )}

            {/* Divider */}
            <div className="flex items-center gap-3 my-5">
                <div className="h-px flex-1 bg-border/50" />
                <span className="text-xs text-muted-foreground">or</span>
                <div className="h-px flex-1 bg-border/50" />
            </div>

            <button
                className="h-10 w-full rounded-md border border-border bg-secondary/50 text-sm font-semibold text-foreground hover:border-primary transition-colors flex items-center justify-center gap-2"
                onClick={() => { window.location.href = googleStartUrl("/auth"); }}
            >
                <svg className="w-4 h-4" viewBox="0 0 24 24" aria-hidden="true">
                    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z" />
                    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
                    <path fill="#FBBC05" d="M5.84 14.1A6.6 6.6 0 0 1 5.5 12c0-.73.13-1.44.34-2.1V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z" />
                    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
                </svg>
                Continue with Google
            </button>

            <a href="/" className="block mt-5 text-center text-muted-foreground text-xs hover:text-foreground">
                Back to home
            </a>
        </AuthShell>
    );
}
