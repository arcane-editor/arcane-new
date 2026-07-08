import type { AuthPayload } from './middleware/auth.ts';

// Hono environment type — declares context bindings and variables
export type AppEnv = {
    Bindings: {
        arcane_db: D1Database;
        AI: Ai;                      // Cloudflare Workers AI binding
        VECTORIZE: Vectorize;        // Unity docs/API vector index (384-dim, bge-small)
        CF_AI_GATEWAY_ID: string;    // AI Gateway id (caching/logging/rate-limits)
        JWT_SECRET: string;
        ENVIRONMENT: string;
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
    content: string | ContentPart[];
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
    | { type: 'error'; message: string };
