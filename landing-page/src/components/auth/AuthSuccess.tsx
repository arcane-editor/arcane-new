import { useState, useEffect } from "react";
import { loadEditorHandoff, clearEditorHandoff, type EditorHandoff } from "@/lib/editor-login";
import { AuthShell } from "./AuthShell";

export default function AuthSuccess() {
    const [handoff, setHandoff] = useState<EditorHandoff | null | "loading">("loading");
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        const h = loadEditorHandoff();
        setHandoff(h);
        // One-shot: clear immediately so a refresh (or another tab) can't replay
        // the code. The React state keeps this render working.
        clearEditorHandoff();
        // Auto-attempt the deep link; most browsers require a user gesture for
        // custom schemes, so the button below is the reliable path.
        if (h) window.location.href = h.deepLink;
    }, []);

    if (handoff === "loading") {
        return (
            <AuthShell>
                <p className="text-muted-foreground text-sm text-center">Loading…</p>
            </AuthShell>
        );
    }

    if (handoff === null) {
        return (
            <AuthShell>
                <h1 className="font-display text-2xl font-bold mb-2 text-center">Nothing to hand off</h1>
                <p className="text-muted-foreground text-sm text-center">
                    This page finishes an editor sign-in, but there's no pending sign-in here
                    (codes are single-use). Start again from Arcane, or sign in on the site.
                </p>
                <a href="/auth" className="block mt-4 text-center text-primary text-sm hover:underline">Go to sign in</a>
            </AuthShell>
        );
    }

    const copyCode = async () => {
        try {
            await navigator.clipboard.writeText(handoff.code);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            /* clipboard blocked: the code is selectable text below */
        }
    };

    return (
        <AuthShell wide>
            <h1 className="font-display text-2xl font-bold mb-2 text-center">You're signed in</h1>
            <p className="text-muted-foreground text-sm mb-6 text-center">
                Sending you back to the Arcane editor…
            </p>

            <button
                className="h-11 w-full rounded-md bg-primary text-primary-foreground text-base font-semibold hover:bg-primary/90 glow-orange-sm transition-all"
                onClick={() => { window.location.href = handoff.deepLink; }}
            >
                Open Arcane
            </button>

            <div className="mt-6 border-t border-border/50 pt-5">
                <p className="text-sm font-medium text-foreground mb-2">Didn't open?</p>
                <p className="text-muted-foreground text-xs mb-3">
                    Paste this one-time code into Arcane instead. It works once and expires in about a minute.
                </p>
                <div className="flex gap-2">
                    <code className="flex-1 rounded-md border border-border bg-secondary/50 px-3 py-2 text-sm font-mono text-foreground break-all select-all">
                        {handoff.code}
                    </code>
                    <button
                        className="h-9 shrink-0 rounded-md px-3 text-xs font-semibold bg-secondary text-secondary-foreground hover:bg-secondary/80 transition-all self-center"
                        onClick={copyCode}
                    >
                        {copied ? "Copied!" : "Copy"}
                    </button>
                </div>
            </div>

            <a href="/account" className="block mt-5 text-center text-muted-foreground text-xs hover:text-foreground">
                Manage your account
            </a>
        </AuthShell>
    );
}
