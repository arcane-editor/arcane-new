/** Inclusive start, exclusive end; UTC dates keep cohorts reproducible. */
export function reportRange(from: string | undefined, to: string | undefined, now = new Date()) {
    const end = to ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString().slice(0, 10);
    const valid = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v)
        && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
    if (!valid(end)) return null;
    const start = from ?? new Date(Date.parse(end) - 84 * 86400000).toISOString().slice(0, 10);
    if (!valid(start) || !valid(end) || start >= end || Date.parse(end) - Date.parse(start) > 366 * 86400000) return null;
    return { from: start, to: end };
}

export async function acquisitionReport(db: D1Database, range: { from: string; to: string }) {
    const { from, to } = range;
    const [weekly, acquisition, cohort] = await db.batch([
        db.prepare(`WITH first_user AS (
            SELECT user_id, MIN(activated_at) AS at FROM install_activations
            WHERE channel = 'release' AND activated_at IS NOT NULL AND user_id IS NOT NULL GROUP BY user_id
        ), events AS (
            SELECT created_at AS at, 1 AS installs, 0 AS enrolled, 0 AS activated, 0 AS identified, 0 AS anonymous
              FROM app_installs WHERE channel = 'release'
            UNION ALL SELECT registered_at, 0, 1, 0, 0, 0 FROM install_activations WHERE channel = 'release'
            UNION ALL SELECT activated_at, 0, 0, 1, 0, CASE WHEN user_id IS NULL THEN 1 ELSE 0 END
              FROM install_activations WHERE channel = 'release' AND activated_at IS NOT NULL
            UNION ALL SELECT at, 0, 0, 0, 1, 0 FROM first_user
        ) SELECT date(at, 'weekday 0', '-6 days') AS weekStart,
            SUM(installs) AS firstLaunches, SUM(enrolled) AS measurementEnrollments,
            SUM(activated) AS activatedInstalls, SUM(identified) AS identifiedActivatedUsers,
            SUM(anonymous) AS unlinkedActivatedInstalls
          FROM events WHERE at >= ? AND at < ? GROUP BY weekStart ORDER BY weekStart`).bind(from, to),
        db.prepare(`WITH first_user AS (
            SELECT user_id, MIN(activated_at) AS at FROM install_activations
            WHERE channel = 'release' AND activated_at IS NOT NULL AND user_id IS NOT NULL GROUP BY user_id
        ) SELECT COALESCE(a.source, 'unattributed') AS source, COALESCE(a.medium, 'unknown') AS medium,
            a.landing_path AS landingPath, COUNT(*) AS identifiedActivatedUsers
          FROM first_user f LEFT JOIN user_acquisition a ON a.user_id = f.user_id
          WHERE f.at >= ? AND f.at < ? GROUP BY source, medium, landingPath
          ORDER BY identifiedActivatedUsers DESC, source, medium, landingPath`).bind(from, to),
        // Include unactivated installs in the denominator. Enrollment happens
        // at activation, so conditioning on enrollment would fabricate 100%.
        // Compare only date cohorts beginning with the instrumented release.
        db.prepare(`SELECT COUNT(*) AS eligibleFirstLaunches,
            COALESCE(SUM(CASE WHEN a.activated_at >= i.created_at
                AND a.activated_at <= datetime(i.created_at, '+7 days') THEN 1 ELSE 0 END), 0) AS activatedWithin7Days,
            COALESCE(SUM(CASE WHEN a.activated_at < i.created_at THEN 1 ELSE 0 END), 0) AS activationReceiptOrderGaps
          FROM app_installs i LEFT JOIN install_activations a ON a.install_id = i.install_id AND a.channel = 'release'
          WHERE i.channel = 'release' AND i.created_at >= ? AND i.created_at < ?
            AND i.created_at <= datetime('now', '-7 days')`).bind(from, to),
    ]);
    if (!weekly || !acquisition || !cohort) throw new Error('Incomplete acquisition report');
    return {
        ...range, timezone: 'UTC', channel: 'release',
        weekly: weekly.results, acquisition: acquisition.results, mature7DayCohort: cohort.results[0],
        notes: [
            'First launch is the existing install ping, not activation. Activation is the first reported successful Unity bridge connection.',
            'Identified users deduplicate accounts across installs. Unlinked installs are not unique people.',
            'Acquisition belongs to signup and is joined only after authenticated association; missing stays unattributed. Later association may revise historical totals.',
            'Anonymous reports are client-reported, not attested. Legacy install enrollment uses trust on first use; dev and unknown channels are excluded.',
            'Seven-day conversion includes all mature first launches, including unactivated installs. Use a from date at or after instrumentation rollout; older versions did not report activation. Enrollment is not an installation-coverage metric.',
            'Milestone timestamps are server receipt times. Offline delivery can move an activation into a later week or outside its seven-day window.',
            'Activation receipt order gaps mean activation arrived before a retried first-launch ping. These installs remain in the denominator but are not assigned a successful seven-day timing; the receipt-based rate is incomplete for those installs.',
        ],
    };
}
