// Fetch wrapper for POST /v1/completions/inline. Deliberately NOT
// hosted-stream: no retries (a late completion is a wrong completion), 4s
// hard timeout, single-flight (a new request aborts the previous one).
import { API_URL } from '../../../config/api';
import { useAuthStore } from '../../../stores/auth';

export interface InlineRequest {
    prefix: string;
    suffix: string;
    language: string;
    path?: string;
}

export type InlineResult =
    | { ok: true; text: string }
    | {
        ok: false;
        reason: 'aborted' | 'offline' | 'auth' | 'plan' | 'quota' | 'budget' | 'server' | 'timeout';
        resetAt?: string;
    };

interface InlineClientConfig {
    fetchImpl?: typeof fetch;
    getToken?: () => string | null;
    baseUrl?: string;
    timeoutMs?: number;
}

export function createInlineClient(cfg: InlineClientConfig = {}) {
    const fetchImpl = cfg.fetchImpl ?? fetch;
    const getToken = cfg.getToken ?? (() => useAuthStore.getState().token);
    const baseUrl = cfg.baseUrl ?? API_URL;
    const timeoutMs = cfg.timeoutMs ?? 4_000;

    let inflight: AbortController | null = null;

    async function fetchCompletion(req: InlineRequest): Promise<InlineResult> {
        const token = getToken();
        if (!token) return { ok: false, reason: 'auth' };

        inflight?.abort();
        const controller = new AbortController();
        inflight = controller;
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
            let res: Response;
            try {
                res = await fetchImpl(`${baseUrl}/v1/completions/inline`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                    body: JSON.stringify(req),
                    signal: controller.signal,
                });
            } catch {
                if (controller.signal.aborted) {
                    // Superseded by a newer request vs timed out: if we are no
                    // longer the tracked in-flight request, we were replaced.
                    return { ok: false, reason: inflight === controller ? 'timeout' : 'aborted' };
                }
                return { ok: false, reason: 'offline' };
            }
            if (res.status === 401) return { ok: false, reason: 'auth' };
            if (res.status === 403) {
                // Distinguish the plan-lock backstop (client-side `planAllows`
                // gate should already have short-circuited BEFORE this request
                // for a known-current config, so a live 403 here is either a
                // startup race — config said "maybe" and the server said no —
                // or a downgrade the client hasn't heard about yet) from every
                // other 403 (expired/invalid token), which stays 'auth'.
                const body = (await res.json().catch(() => ({}))) as { code?: string };
                return { ok: false, reason: body.code === 'inline_not_available' ? 'plan' : 'auth' };
            }
            if (res.status === 429) {
                const body = (await res.json().catch(() => ({}))) as { resetAt?: string };
                return { ok: false, reason: 'quota', ...(body.resetAt ? { resetAt: body.resetAt } : {}) };
            }
            if (res.status === 402) {
                // inline_budget_exhausted — the monthly spend ceiling (distinct
                // from the 429 daily request-count quota above). Same
                // {error,code,resetAt} body shape.
                const body = (await res.json().catch(() => ({}))) as { resetAt?: string };
                return { ok: false, reason: 'budget', ...(body.resetAt ? { resetAt: body.resetAt } : {}) };
            }
            if (!res.ok) return { ok: false, reason: 'server' };
            const body = (await res.json().catch(() => null)) as { text?: unknown } | null;
            if (!body || typeof body.text !== 'string') return { ok: false, reason: 'server' };
            return { ok: true, text: body.text };
        } finally {
            clearTimeout(timer);
            if (inflight === controller) inflight = null;
        }
    }

    return { fetchCompletion };
}

/** Production client (real fetch, auth-store token, configured API base). */
export const inlineClient = createInlineClient();
