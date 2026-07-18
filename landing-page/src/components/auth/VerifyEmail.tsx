import { useState, useEffect } from "react";
import { apiVerifyEmail, setStoredToken, authErrorMessage } from "@/lib/auth";
import { loadEditorLoginRequest } from "@/lib/editor-login";
import { AuthShell, authErrorBannerClass } from "./AuthShell";

type Status = "working" | "done" | "error";

export default function VerifyEmail() {
    const [status, setStatus] = useState<Status>("working");
    const [message, setMessage] = useState("");

    useEffect(() => {
        void (async () => {
            const params = new URLSearchParams(window.location.search);
            const token = params.get("token");
            window.history.replaceState(null, "", window.location.pathname);
            if (!token) {
                setStatus("error");
                setMessage("This verification link is missing its token. Open the link from the email again.");
                return;
            }
            try {
                const data = await apiVerifyEmail(token);
                // Swap any stored session for the fresh JWT (it carries the
                // verified claim; the old token may now fail version checks).
                setStoredToken(data.token);
                if (loadEditorLoginRequest()) {
                    // An editor sign-in was mid-flight — resume it through the hub.
                    window.location.href = "/auth";
                    return;
                }
                setStatus("done");
            } catch (err) {
                setStatus("error");
                setMessage(authErrorMessage((err as Error).message));
            }
        })();
    }, []);

    if (status === "working") {
        return (
            <AuthShell>
                <p className="text-muted-foreground text-sm text-center">Verifying your email…</p>
            </AuthShell>
        );
    }

    if (status === "error") {
        return (
            <AuthShell>
                <h1 className="font-display text-2xl font-bold mb-3 text-center">Verification failed</h1>
                <div className={authErrorBannerClass}>{message}</div>
                <p className="text-muted-foreground text-xs text-center mt-2">
                    You can request a new verification email from your account page.
                </p>
                <a href="/account" className="block mt-4 text-center text-primary text-sm hover:underline">Go to your account</a>
            </AuthShell>
        );
    }

    return (
        <AuthShell>
            <h1 className="font-display text-2xl font-bold mb-2 text-center">Email verified</h1>
            <p className="text-muted-foreground text-sm text-center">
                You're all set — AI features are now unlocked.
            </p>
            <a href="/account" className="block mt-4 text-center text-primary text-sm hover:underline">Go to your account</a>
        </AuthShell>
    );
}
