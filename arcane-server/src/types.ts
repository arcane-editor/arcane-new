import type { AuthPayload } from './middleware/auth.ts';

// Cloudflare Email Service send binding (send_email in wrangler.toml).
// Contract verified against current docs: send() resolves {messageId} and
// throws errors carrying `.code` (e.g. E_SENDER_NOT_VERIFIED).
export interface EmailSender {
    send(message: {
        to: string | { email: string; name?: string };
        from: { email: string; name?: string };
        subject: string;
        html?: string;
        text?: string;
    }): Promise<{ messageId: string }>;
}

// Cloudflare Workers rate limiting binding ([[unsafe.bindings]] type "ratelimit").
export interface RateLimiter {
    limit(options: { key: string }): Promise<{ success: boolean }>;
}

// Hono environment type — declares context bindings and variables
export type AppEnv = {
    Bindings: {
        arcane_db: D1Database;
        AI: Ai;                      // Cloudflare Workers AI binding
        VECTORIZE: Vectorize;        // Unity docs/API vector index (384-dim, bge-small)
        CF_AI_GATEWAY_ID: string;    // AI Gateway id (caching/logging/rate-limits)
        CF_ACCOUNT_ID?: string;      // account id for the gateway /compat URL (external models)
        MINIMAX_API_KEY?: string;    // secret — MiniMax key, sent through the gateway per-request
        MOONSHOT_API_KEY?: string;   // secret — Moonshot (Kimi) key
        JWT_SECRET: string;
        ENVIRONMENT: string;
        WEB_BASE_URL: string;        // user-facing website base (auth pages, email links)
        API_BASE_URL: string;        // this worker's public base (Google redirect_uri)
        EMAIL_FROM: string;          // verified sender (no-reply@arcaneai.org)
        EMAIL?: EmailSender;         // Email Service send binding (absent in tests)
        RL_AUTH_STRICT?: RateLimiter;   // 10/60s/IP (absent in tests → fail open)
        RL_AUTH_POLL?: RateLimiter;     // 60/60s/IP (absent in tests → fail open)
        RL_INLINE?: RateLimiter;        // 30/60s/user inline-completion burst cap (absent in tests → fail open)
        GOOGLE_CLIENT_ID?: string;      // secret — unset until owner provisions OAuth client
        GOOGLE_CLIENT_SECRET?: string;  // secret
        GITHUB_CLIENT_ID?: string;      // secret — one OAuth App per environment (GitHub allows a single callback URL each)
        GITHUB_CLIENT_SECRET?: string;  // secret
        TURNSTILE_SECRET?: string;      // secret — unset = Turnstile verification skipped
        // Dodo Payments (billing). Secrets unset until owner provisions the
        // account; when absent the billing routes degrade to 503 and the
        // webhook rejects (never silently trusts an unsigned payload).
        DODO_API_KEY?: string;          // secret — Bearer for the Dodo REST API
        DODO_WEBHOOK_SECRET?: string;   // secret — Standard-Webhooks signing key
        // Dodo product ids per tier / top-up pack (vars; empty until created).
        DODO_PRODUCT_PRO?: string;
        DODO_PRODUCT_PROPLUS?: string;
        DODO_PRODUCT_ULTRA?: string;
        DODO_PRODUCT_TOPUP_1000?: string;
        DODO_PRODUCT_TOPUP_5000?: string;
    };
    Variables: {
        user: AuthPayload;
    };
};

// Request types (what the editor sends)
export interface ChatCompletionRequest {
    model: string;
    messages: ChatMessage[];
    tools?: ToolDefinition[];
    stream?: boolean;
    max_tokens?: number;
    temperature?: number;
    metadata?: {
        taskType?: 'chat' | 'edit' | 'plan' | 'explain';
        mode?: 'agent' | 'ask' | 'plan';
        reasoningLevel?: 'low' | 'mid' | 'high' | 'super';
        planPhase?: 'planning' | 'executing';
        sessionId?: string;
        telemetry?: {
            turnIndex?: number;
            toolErrorCount?: number;
            repairCount?: number;
            /** Ask-mode grounding-linter revise cycles this send (P2.2). */
            groundingLintHits?: number;
            /** Repeat-call guard suppressions this send (P3.2). */
            loopGuardHits?: number;
            /** Whether repair-triggered tier escalation fired this send (P3.6). */
            escalated?: boolean;
            /** `unity_api_search` tool executions this send (P4). */
            groundingToolCalls?: number;
            /** `unity_api_search` "ok:false" (grounding UNAVAILABLE) results this send (P4). */
            groundingUnavailable?: number;
            /** Wall-clock latency (ms) of the previous request this send, or null (P4). */
            lastTurnLatencyMs?: number | null;
        };
    };
}

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    /** `null` is legal: OpenAI's convention for an assistant turn carrying no
     *  text (tool calls only, reasoning only, or cut short). The editor sends
     *  it — see `contentText` in services/llm-router.ts. */
    content: string | ContentPart[] | null;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    name?: string;
}

export interface ContentPart {
    type: 'text' | 'image_url';
    text?: string;
    image_url?: { url: string };
}

export interface ToolDefinition {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}

export interface ToolCall {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
}

// Stream events (what the server sends back via SSE)
export type StreamEvent =
    | { type: 'text'; content: string }
    | { type: 'tool_call'; id: string; name: string; arguments: string; finished: boolean }
    | { type: 'usage'; input_tokens: number; output_tokens: number; cached_input_tokens?: number }
    | { type: 'thinking'; thought: string; signature: string }
    | { type: 'error'; code?: 'model_error' | 'rate_limit' | 'server_error'; message: string };
