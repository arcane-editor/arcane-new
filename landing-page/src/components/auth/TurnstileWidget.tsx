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
            existing.addEventListener("load", () => resolve());
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

export default function TurnstileWidget({ onToken }: { onToken: (token: string) => void }) {
    const container = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!turnstileEnabled()) return;
        let widgetId: string | null = null;
        let cancelled = false;
        void loadScript()
            .then(() => {
                if (cancelled || !container.current || !window.turnstile) return;
                widgetId = window.turnstile.render(container.current, {
                    sitekey: SITE_KEY,
                    theme: "dark",
                    callback: (token: string) => onToken(token),
                    "expired-callback": () => onToken(""),
                    "error-callback": () => onToken(""),
                });
            })
            .catch(() => { /* script blocked/offline: degrade, server decides */ });
        return () => {
            cancelled = true;
            if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    if (!turnstileEnabled()) return null;
    return <div ref={container} className="min-h-[65px]" />;
}
