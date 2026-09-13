/**
 * First-run install report — tells the server, once per machine, that someone
 * actually launched UnityIDE.
 *
 * This is the only signal that separates a real install from a download click.
 * Downloads are counted in the browser by the Reddit pixel and include bots,
 * repeat downloads and people who never open the app; without this the ad
 * campaign is optimizing toward clicks on a button.
 *
 * Three properties matter, and each has a test:
 *
 *  1. **It never throws and never blocks boot.** Nothing about reporting an
 *     install is worth a degraded startup, let alone a failed one.
 *  2. **It reports once.** The Rust side holds the id and the "already sent"
 *     flag in the per-channel config dir; the flag is only set after the
 *     server accepts the report, so a failed attempt retries next launch
 *     rather than vanishing.
 *  3. **A duplicate is harmless.** Two windows launching together can both
 *     send, and a restored home directory can send again months later — the
 *     server deduplicates on the install id, because a phantom install is a
 *     phantom ad conversion.
 */

import { API_URL } from '../config/api';
import { detectChannel, detectOs } from './crash-report';

export interface InstallRecord {
    installId: string;
    reported: boolean;
    /**
     * Whether THIS caller should send the report. False for every window after
     * the first in a process — Tauri runs one process for all windows, so
     * without this a session restoring six projects would POST six times from
     * one IP against a limiter sized for once-per-lifetime.
     */
    shouldReport: boolean;
}

export type InstallReportOutcome =
    /** Sent and accepted; this machine will not report again. */
    | 'reported'
    /** Already reported on an earlier launch, or another window in this
     *  process is doing it. */
    | 'already'
    /** The server rejected the report permanently (4xx). Retrying would fail
     *  identically on every launch, so it is not retried. */
    | 'rejected'
    /** Could not reach the Tauri host at all (browser dev, tests). */
    | 'unavailable'
    /** Attempted and failed; will be retried on the next launch. */
    | 'failed';

export interface InstallReportDeps {
    invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
    fetchImpl?: typeof fetch;
    baseUrl?: string;
    appVersion: string;
    /** Injectable so a test does not depend on the host's crypto. */
    newId?: () => string;
}

/**
 * Report this install if it has not been reported yet.
 *
 * The id is generated here rather than in Rust: the WebView has
 * `crypto.randomUUID()` and Rust would need a new dependency for one string.
 * Rust decides whether the candidate is adopted, atomically, so proposing one
 * on every launch is harmless.
 */
export async function reportInstallOnce(deps: InstallReportDeps): Promise<InstallReportOutcome> {
    const fetchImpl = deps.fetchImpl ?? fetch;
    const baseUrl = deps.baseUrl ?? API_URL;
    const newId = deps.newId ?? (() => crypto.randomUUID());

    let record: InstallRecord;
    try {
        record = await deps.invoke<InstallRecord>('install_claim', { candidate: newId() });
    } catch {
        // No Tauri host — a browser dev server or a unit test. Nothing to
        // report and nothing wrong.
        return 'unavailable';
    }

    if (record.reported || !record.shouldReport) return 'already';

    try {
        const res = await fetchImpl(`${baseUrl}/v1/install`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                installId: record.installId,
                os: detectOs(),
                appVersion: deps.appVersion,
                channel: detectChannel(),
            }),
        });
        if (!res.ok) {
            // A 4xx is a permanent verdict on this payload — the server will
            // reject the same install id identically forever, so treating it
            // as transient would re-POST on every launch for the life of the
            // machine and never count the install anyway. Rust validates the
            // id against the server's own rule on read, so reaching here means
            // something we cannot fix by trying again.
            if (res.status >= 400 && res.status < 500) return 'rejected';
            return 'failed';
        }
    } catch {
        return 'failed';
    }

    try {
        // Only after the server accepted it. Marking first would turn one
        // network blip into an install that is never counted.
        await deps.invoke('install_mark_reported');
    } catch {
        // The report landed; we just could not record that locally. The next
        // launch will send a duplicate, which the server discards.
        return 'reported';
    }
    return 'reported';
}

/** Fire-and-forget wrapper for boot. Resolves to the outcome for tests, and
 *  swallows everything so no caller has to remember to catch. */
export async function reportInstallInBackground(
    invoke: InstallReportDeps['invoke'],
    appVersion: string,
): Promise<InstallReportOutcome> {
    try {
        return await reportInstallOnce({ invoke, appVersion });
    } catch {
        return 'failed';
    }
}
