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
        // Spark direct provider (MODEL_CATALOG route:'direct') — no CF AI
        // Gateway in this path; the Worker calls SPARK_BASE_URL straight,
        // authenticated with SPARK_API_KEY. Empty/unset base URL ⇒ spark/*
        // models fail loud via LlmConfigError (llm-router.ts), never a silent
        // fallback to some other route.
        SPARK_BASE_URL?: string;     // var — owner's Spark OpenAI-compatible endpoint
        SPARK_API_KEY?: string;      // secret — sent as `Authorization: Bearer` straight to SPARK_BASE_URL
        ADMIN_PASSWORD?: string;     // secret — admin auth, consumed by a later task; declared now so wrangler/test config lands once
        JWT_SECRET: string;
        ENVIRONMENT: string;
        WEB_BASE_URL: string;        // user-facing website base (auth pages, email links)
        API_BASE_URL: string;        // this worker's public base (Google redirect_uri)
        EMAIL_FROM: string;          // verified sender (no-reply@unityide.app)
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
        DODO_PRODUCT_STARTER?: string;
        DODO_PRODUCT_PRO?: string;
        DODO_PRODUCT_MAX?: string;
        DODO_PRODUCT_TOPUP_16?: string;
        DODO_PRODUCT_TOPUP_75?: string;
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
    /**
     * OpenAI-style tool choice. The editor's turn governor sends 'none' at
     * the call cap so the model answers tool-free while the `tools` block
     * stays byte-identical for provider prompt-prefix caches.
     *
     * Best-effort: providers that implement only `"auto"` reject the whole
     * request on 'none', and llm-router then falls back to withholding
     * `tools` — same tool-free guarantee, cached prefix lost.
     */
    tool_choice?: 'none' | 'auto';
    metadata?: {
        taskType?: 'chat' | 'edit' | 'plan' | 'explain' | 'memory';
        mode?: 'agent' | 'ask' | 'plan';
        reasoningLevel?: 'low' | 'mid' | 'high' | 'super';
        planPhase?: 'preplanning' | 'planning' | 'executing';
        /** 'easy' | 'hard' — meaningful only for high-tier execution (config/routing.ts). */
        difficulty?: 'easy' | 'hard';
        sessionId?: string;
        /** LEGACY/IGNORED: the old flag-gated simple-ask-downgrade signal set
         *  (config/routing.ts, pre-Task-3). Older editor builds still send this;
         *  the server no longer reads it. Kept only for tolerant parsing of a
         *  field an older client may include — no behavior is driven by it. */
        routing?: {
            promptChars?: number;
            codeIntent?: boolean;
            hasAttachments?: boolean;
        };
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
    | { type: 'usage'; input_tokens: number; output_tokens: number; cached_input_tokens?: number; model?: string }
    | { type: 'thinking'; thought: string; signature: string }
    | { type: 'error'; code?: 'model_error' | 'rate_limit' | 'server_error'; message: string };
