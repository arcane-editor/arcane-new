// Structured error logging for the chat completions path. Emits a single-line
// JSON object so Workers Logs / Logpush can filter on `event` and `where`
// without regexing free-text console output.
export interface ChatErrorContext {
    userId?: string | number;
    model?: string;
    reasoningLevel?: string;
    taskType?: string;
}

export function logChatError(ctx: ChatErrorContext, where: string, message: string): void {
    console.error(JSON.stringify({ event: 'chat_error', where, ...ctx, message }));
}

// Auth-flow audit events (single-line JSON, filterable on `event`).
// NEVER pass raw tokens, one-time codes, or passwords in ctx — log user ids
// and reason strings only.
export function logAuthEvent(event: string, ctx: Record<string, unknown> = {}): void {
    console.log(JSON.stringify({ event: `auth_${event}`, ...ctx }));
}
