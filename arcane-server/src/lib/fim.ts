// Fill-in-middle plumbing for inline completions (qwen2.5-coder prompt
// format). Pure functions — the route (routes/inline.ts) composes them.

export interface InlineCompletionRequest {
    prefix: string;
    suffix: string;
    language: string;
    path?: string;
}

// Clamped to ~600 tokens total (~4 chars/token). Input dominates inline cost
// almost entirely, so this is the primary lever on tab-completion spend:
// dropping from 1500 to 600 tokens roughly triples the number of suggestions
// each plan's monthly budget buys.
export const FIM_MAX_PREFIX_CHARS = 1600;
export const FIM_MAX_SUFFIX_CHARS = 800;

const FIM_STOP_TOKENS = ['<|fim_pad|>', '<|endoftext|>', '<|fim_prefix|>', '<|fim_suffix|>', '<|fim_middle|>', '<|repo_name|>', '<|file_sep|>'];

/** Minimum length of the suffix's leading non-blank content before we treat
 *  a matching completion as a degenerate re-type rather than a coincidence. */
const RETYPE_MIN_OVERLAP = 8;

/** Validate + defensively re-clamp a request body (the client clamps too). */
export function clampInlineRequest(body: unknown): InlineCompletionRequest | null {
    if (typeof body !== 'object' || body === null) return null;
    const b = body as Record<string, unknown>;
    if (typeof b.prefix !== 'string' || typeof b.suffix !== 'string' || typeof b.language !== 'string') return null;
    return {
        prefix: b.prefix.slice(-FIM_MAX_PREFIX_CHARS),
        suffix: b.suffix.slice(0, FIM_MAX_SUFFIX_CHARS),
        language: b.language.slice(0, 64),
        ...(typeof b.path === 'string' ? { path: b.path.slice(-256) } : {}),
    };
}

export function buildFimPrompt(req: InlineCompletionRequest): string {
    return `<|fim_prefix|>${req.prefix}<|fim_suffix|>${req.suffix}<|fim_middle|>`;
}

/**
 * Post-process raw model output into a suggestion. Empty string = "no
 * suggestion" (a 200 with text:'' — never an error). Strips anything after a
 * FIM control token, trims trailing whitespace, and drops degenerate outputs:
 * whitespace-only, or a completion that merely re-types what already follows
 * the cursor (compared against the suffix's first non-blank 8+ chars).
 */
export function cleanCompletion(raw: string, suffix: string): string {
    let text = raw;
    for (const stop of FIM_STOP_TOKENS) {
        const i = text.indexOf(stop);
        if (i !== -1) text = text.slice(0, i);
    }
    text = text.replace(/\s+$/, '');
    if (text.length === 0) return '';

    // Only the suffix's own non-blank content counts as "what follows the
    // cursor" — a short or blank suffix can't make a real completion look
    // like a re-type just because they happen to share a few characters.
    const suffixHead = suffix.trim();
    const overlap = Math.min(text.length, suffixHead.length);
    if (suffixHead.length >= RETYPE_MIN_OVERLAP && overlap >= RETYPE_MIN_OVERLAP &&
        text.slice(0, overlap) === suffixHead.slice(0, overlap)) {
        return '';
    }
    return text;
}
