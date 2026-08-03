// Pure gate — every reason inline suggestions must NOT fire, in one testable
// place. 1 MB matches EditorPanel's isLargeFile threshold.
export interface InlineGate {
    enabled: boolean;
    loggedIn: boolean;
    online: boolean;
    breakerAllows: boolean;
    quotaActive: boolean;
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
        && gate.scheme === 'file'
        && gate.contentLength <= INLINE_MAX_FILE_CHARS;
}
