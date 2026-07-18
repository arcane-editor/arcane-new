import type { ReactNode } from "react";

/** Centered glass card used by all auth-flow pages (matches admin login card). */
export function AuthShell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
    return (
        <div className="min-h-screen flex items-center justify-center px-4 py-16">
            <div className={`glass rounded-2xl p-8 w-full ${wide ? "max-w-md" : "max-w-sm"}`}>
                {children}
            </div>
        </div>
    );
}

/** Shared field styling (copied from AdminPanel's login form). */
export const authInputClass =
    "h-10 rounded-md border border-border bg-secondary/50 px-3 text-sm text-foreground outline-none focus:border-primary transition-colors w-full";

export const authPrimaryBtnClass =
    "h-10 w-full rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-all disabled:opacity-50";

export const authErrorBannerClass =
    "mb-4 rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2.5 text-sm text-destructive";
