/**
 * Placeholder bar for content that is still loading.
 *
 * Skeletons rather than a spinner: they hold the real layout's shape, so the
 * page doesn't jump when data lands and the wait reads as "nearly there"
 * instead of "nothing is happening".
 *
 * Put `animate-pulse` on a wrapper rather than on each bar when several sit
 * together — independently pulsing bars shimmer against each other and look
 * broken. `motion-reduce` drops the animation entirely.
 */
export function Skeleton({ className = "" }: { className?: string }) {
    return (
        <span
            aria-hidden="true"
            className={`block rounded bg-muted-foreground/15 ${className}`}
        />
    );
}

/** Wrapper that pulses everything inside it in sync. */
export function SkeletonGroup({
    children,
    className = "",
    label = "Loading",
}: {
    children: React.ReactNode;
    className?: string;
    label?: string;
}) {
    return (
        <div
            role="status"
            aria-busy="true"
            aria-label={label}
            className={`animate-pulse motion-reduce:animate-none ${className}`}
        >
            {children}
        </div>
    );
}
