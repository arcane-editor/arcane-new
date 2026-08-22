import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Monaco } from '@monaco-editor/react';
import {
    registerInlineSuggestProvider,
    gateStatus,
    handleFailure,
    FIM_MAX_PREFIX_CHARS,
    FIM_MAX_SUFFIX_CHARS,
} from './inline-provider';
import { useInlineSuggestStore } from '../../../stores/inline-suggest';

function registerAndCapture(): Record<string, unknown> {
    let captured: Record<string, unknown> | undefined;
    const monaco = {
        Range: class { },
        languages: {
            registerInlineCompletionsProvider(_selector: string, provider: Record<string, unknown>) {
                captured = provider;
                return { dispose() { } };
            },
        },
    };
    registerInlineSuggestProvider(monaco as unknown as Monaco);
    if (!captured) throw new Error('provider was never registered');
    return captured;
}

// Registered ONCE at module scope (not per-describe): `registered` in
// inline-provider.ts is a module-level latch that never re-registers, so a
// second `registerAndCapture()` call anywhere else in this file would throw
// "provider was never registered". Every describe block below shares this
// SAME captured provider.
const provider = registerAndCapture();

describe('registerInlineSuggestProvider', () => {
    // Monaco >= 0.53 calls disposeInlineCompletions; the old freeInlineCompletions
    // name is gone, and a missing hook throws mid-typing instead of failing loudly.
    it('exposes the disposal hook Monaco calls', () => {
        expect(typeof provider.disposeInlineCompletions).toBe('function');
    });

    it('survives being called with a completions list', () => {
        const dispose = provider.disposeInlineCompletions as (a: unknown, b: unknown) => void;
        expect(() => dispose({ items: [] }, { kind: 'other' })).not.toThrow();
    });
});

// The server (arcane-server/src/lib/fim.ts) clamps to 1600 prefix / 800
// suffix chars (~600 tokens) and re-clamps defensively — but the client
// clamp is what actually bounds the request payload sent over the wire, so
// the two must be kept numerically in sync by hand.
describe('FIM context clamp', () => {
    it('matches the server clamp exactly (1600 prefix / 800 suffix chars)', () => {
        expect(FIM_MAX_PREFIX_CHARS).toBe(1600);
        expect(FIM_MAX_SUFFIX_CHARS).toBe(800);
    });
});

// ---------------------------------------------------------------------------
// Plan lock. NOTE ON APPROACH: an end-to-end call through the registered
// `provider.provideInlineCompletions(...)` would need to control
// `useAuthStore` (for `gate.loggedIn`/`plan`) — but `arcane-stream.test.ts`
// (loaded in the same `bun test` process) permanently `mock.module`'s
// `stores/auth` with NO restore (same hazard its sibling `stores/ai.ts` mock
// is documented against, see `session-persistence.test.ts`'s header), leaving
// `useAuthStore.getState()` a stub with no `loggedIn`/`plan` fields for the
// rest of the process. `gate.loggedIn` would read `undefined` and the gate
// would always fail at THAT check before ever reaching `planAllows` — an
// end-to-end assertion here would be exercising the mock, not the feature.
// `gateStatus` and `handleFailure` are exported from inline-provider.ts
// specifically to give this the same pure, DI-free seam `gating.test.ts` and
// `inline-client.test.ts` already have — neither touches `stores/auth`, only
// `stores/inline-suggest` (unmocked anywhere in this suite). The ASSEMBLY
// line that actually reads `useAuthStore`/`useServerConfigStore` to build
// `planAllows` is checked via source text instead (same technique as
// `EffortSelector.test.ts`).
// ---------------------------------------------------------------------------

const SRC = readFileSync(path.resolve(import.meta.dir, './inline-provider.ts'), 'utf8');

function resetInlineSuggestStore(): void {
    useInlineSuggestStore.setState({ status: 'active', quotaResetAt: null });
}

describe('inline-provider: gateStatus', () => {
    const OPEN = { enabled: true, loggedIn: true, online: true, breakerAllows: true, quotaActive: false, planAllows: true };

    it("planAllows: false -> 'upgrade-required'", () => {
        expect(gateStatus({ ...OPEN, planAllows: false })).toBe('upgrade-required');
    });

    it('planAllows: false takes priority over quota/breaker (checked before both)', () => {
        expect(gateStatus({ ...OPEN, planAllows: false, quotaActive: true })).toBe('upgrade-required');
        expect(gateStatus({ ...OPEN, planAllows: false, breakerAllows: false })).toBe('upgrade-required');
    });

    it('signed-out and offline still take priority over a plan lock (checked first)', () => {
        expect(gateStatus({ ...OPEN, planAllows: false, loggedIn: false })).toBe('signed-out');
        expect(gateStatus({ ...OPEN, planAllows: false, online: false })).toBe('offline');
    });

    it('the all-clear gate (planAllows true) is unaffected — still active', () => {
        expect(gateStatus(OPEN)).toBe('active');
    });
});

describe('inline-provider: handleFailure', () => {
    it("reason 'plan' -> setStatus('upgrade-required'), same treatment as 'auth' (no breaker escalation)", () => {
        resetInlineSuggestStore();
        handleFailure({ ok: false, reason: 'plan' });
        expect(useInlineSuggestStore.getState().status).toBe('upgrade-required');
        // 'plan'/'auth' are both stable, known conditions — no resetAt tracking.
        expect(useInlineSuggestStore.getState().quotaResetAt).toBeNull();
    });

    it("reason 'auth' still maps to 'signed-out' (unaffected by the new case)", () => {
        resetInlineSuggestStore();
        handleFailure({ ok: false, reason: 'auth' });
        expect(useInlineSuggestStore.getState().status).toBe('signed-out');
    });
});

describe('inline-provider: planAllows wiring (source text)', () => {
    it('assembles planAllows from inlineAllowed(config, plan) — unknown config resolves to true (never blanks a startup race)', () => {
        expect(SRC).toMatch(
            /planAllows:\s*inlineAllowed\(useServerConfigStore\.getState\(\)\.config,\s*useAuthStore\.getState\(\)\.plan\)/,
        );
    });

    it("the plan gate short-circuits BEFORE the debounce/fetch — 'if (!shouldRequestInline(gate))' appears before any waitForIdle/fetchCompletion call", () => {
        const gateCheckIndex = SRC.indexOf('if (!shouldRequestInline(gate))');
        const waitForIdleIndex = SRC.indexOf('await waitForIdle(');
        const fetchIndex = SRC.indexOf('inlineClient.fetchCompletion(');
        expect(gateCheckIndex).toBeGreaterThan(-1);
        expect(gateCheckIndex).toBeLessThan(waitForIdleIndex);
        expect(gateCheckIndex).toBeLessThan(fetchIndex);
    });
});
