import type { Monaco } from '@monaco-editor/react';
import type { CancellationToken, editor, IDisposable, languages, Position } from 'monaco-editor';
import { inlineClient, type InlineResult } from './inline-client';
import { createSuggestCache, cacheKey } from './suggest-cache';
import { createCircuitBreaker } from './circuit-breaker';
import { waitForIdle } from './idle-debounce';
import { shouldRequestInline } from './gating';
import { useAuthStore } from '../../../stores/auth';
import { useSettingsStore } from '../../../stores/settings';
import { useConnectivityStore } from '../../../stores/connectivity';
import { useServerConfigStore, inlineAllowed } from '../../../stores/server-config';
import { useInlineSuggestStore, type InlineSuggestStatus } from '../../../stores/inline-suggest';

const DEBOUNCE_MS = 250;
// Must stay numerically in sync with the server's FIM_MAX_PREFIX_CHARS /
// FIM_MAX_SUFFIX_CHARS (arcane-server/src/lib/fim.ts) — ~600 tokens total.
// The server re-clamps defensively (it never trusts the client), so a stale
// value here doesn't break anything server-side, but it does mean requests
// are either needlessly truncated further than necessary or send more chars
// than the server will ever bill/use, wasting bytes on the wire for no gain.
export const FIM_MAX_PREFIX_CHARS = 1600;
export const FIM_MAX_SUFFIX_CHARS = 800;

const cache = createSuggestCache();
const breaker = createCircuitBreaker();

let registered = false;

// Exported (alongside `handleFailure` below) purely so both can be
// unit-tested directly with an explicit gate object / result — neither reads
// `stores/auth.ts`, which `arcane-stream.test.ts` permanently `mock.module`'s
// process-wide with no restore (see that file's header), so any test in this
// SAME `bun test` process that exercised `provideInlineCompletions` end-to-end
// would read a stubbed `useAuthStore.getState()` with no `loggedIn`/`plan`
// fields at all — always failing the gate before ever reaching the
// `planAllows` logic under test. These two functions are the pure, testable
// seam on the near side of that landmine.
export function gateStatus(gate: { enabled: boolean; loggedIn: boolean; online: boolean; breakerAllows: boolean; quotaActive: boolean; planAllows: boolean }): InlineSuggestStatus {
    if (!gate.enabled) return 'disabled';
    if (!gate.loggedIn) return 'signed-out';
    if (!gate.online) return 'offline';
    if (!gate.planAllows) return 'upgrade-required';
    // gate.quotaActive is a single boolean (gating.ts's InlineGate stays a
    // pure yes/no gate), but the store already knows WHICH pause is in force
    // — quota (daily) vs budget-exhausted (monthly) — since it's the same
    // store that set quotaActive true in the first place. Re-read it here so
    // the status bar keeps the specific, correct copy instead of collapsing
    // both into 'quota'.
    if (gate.quotaActive) {
        const live = useInlineSuggestStore.getState().status;
        return live === 'budget-exhausted' ? 'budget-exhausted' : 'quota';
    }
    if (!gate.breakerAllows) return 'backoff';
    return 'active';
}

export function handleFailure(result: Extract<InlineResult, { ok: false }>): void {
    const store = useInlineSuggestStore.getState();
    switch (result.reason) {
        case 'aborted':
            return; // superseded — not a failure
        case 'quota':
            store.setStatus('quota', result.resetAt ?? null);
            return;
        case 'budget':
            store.setStatus('budget-exhausted', result.resetAt ?? null);
            return;
        case 'auth':
            store.setStatus('signed-out');
            return;
        case 'plan':
            // Same treatment as 'auth': a stable, known condition (not a flaky
            // server), so no circuit-breaker escalation — just the status the
            // account is actually stuck in until it upgrades.
            store.setStatus('upgrade-required');
            return;
        case 'offline':
            useConnectivityStore.getState().reportFetchFailure();
            store.setStatus('offline');
            return;
        case 'timeout':
        case 'server':
            breaker.recordFailure();
            if (!breaker.allows()) store.setStatus('backoff');
            return;
    }
}

export function registerInlineSuggestProvider(monaco: Monaco): IDisposable | undefined {
    // beforeMount runs on every EditorPanel remount; language providers are
    // global — never double-register (same policy the other providers need).
    if (registered) return undefined;
    registered = true;

    // Annotated explicitly: @monaco-editor/react's `Monaco` type resolves to `any`,
    // so the provider argument is unchecked at the call site. This is what catches
    // Monaco renaming a hook out from under us.
    const provider: languages.InlineCompletionsProvider = {
        async provideInlineCompletions(model: editor.ITextModel, position: Position, _context: languages.InlineCompletionContext, token: CancellationToken) {
            const empty: languages.InlineCompletions = { items: [] };

            const gate = {
                enabled: useSettingsStore.getState().settings['ai.inlineSuggestions.enabled'],
                loggedIn: useAuthStore.getState().loggedIn,
                online: useConnectivityStore.getState().online,
                breakerAllows: breaker.allows(),
                quotaActive: useInlineSuggestStore.getState().quotaActive(),
                // Unknown config ⇒ true (the server's 403 is authoritative) —
                // this only ever short-circuits a plan the config has
                // CONFIRMED excludes inline, never a startup race.
                planAllows: inlineAllowed(useServerConfigStore.getState().config, useAuthStore.getState().plan),
                scheme: model.uri.scheme,
                contentLength: model.getValueLength(),
            };
            if (!shouldRequestInline(gate)) {
                useInlineSuggestStore.getState().setStatus(gateStatus(gate));
                return empty;
            }
            if (useInlineSuggestStore.getState().status !== 'active') {
                useInlineSuggestStore.getState().setStatus('active');
            }

            const fullText = model.getValue();
            const offset = model.getOffsetAt(position);
            const prefix = fullText.slice(Math.max(0, offset - FIM_MAX_PREFIX_CHARS), offset);
            const suffix = fullText.slice(offset, offset + FIM_MAX_SUFFIX_CHARS);
            const path = model.uri.path;
            const range = new monaco.Range(
                position.lineNumber, position.column, position.lineNumber, position.column,
            );

            // Local answers first — no debounce needed for zero-cost paths.
            const typed = cache.tryTypeThrough(path, prefix, suffix);
            if (typed) return { items: [{ insertText: typed, range }] };
            const key = cacheKey(path, prefix, suffix);
            const cached = cache.get(key);
            if (cached !== null) {
                return cached === '' ? empty : { items: [{ insertText: cached, range }] };
            }

            if (!(await waitForIdle(DEBOUNCE_MS, token))) return empty;

            const result = await inlineClient.fetchCompletion({
                prefix, suffix, language: model.getLanguageId(), path,
            });
            if (!result.ok) {
                handleFailure(result);
                return empty;
            }
            breaker.recordSuccess();
            cache.set(key, result.text, { path, prefix, suffix });
            if (token.isCancellationRequested || result.text === '') return empty;
            return { items: [{ insertText: result.text, range }] };
        },
        disposeInlineCompletions() {
            // items are plain objects — nothing to dispose
        },
    };

    return monaco.languages.registerInlineCompletionsProvider('*', provider);
}
