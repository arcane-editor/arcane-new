import { useEffect, useRef } from "react";

// Graceful degradation: when PUBLIC_TURNSTILE_SITE_KEY is unset (owner hasn't
// created the widget yet) this component renders NOTHING and forms submit
// without a cf-turnstile-response. The server only enforces Turnstile when
// its own TURNSTILE_SECRET is set.
const SITE_KEY: string | undefined = import.meta.env.PUBLIC_TURNSTILE_SITE_KEY;
const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

declare global {
    interface Window {
        turnstile?: {
            render: (el: HTMLElement, opts: Record<string, unknown>) => string;
            remove: (id: string) => void;
            reset: (id: string) => void;
        };
    }
}

export function turnstileEnabled(): boolean {
    return typeof SITE_KEY === "string" && SITE_KEY.length > 0;
}

function loadScript(): Promise<void> {
    return new Promise((resolve, reject) => {
        if (window.turnstile) { resolve(); return; }
        const existing = document.querySelector(`script[src="${SCRIPT_SRC}"]`);
        if (existing) {
            // The script tag exists but `window.turnstile` isn't ready yet (checked
            // above). On a remount its one-time `load` event may already have fired,
            // so a `load` listener alone could never run — poll for the API as the
            // reliable fallback, and clear the poll from whichever path resolves.
            const poll = setInterval(() => {
                if (window.turnstile) { clearInterval(poll); resolve(); }
            }, 50);
            const stop = setTimeout(() => clearInterval(poll), 10_000);
            existing.addEventListener("load", () => {
                clearInterval(poll);
                clearTimeout(stop);
                resolve();
            });
            return;
        }
        const s = document.createElement("script");
        s.src = SCRIPT_SRC;
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error("turnstile script failed to load"));
        document.head.appendChild(s);
    });
}

// Turnstile tokens are single-use: a failed submit must reset the widget so
// the next attempt gets a fresh one. `onReady` hands the parent a reset
// function once the widget has rendered — a callback prop (not a ref) so the
// component stays a plain function component like the rest of this file.
export default function TurnstileWidget({
    onToken,
    onReady,
}: {
    onToken: (token: string) => void;
    onReady?: (reset: () => void) => void;
}) {
    const container = useRef<HTMLDivElement>(null);
    const widgetId = useRef<string | null>(null);

    useEffect(() => {
        if (!turnstileEnabled()) return;
        let cancelled = false;
        void loadScript()
            .then(() => {
                if (cancelled || !container.current || !window.turnstile) return;
                widgetId.current = window.turnstile.render(container.current, {
                    sitekey: SITE_KEY,
                    theme: "dark",
                    callback: (token: string) => onToken(token),
                    "expired-callback": () => onToken(""),
                    "error-callback": () => onToken(""),
                });
                onReady?.(() => {
                    if (widgetId.current && window.turnstile) window.turnstile.reset(widgetId.current);
                });
            })
            .catch(() => { /* script blocked/offline: degrade, server decides */ });
        return () => {
            cancelled = true;
            if (widgetId.current && window.turnstile) window.turnstile.remove(widgetId.current);
            widgetId.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    if (!turnstileEnabled()) return null;
    return <div ref={container} className="min-h-[65px]" />;
}
