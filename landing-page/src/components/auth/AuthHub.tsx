import { useState, useEffect, useRef } from "react";
import { Github } from "lucide-react";
import {
    getStoredToken, setStoredToken, clearStoredToken,
    apiLogin, apiSignup, apiGetMe, apiWebExchange, apiEditorGrant,
    apiVerifyEmail, apiResendVerification,
    authErrorMessage, isKnownAuthErrorCode, githubStartUrl,
} from "@/lib/auth";
import {
    parseEditorLoginParams, saveEditorLoginRequest, loadEditorLoginRequest,
    clearEditorLoginRequest, saveEditorHandoff, buildCallbackUrl,
    sanitizeInternalReturn, savePostAuthReturn, takePostAuthReturn, clearPostAuthReturn,
} from "@/lib/editor-login";
import TurnstileWidget, { turnstileEnabled } from "./TurnstileWidget";
import { AuthShell, authInputClass, authPrimaryBtnClass, authErrorBannerClass, authOAuthBtnClass } from "./AuthShell";

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
    const [resending, setResending] = useState(false);
    // Set after a successful signup: the address awaiting its emailed code.
    // Non-empty switches the card to code entry, which stays in THIS tab — so
    // a pending editor sign-in survives in sessionStorage, and the new account
    // reaches a verified state without ever leaving the flow.
    const [pendingVerifyEmail, setPendingVerifyEmail] = useState("");
    const [pendingVerifyToken, setPendingVerifyToken] = useState("");
    const [verifyCode, setVerifyCode] = useState("");
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

            // (3) OAuth return (GitHub or Google): swap the one-time ?code= for
            // a session token. A pending editor request survives the round-trip
            // in sessionStorage, so afterAuthenticated still reaches the grant.
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

            // (4) Redirect errors (e.g. github_oauth_failed, github_email_unverified).
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
            // A brand-new account is signed in but unverified, and every AI
            // route is gated on verification — so send them straight to the
            // code rather than to an account page that can't do anything yet.
            if (tab === "signup") {
                setPendingVerifyToken(data.token);
                setPendingVerifyEmail(email);
                setVerifyCode("");
                setSubmitting(false);
                return;
            }
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

    const handleVerifyCode = async () => {
        if (submitting) return;
        if (verifyCode.length !== 6) { setFormError("Enter the 6-digit code from your email."); return; }
        setSubmitting(true);
        setFormError("");
        try {
            const data = await apiVerifyEmail(verifyCode, pendingVerifyToken);
            // Swap in the fresh JWT — it carries the verified claim, and the
            // old one may now fail the token_version check.
            setStoredToken(data.token);
            await afterAuthenticated(data.token);
        } catch (err) {
            setFormError(authErrorMessage((err as Error).message));
            setSubmitting(false);
        }
    };

    const handleResendCode = async () => {
        if (resending) return;
        setResending(true);
        setFormError("");
        try {
            await apiResendVerification(pendingVerifyToken);
            setVerifyCode("");
        } catch (err) {
            setFormError(authErrorMessage((err as Error).message));
        } finally {
            setResending(false);
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

    if (pendingVerifyEmail) {
        return (
            <AuthShell>
                <h1 className="font-display text-2xl font-bold mb-1 text-center">Verify your email</h1>
                <p className="text-muted-foreground text-sm mb-6 text-center">
                    We sent a 6-digit code to <span className="text-foreground">{pendingVerifyEmail}</span>.
                    It expires in 15 minutes.
                </p>

                {formError && <div className={authErrorBannerClass}>{formError}</div>}

                <div className="flex flex-col gap-3">
                    <input
                        className={`${authInputClass} text-center text-lg tracking-[0.4em] font-mono`}
                        placeholder="000000"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        maxLength={6}
                        autoFocus
                        value={verifyCode}
                        onChange={e => setVerifyCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                        onKeyDown={e => { if (e.key === "Enter") handleVerifyCode(); }}
                    />
                    <button className={authPrimaryBtnClass} onClick={handleVerifyCode} disabled={submitting}>
                        {submitting ? "Verifying…" : "Verify email"}
                    </button>
                </div>

                <button
                    className="mt-4 block w-full text-center text-primary text-sm hover:underline disabled:opacity-50"
                    onClick={handleResendCode}
                    disabled={resending}
                >
                    {resending ? "Sending…" : "Send a new code"}
                </button>
                <p className="text-muted-foreground text-xs text-center mt-3">
                    Your account is created — AI features unlock once the email is verified.
                </p>
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

            {/* One button for both tabs: the callback signs in or creates the
                account from the same verified GitHub identity. Full-page
                navigation — a pending editor request lives in sessionStorage,
                so it survives the round-trip. */}
            <button
                className={authOAuthBtnClass}
                onClick={() => { window.location.href = githubStartUrl("/auth"); }}
                disabled={submitting}
            >
                <Github className="w-4 h-4" aria-hidden="true" />
                Continue with GitHub
            </button>

            <div className="flex items-center gap-3 my-4">
                <span className="h-px flex-1 bg-border/50" />
                <span className="text-[11px] uppercase tracking-wider text-muted-foreground">or</span>
                <span className="h-px flex-1 bg-border/50" />
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

            <a href="/" className="block mt-5 text-center text-muted-foreground text-xs hover:text-foreground">
                Back to home
            </a>
        </AuthShell>
    );
}
