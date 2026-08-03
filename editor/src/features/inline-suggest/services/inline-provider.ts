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
import { useInlineSuggestStore, type InlineSuggestStatus } from '../../../stores/inline-suggest';

const DEBOUNCE_MS = 250;
const PREFIX_CHARS = 4000;
const SUFFIX_CHARS = 2000;

const cache = createSuggestCache();
const breaker = createCircuitBreaker();

let registered = false;

function gateStatus(gate: { enabled: boolean; loggedIn: boolean; online: boolean; breakerAllows: boolean; quotaActive: boolean }): InlineSuggestStatus {
    if (!gate.enabled) return 'disabled';
    if (!gate.loggedIn) return 'signed-out';
    if (!gate.online) return 'offline';
    if (gate.quotaActive) return 'quota';
    if (!gate.breakerAllows) return 'backoff';
    return 'active';
}

function handleFailure(result: Extract<InlineResult, { ok: false }>): void {
    const store = useInlineSuggestStore.getState();
    switch (result.reason) {
        case 'aborted':
            return; // superseded — not a failure
        case 'quota':
            store.setStatus('quota', result.resetAt ?? null);
            return;
        case 'auth':
            store.setStatus('signed-out');
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

    return monaco.languages.registerInlineCompletionsProvider('*', {
        async provideInlineCompletions(model: editor.ITextModel, position: Position, _context: languages.InlineCompletionContext, token: CancellationToken) {
            const empty: languages.InlineCompletions = { items: [] };

            const gate = {
                enabled: useSettingsStore.getState().settings['ai.inlineSuggestions.enabled'],
                loggedIn: useAuthStore.getState().loggedIn,
                online: useConnectivityStore.getState().online,
                breakerAllows: breaker.allows(),
                quotaActive: useInlineSuggestStore.getState().quotaActive(),
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
            const prefix = fullText.slice(Math.max(0, offset - PREFIX_CHARS), offset);
            const suffix = fullText.slice(offset, offset + SUFFIX_CHARS);
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
        freeInlineCompletions() {
            // items are plain objects — nothing to dispose
        },
    });
}
