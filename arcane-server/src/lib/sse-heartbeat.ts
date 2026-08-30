/**
 * SSE keepalive for the chat stream.
 *
 * WHY THIS EXISTS — the "Stream stalled before the first token" bug.
 *
 * Hono's `streamSSE` returns its Response (and therefore the client's
 * response HEADERS) the instant the route handler returns it, but the first
 * BYTE of the body is only written when the upstream model emits its first
 * event. Everything in between — gateway connect, prompt prefill, and for a
 * reasoning model the entire think-before-answering phase — is dead air on
 * an open connection.
 *
 * The editor (`hosted-stream.ts`) starts a first-token watchdog off those
 * headers, so that watchdog was measuring MODEL LATENCY rather than
 * connection health. An agentic coding model on a large prompt routinely
 * needs longer than the watchdog allowed, and the turn died — reported
 * most often from Windows, where slower machines and TLS-inspecting
 * security software add enough latency to lose a race the protocol should
 * never have been running in the first place.
 *
 * The fix is to put bytes on the wire while the model is still thinking:
 * a comment frame every `SSE_HEARTBEAT_INTERVAL_MS`. Comment lines carry no
 * protocol meaning (the editor's parser only reads `data: ` lines and
 * ignores everything else), so they are pure liveness.
 *
 * Fixing it HERE rather than only in the editor is deliberate: a server
 * change reaches every already-installed editor immediately, without
 * waiting on an app update.
 *
 * A heartbeat alone would trade a false timeout for a worse failure — an
 * upstream that hangs forever would now look healthy forever, because the
 * client's watchdogs can no longer tell "model thinking" from "provider
 * dead". So the same timer also owns the real liveness check: time since
 * the last genuine upstream event. Past `UPSTREAM_STALL_TIMEOUT_MS` it
 * reports a stall instead of writing, and the caller turns that into a
 * visible error.
 */

/** One SSE comment frame. `:`-prefixed lines are ignored by every SSE
 *  parser, including the editor's, which reads only `data: ` lines. */
export const SSE_HEARTBEAT_FRAME = ': keepalive\n\n';

/**
 * How often to write a keepalive while the upstream is silent.
 *
 * Must stay comfortably below BOTH editor watchdog windows — the 25s
 * first-token window shipped in current builds and the 90s idle-gap window —
 * because already-installed editors are exactly who this protects.
 */
export const SSE_HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * How long the upstream may go without producing a single event before the
 * stream is declared dead.
 *
 * This is the check the client watchdogs USED to be (badly) doing, moved to
 * the only place that can tell model latency from provider death. Sized to
 * bound the documented ~53-minute Workers AI hang while leaving ample room
 * for legitimate prefill + reasoning on a million-token context window;
 * matches the editor's own 180s per-attempt connect timeout.
 */
export const UPSTREAM_STALL_TIMEOUT_MS = 180_000;

export interface HeartbeatOptions {
    /** Writes one raw frame to the SSE stream. Must not throw. */
    write: (frame: string) => void;
    /** Called once when the upstream has been silent past `stallAfterMs`.
     *  The heartbeat has already stopped itself by then. */
    onStall: (idleMs: number) => void;
    /** Defaults to `SSE_HEARTBEAT_INTERVAL_MS`. */
    intervalMs?: number;
    /** Defaults to `UPSTREAM_STALL_TIMEOUT_MS`. */
    stallAfterMs?: number;
    /** Injectable clock, for tests. Defaults to `Date.now`. */
    now?: () => number;
}

export interface Heartbeat {
    /** Record a genuine upstream event — resets the stall clock. Call this
     *  for every event, not just the first: a stream that is still producing
     *  is alive by definition. */
    sawEvent(): void;
    /** Stop the timer. Idempotent, and safe to call from a `finally`. */
    stop(): void;
}

/**
 * Starts the keepalive timer. The caller is responsible for writing one
 * frame immediately if it wants the very first byte to land before
 * `intervalMs` has elapsed (the chat route does — it proves the connection
 * the moment the stream opens).
 */
export function startHeartbeat(options: HeartbeatOptions): Heartbeat {
    const intervalMs = options.intervalMs ?? SSE_HEARTBEAT_INTERVAL_MS;
    const stallAfterMs = options.stallAfterMs ?? UPSTREAM_STALL_TIMEOUT_MS;
    const now = options.now ?? Date.now;

    let lastEventAt = now();
    let stopped = false;

    function stop(): void {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
    }

    const timer = setInterval(() => {
        if (stopped) return;
        const idleMs = now() - lastEventAt;
        if (idleMs >= stallAfterMs) {
            // Stop BEFORE notifying: onStall aborts the upstream, which
            // unwinds into the caller's catch/finally, and a timer still
            // writing into a closing stream from there is a race.
            stop();
            options.onStall(idleMs);
            return;
        }
        options.write(SSE_HEARTBEAT_FRAME);
    }, intervalMs);

    return {
        sawEvent(): void {
            lastEventAt = now();
        },
        stop,
    };
}
