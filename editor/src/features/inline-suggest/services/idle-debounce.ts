// Debounce implemented against Monaco's CancellationToken (structural type so
// bun tests need no monaco import): the provider awaits this before any
// network call; continued typing cancels the token and we never fetch.
export interface CancellationTokenLike {
    isCancellationRequested: boolean;
    onCancellationRequested?: (listener: () => void) => { dispose(): void };
}

export function waitForIdle(delayMs: number, token: CancellationTokenLike): Promise<boolean> {
    return new Promise((resolve) => {
        if (token.isCancellationRequested) { resolve(false); return; }
        let sub: { dispose(): void } | undefined;
        const timer = setTimeout(() => {
            sub?.dispose();
            resolve(!token.isCancellationRequested);
        }, delayMs);
        sub = token.onCancellationRequested?.(() => {
            clearTimeout(timer);
            resolve(false);
        });
    });
}
