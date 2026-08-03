import { describe, it, expect } from 'vitest';
import {
    clampInlineRequest, buildFimPrompt, cleanCompletion,
    FIM_MAX_PREFIX_CHARS, FIM_MAX_SUFFIX_CHARS,
} from '../src/lib/fim.ts';

describe('clampInlineRequest', () => {
    it('rejects non-objects and missing fields', () => {
        expect(clampInlineRequest(null)).toBeNull();
        expect(clampInlineRequest('x')).toBeNull();
        expect(clampInlineRequest({ prefix: 'a', suffix: 'b' })).toBeNull();
        expect(clampInlineRequest({ prefix: 1, suffix: 'b', language: 'csharp' })).toBeNull();
    });
    it('clamps prefix from the END and suffix from the START', () => {
        const r = clampInlineRequest({
            prefix: 'x'.repeat(FIM_MAX_PREFIX_CHARS + 10) + 'TAIL',
            suffix: 'HEAD' + 'y'.repeat(FIM_MAX_SUFFIX_CHARS + 10),
            language: 'csharp',
        })!;
        expect(r.prefix.length).toBe(FIM_MAX_PREFIX_CHARS);
        expect(r.prefix.endsWith('TAIL')).toBe(true);
        expect(r.suffix.length).toBe(FIM_MAX_SUFFIX_CHARS);
        expect(r.suffix.startsWith('HEAD')).toBe(true);
    });
});

describe('buildFimPrompt', () => {
    it('uses qwen2.5-coder FIM tokens', () => {
        expect(buildFimPrompt({ prefix: 'A', suffix: 'B', language: 'csharp' }))
            .toBe('<|fim_prefix|>A<|fim_suffix|>B<|fim_middle|>');
    });
});

describe('cleanCompletion', () => {
    it('cuts at FIM/end control tokens and trims trailing whitespace', () => {
        expect(cleanCompletion('foo();<|endoftext|>garbage', '')).toBe('foo();');
        expect(cleanCompletion('bar()  \n\n', '')).toBe('bar()');
    });
    it('returns empty for whitespace-only output', () => {
        expect(cleanCompletion('   \n\t', '')).toBe('');
    });
    it('returns empty when the completion just repeats the suffix', () => {
        expect(cleanCompletion('return result;\n}', '  return result;\n}\n')).toBe('');
    });
    it('keeps a real completion that happens to share a short token with the suffix', () => {
        expect(cleanCompletion('x);', ');')).toBe('x);');
    });
});
