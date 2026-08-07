import { describe, it, expect } from 'bun:test';
import type { Monaco } from '@monaco-editor/react';
import { registerInlineSuggestProvider } from './inline-provider';

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

describe('registerInlineSuggestProvider', () => {
    const provider = registerAndCapture();

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
