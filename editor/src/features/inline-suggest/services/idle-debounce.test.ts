import { describe, it, expect } from 'bun:test';
import { waitForIdle, type CancellationTokenLike } from './idle-debounce';

function makeToken(): CancellationTokenLike & { cancel(): void } {
    let cancelled = false;
    const listeners: Array<() => void> = [];
    return {
        get isCancellationRequested() { return cancelled; },
        onCancellationRequested(listener) {
            listeners.push(listener);
            return { dispose() { const i = listeners.indexOf(listener); if (i !== -1) listeners.splice(i, 1); } };
        },
        cancel() { cancelled = true; for (const l of [...listeners]) l(); },
    };
}

describe('waitForIdle', () => {
    it('resolves true after the delay when not cancelled', async () => {
        expect(await waitForIdle(10, makeToken())).toBe(true);
    });
    it('resolves false immediately for an already-cancelled token', async () => {
        const t = makeToken(); t.cancel();
        expect(await waitForIdle(1000, t)).toBe(false);
    });
    it('resolves false promptly when cancelled mid-wait', async () => {
        const t = makeToken();
        const started = Date.now();
        const p = waitForIdle(5000, t);
        setTimeout(() => t.cancel(), 10);
        expect(await p).toBe(false);
        expect(Date.now() - started).toBeLessThan(1000);
    });
});
