// Pure gate — every reason inline suggestions must NOT fire, in one testable
// place. 1 MB matches EditorPanel's isLargeFile threshold.
export interface InlineGate {
    enabled: boolean;
    loggedIn: boolean;
    online: boolean;
    breakerAllows: boolean;
    quotaActive: boolean;
    /**
     * Whether the account's plan currently includes inline completions
     * (`inlineAllowed(config, plan)`, `stores/server-config.ts`). Callers pass
     * that accessor's result directly — it already resolves an UNKNOWN config
     * to `true` (the server's 403 is authoritative; a startup race must never
     * blank a paid user's completions), so this gate only ever blocks a plan
     * the server has CONFIRMED excludes inline.
     */
    planAllows: boolean;
    scheme: string;
    contentLength: number;
}

export const INLINE_MAX_FILE_CHARS = 1_000_000;

export function shouldRequestInline(gate: InlineGate): boolean {
    return gate.enabled
        && gate.loggedIn
        && gate.online
        && gate.breakerAllows
        && !gate.quotaActive
        && gate.planAllows
        && gate.scheme === 'file'
        && gate.contentLength <= INLINE_MAX_FILE_CHARS;
}
