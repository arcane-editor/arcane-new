import { describe, it, expect } from 'bun:test';
import { reportInstallOnce, reportInstallInBackground, type InstallRecord } from './install-report';

/**
 * The install report is the only signal that separates a real install from a
 * download click, and it feeds an ad campaign's conversion count — so these
 * tests are mostly about not lying: never report twice, never mark a failed
 * report as sent, and never let any of it disturb boot.
 */

interface Sent {
    url: string;
    body: Record<string, unknown>;
}

/** Records every invoke call and every POST, so "did it send" and "did it mark
 *  as sent" are both directly observable. */
function harness(options: {
    record?: InstallRecord;
    claimThrows?: boolean;
    markThrows?: boolean;
    status?: number;
    networkThrows?: boolean;
} = {}) {
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    const sent: Sent[] = [];

    const invoke = async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
        calls.push({ cmd, args });
        if (cmd === 'install_claim') {
            if (options.claimThrows) throw new Error('no ipc');
            return (options.record ?? { installId: 'install-1', reported: false, shouldReport: true }) as T;
        }
        if (cmd === 'install_mark_reported' && options.markThrows) throw new Error('disk full');
        return undefined as T;
    };

    const fetchImpl = (async (url: unknown, init?: unknown) => {
        if (options.networkThrows) throw new Error('offline');
        const opts = init as { body?: string };
        sent.push({ url: String(url), body: JSON.parse(opts?.body ?? '{}') });
        return new Response('{"ok":true}', { status: options.status ?? 202 });
    }) as unknown as typeof fetch;

    const deps = {
        invoke: invoke as Parameters<typeof reportInstallOnce>[0]['invoke'],
        fetchImpl,
        baseUrl: 'https://api.test',
        appVersion: '0.3.3',
        newId: () => 'candidate-1',
    };

    return { calls, sent, deps, marked: () => calls.some(c => c.cmd === 'install_mark_reported') };
}

describe('reportInstallOnce', () => {
    it('posts the install and records that it was sent', async () => {
        const h = harness();
        expect(await reportInstallOnce(h.deps)).toBe('reported');

        expect(h.sent).toHaveLength(1);
        expect(h.sent[0]!.url).toBe('https://api.test/v1/install');
        expect(h.sent[0]!.body.installId).toBe('install-1');
        expect(h.sent[0]!.body.appVersion).toBe('0.3.3');
        expect(h.marked()).toBe(true);
    });

    it('describes the platform so installs can be split by OS and channel', async () => {
        const h = harness();
        await reportInstallOnce(h.deps);
        expect(typeof h.sent[0]!.body.os).toBe('string');
        expect(typeof h.sent[0]!.body.channel).toBe('string');
    });

    it('proposes a candidate id for Rust to adopt or ignore', async () => {
        const h = harness();
        await reportInstallOnce(h.deps);
        expect(h.calls[0]).toEqual({ cmd: 'install_claim', args: { candidate: 'candidate-1' } });
    });

    /** The property the whole feature rests on. */
    it('sends nothing when this machine already reported', async () => {
        const h = harness({ record: { installId: 'install-1', reported: true, shouldReport: false } });

        expect(await reportInstallOnce(h.deps)).toBe('already');
        expect(h.sent).toHaveLength(0);
    });

    /**
     * Marking before the server accepts would turn one network blip into an
     * install that is never counted at all.
     */
    it('does not mark as reported when the server rejects it', async () => {
        const h = harness({ status: 500 });

        expect(await reportInstallOnce(h.deps)).toBe('failed');
        expect(h.marked()).toBe(false);
    });

    it('does not mark as reported when the network throws', async () => {
        const h = harness({ networkThrows: true });

        expect(await reportInstallOnce(h.deps)).toBe('failed');
        expect(h.marked()).toBe(false);
    });

    it('reports success even if the local flag cannot be written', async () => {
        // The server has the report; the duplicate sent next launch is
        // deduplicated there, so this is not a failure worth retrying as one.
        const h = harness({ markThrows: true });
        expect(await reportInstallOnce(h.deps)).toBe('reported');
        expect(h.sent).toHaveLength(1);
    });

    it('does nothing outside a Tauri host instead of throwing', async () => {
        const h = harness({ claimThrows: true });

        expect(await reportInstallOnce(h.deps)).toBe('unavailable');
        expect(h.sent).toHaveLength(0);
    });
});

describe('reportInstallInBackground', () => {
    it('resolves rather than rejecting when the IPC bridge throws synchronously', async () => {
        // Indistinguishable from "no Tauri host" from here, and treated as
        // such — the point is that boot cannot be taken down by ad reporting.
        const invoke = (() => { throw new Error('sync throw'); }) as never;
        expect(await reportInstallInBackground(invoke, '0.3.3')).toBe('unavailable');
    });
});

describe('one report per process', () => {
    /**
     * Tauri runs ONE process for every window, so a session restoring six
     * projects would otherwise fire six POSTs from one IP at a limiter sized
     * for once-per-lifetime. Rust hands out a single report slot; this is the
     * side that must respect it.
     */
    it('sends nothing when another window in this process holds the slot', async () => {
        const h = harness({ record: { installId: 'install-1', reported: false, shouldReport: false } });

        expect(await reportInstallOnce(h.deps)).toBe('already');
        expect(h.sent).toHaveLength(0);
        expect(h.marked()).toBe(false);
    });
});

describe('permanent rejection', () => {
    /**
     * A 4xx is the server's permanent verdict on this install id. Treating it
     * as transient would re-POST on every launch for the life of the machine
     * and still never count the install.
     */
    it('does not retry forever when the server rejects the payload', async () => {
        const h = harness({ status: 400 });

        expect(await reportInstallOnce(h.deps)).toBe('rejected');
        expect(h.sent).toHaveLength(1);
    });

    it('still treats a 5xx as worth retrying next launch', async () => {
        const h = harness({ status: 503 });

        expect(await reportInstallOnce(h.deps)).toBe('failed');
        expect(h.marked()).toBe(false);
    });
});
