export interface Acquisition {
    source: string;
    medium: string;
    landingPath: string;
    referrerHost?: string;
}

/** Intentionally accepts only coarse marketing dimensions, never full URLs. */
export function acquisitionFrom(value: unknown): Acquisition | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const input = value as Record<string, unknown>;
    const dimension = (v: unknown) => typeof v === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(v)
        ? v.toLowerCase() : null;
    const source = dimension(input.source);
    const medium = dimension(input.medium);
    const path = input.landingPath;
    if (!source || !medium || typeof path !== 'string' || path.length > 200
        || !/^\/(?:[a-z0-9_-]+\/)*[a-z0-9_-]*$/i.test(path)
        || /^\/(auth|account|admin|forgot|reset|verify)(\/|$)/i.test(path)) return null;
    const host = input.referrerHost;
    if (host != null && (typeof host !== 'string' || host.length > 253
        || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(host))) return null;
    return { source, medium, landingPath: path, ...(typeof host === 'string' ? { referrerHost: host.toLowerCase() } : {}) };
}

export function acquisitionFromQuery(url: string): Acquisition | null {
    const params = new URL(url).searchParams;
    return acquisitionFrom({
        source: params.get('acq_source'), medium: params.get('acq_medium'),
        landingPath: params.get('acq_landing_path'), referrerHost: params.get('acq_referrer_host'),
    });
}

/** Best-effort and first-write-only: analytics cannot break account creation. */
export async function recordAcquisition(db: D1Database, userId: number, raw: unknown): Promise<void> {
    const acquisition = acquisitionFrom(raw);
    if (!acquisition) return;
    try {
        await db.prepare(`INSERT OR IGNORE INTO user_acquisition
            (user_id, source, medium, landing_path, referrer_host) VALUES (?, ?, ?, ?, ?)`)
            .bind(userId, acquisition.source, acquisition.medium, acquisition.landingPath, acquisition.referrerHost ?? null).run();
    } catch {
        console.error(JSON.stringify({ event: 'acquisition_record_failed', userId }));
    }
}
