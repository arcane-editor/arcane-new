// After `threshold` consecutive failures, pause requests for `cooldownMs`.
// Post-cooldown requests are allowed (half-open): one success closes the
// breaker, one failure re-arms the cooldown. The single-flight client keeps
// the half-open probe volume at one request at a time.
export function createCircuitBreaker(
    cfg: { threshold?: number; cooldownMs?: number; now?: () => number } = {},
) {
    const threshold = cfg.threshold ?? 3;
    const cooldownMs = cfg.cooldownMs ?? 60_000;
    const now = cfg.now ?? Date.now;

    let failures = 0;
    let openedAt: number | null = null;

    return {
        allows(): boolean {
            if (openedAt === null) return true;
            return now() - openedAt >= cooldownMs;
        },
        recordSuccess(): void {
            failures = 0;
            openedAt = null;
        },
        recordFailure(): void {
            failures += 1;
            if (failures >= threshold) openedAt = now();
        },
    };
}
