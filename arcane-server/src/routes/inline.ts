// Inline (tab) completion endpoint. Non-streaming by design: ~50-token FIM
// completions gain nothing from SSE, and this path needs 300ms-class budgets,
// zero retries, and NO credit debit (allowance model — see lib/inline-allowance).
import { Hono } from 'hono';
import type { AppEnv } from '../types.ts';
import type { AuthPayload } from '../middleware/auth.ts';
import { INLINE_MODEL } from '../config/plans.ts';
import { checkInlineAllowance, utcMonthKey } from '../lib/inline-allowance.ts';
import { clampInlineRequest, buildFimPrompt, cleanCompletion } from '../lib/fim.ts';
import { recordUsage } from '../lib/usage.ts';
import { addInlineSpend } from '../lib/db.ts';
import { estimateCost } from '../lib/costs.ts';
import { GATEWAY_FEE, usdToMicro } from '../config/tiers.ts';

export const inlineRouter = new Hono<AppEnv>();

const MAX_BODY_BYTES = 32 * 1024;
const MODEL_TIMEOUT_MS = 5_000;

inlineRouter.post('/v1/completions/inline', async (c) => {
    const raw = await c.req.text();
    // Byte-accurate, not raw.length (UTF-16 code units): CJK/emoji can run
    // ~3x larger in UTF-8 bytes than .length, letting oversized bodies slip
    // past a code-unit check.
    if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
        return c.json({ error: 'Request too large', code: 'inline_too_large' }, 413);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch {
        return c.json({ error: 'Invalid JSON', code: 'inline_bad_request' }, 400);
    }
    const req = clampInlineRequest(parsed);
    if (!req) {
        return c.json({ error: 'prefix, suffix and language are required', code: 'inline_bad_request' }, 400);
    }

    const user = c.get('user') as AuthPayload;
    const userId = parseInt(user.sub);

    // Burst backstop (30/60s per user). Fails open when the binding is absent
    // (tests / local dev), same policy as the auth limiters.
    if (c.env.RL_INLINE) {
        const { success } = await c.env.RL_INLINE.limit({ key: user.sub });
        if (!success) {
            return c.json({
                error: 'Too many completion requests — slow down a little.',
                code: 'inline_quota',
                resetAt: new Date(Date.now() + 60_000).toISOString(),
            }, 429);
        }
    }

    const allowance = await checkInlineAllowance(c.env.arcane_db, userId);
    if (!allowance.ok) {
        return c.json({
            error: allowance.error,
            code: allowance.code,
            ...('resetAt' in allowance ? { resetAt: allowance.resetAt } : {}),
            ...('requiredPlan' in allowance ? { requiredPlan: allowance.requiredPlan } : {}),
        }, allowance.status);
    }

    if (!c.env.AI) return c.json({ error: 'AI backend unavailable', code: 'inline_unavailable' }, 503);

    const started = Date.now();
    try {
        // Promise.race timeout: on expiry the client gets a fast 504; the
        // orphaned run finishes server-side and is simply discarded.
        const result = await Promise.race([
            c.env.AI.run(
                INLINE_MODEL as Parameters<Ai['run']>[0],
                { prompt: buildFimPrompt(req), max_tokens: 128, temperature: 0.2, top_p: 0.9 },
                c.env.CF_AI_GATEWAY_ID ? { gateway: { id: c.env.CF_AI_GATEWAY_ID } } : {},
            ),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('inline_timeout')), MODEL_TIMEOUT_MS)),
        ]);
        const rawText = typeof (result as { response?: unknown })?.response === 'string'
            ? (result as { response: string }).response
            : '';
        const text = cleanCompletion(rawText, req.suffix);

        // Telemetry only — skipDebit. Token counts are chars/4 estimates: the
        // text-generation binding does not reliably return usage for this path.
        const inputEstimate = Math.ceil((req.prefix.length + req.suffix.length) / 4);
        const outputEstimate = Math.ceil(text.length / 4);

        // Real cost only — no MARGIN. Inline is free to the user; this ceiling
        // exists to bound OUR spend, not to bill theirs.
        const realMicro = usdToMicro(
            estimateCost(INLINE_MODEL, inputEstimate, outputEstimate) * GATEWAY_FEE,
        );

        await Promise.all([
            recordUsage(c.env.arcane_db, userId, INLINE_MODEL, inputEstimate, outputEstimate,
                Date.now() - started, { taskType: 'inline', skipDebit: true }),
            addInlineSpend(c.env.arcane_db, userId, utcMonthKey(), realMicro)
                .catch(err => console.error('Failed to record inline spend:', err)),
        ]);

        return c.json({ text, model: INLINE_MODEL });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message === 'inline_timeout') {
            return c.json({ error: 'Completion timed out', code: 'inline_timeout' }, 504);
        }
        console.error(JSON.stringify({ event: 'inline_error', userId: user.sub, message }));
        return c.json({ error: 'Completion failed', code: 'inline_error' }, 500);
    }
});
