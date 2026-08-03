import { describe, it, expect } from 'bun:test';
import { createCircuitBreaker } from './circuit-breaker';

describe('circuit breaker', () => {
    it('opens after 3 consecutive failures, allows again after cooldown', () => {
        let t = 0;
        const b = createCircuitBreaker({ threshold: 3, cooldownMs: 60_000, now: () => t });
        expect(b.allows()).toBe(true);
        b.recordFailure(); b.recordFailure();
        expect(b.allows()).toBe(true);
        b.recordFailure();
        expect(b.allows()).toBe(false);
        t = 59_999; expect(b.allows()).toBe(false);
        t = 60_001; expect(b.allows()).toBe(true);          // half-open probe window
        b.recordFailure();                                   // probe failed → re-armed
        expect(b.allows()).toBe(false);
        t = 120_002; expect(b.allows()).toBe(true);
        b.recordSuccess();                                   // probe succeeded → closed
        expect(b.allows()).toBe(true);
        b.recordFailure(); b.recordFailure();
        expect(b.allows()).toBe(true);                       // count reset by success
    });
});
