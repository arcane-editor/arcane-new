import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    startHeartbeat,
    SSE_HEARTBEAT_FRAME,
    SSE_HEARTBEAT_INTERVAL_MS,
    UPSTREAM_STALL_TIMEOUT_MS,
} from '../src/lib/sse-heartbeat.ts';

// The bug this module exists for: `streamSSE` hands the client response
// HEADERS the moment the route returns, but the first BYTE only lands when
// the upstream model emits its first token. The editor starts a first-token
// watchdog off those headers, so that watchdog was timing MODEL LATENCY, not
// connection health — a reasoning model with a large prompt blew past it and
// the turn died with "Stream stalled before the first token". Heartbeat
// comment frames put bytes on the wire while the model is still thinking.

describe('startHeartbeat', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('writes a heartbeat frame on every tick while the upstream is silent', () => {
        const writes: string[] = [];
        const hb = startHeartbeat({
            write: (frame) => writes.push(frame),
            onStall: () => {},
            intervalMs: 1_000,
            stallAfterMs: 60_000,
        });

        vi.advanceTimersByTime(3_000);
        hb.stop();

        expect(writes).toEqual([SSE_HEARTBEAT_FRAME, SSE_HEARTBEAT_FRAME, SSE_HEARTBEAT_FRAME]);
    });

    it('emits a comment frame the editor SSE parser ignores', () => {
        // `hosted-stream.ts` only reads lines starting with `data: `, and its
        // malformed-line counter sits behind that same check — so a heartbeat
        // must never look like a data line, or it would be counted as a
        // corrupt event and surface as "Response corrupted".
        expect(SSE_HEARTBEAT_FRAME.startsWith(':')).toBe(true);
        expect(SSE_HEARTBEAT_FRAME.startsWith('data:')).toBe(false);
        expect(SSE_HEARTBEAT_FRAME.endsWith('\n\n')).toBe(true);
    });

    it('never stalls a stream whose upstream keeps producing events', () => {
        const stalls: number[] = [];
        const hb = startHeartbeat({
            write: () => {},
            onStall: (idleMs) => stalls.push(idleMs),
            intervalMs: 1_000,
            stallAfterMs: 5_000,
        });

        // An event every 4s: always under the 5s cap, for far longer than the
        // cap itself. `sawEvent` must reset the clock each time.
        for (let i = 0; i < 10; i++) {
            vi.advanceTimersByTime(4_000);
            hb.sawEvent();
        }
        hb.stop();

        expect(stalls).toEqual([]);
    });

    it('reports a stall once the upstream has been silent past the cap, and stops writing', () => {
        const writes: string[] = [];
        const stalls: number[] = [];
        const hb = startHeartbeat({
            write: (frame) => writes.push(frame),
            onStall: (idleMs) => stalls.push(idleMs),
            intervalMs: 1_000,
            stallAfterMs: 3_000,
        });

        vi.advanceTimersByTime(10_000);

        // Ticks at 1s and 2s wrote; the 3s tick hit the cap and stalled instead.
        expect(writes.length).toBe(2);
        expect(stalls.length).toBe(1);
        expect(stalls[0]).toBeGreaterThanOrEqual(3_000);

        hb.stop();
    });

    it('stop() is idempotent and halts further writes', () => {
        const writes: string[] = [];
        const hb = startHeartbeat({
            write: (frame) => writes.push(frame),
            onStall: () => {},
            intervalMs: 1_000,
            stallAfterMs: 60_000,
        });

        vi.advanceTimersByTime(1_000);
        expect(writes.length).toBe(1);

        hb.stop();
        hb.stop();
        vi.advanceTimersByTime(10_000);

        expect(writes.length).toBe(1);
    });

    it('defaults sit inside the editor watchdog windows they exist to satisfy', () => {
        // hosted-stream.ts guards the first read with `firstTokenTimeoutMs`
        // and every later read with `idleTimeoutMs` (90s). A heartbeat that
        // ticked slower than either would defeat its own purpose — and these
        // defaults have to hold for ALREADY-INSTALLED editors, which is the
        // whole reason the fix lives server-side.
        expect(SSE_HEARTBEAT_INTERVAL_MS).toBeLessThan(25_000); // old clients' first-token window
        expect(SSE_HEARTBEAT_INTERVAL_MS).toBeLessThan(90_000); // idle-gap window
        // The stall cap must be far LOOSER than the client watchdogs it
        // replaces as the real liveness check — it bounds a hung provider
        // (the documented ~53-minute Workers AI hang), not model latency.
        expect(UPSTREAM_STALL_TIMEOUT_MS).toBeGreaterThan(90_000);
    });
});
