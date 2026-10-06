import { useEffect, useMemo, useState, type FormEvent } from 'react';

interface WeeklyRow {
    weekStart: string;
    firstLaunches: number;
    measurementEnrollments: number;
    activatedInstalls: number;
    identifiedActivatedUsers: number;
    unlinkedActivatedInstalls: number;
}
interface SourceRow {
    source: string;
    medium: string;
    landingPath: string | null;
    identifiedActivatedUsers: number;
}
export interface AcquisitionReportResponse {
    from: string;
    to: string;
    timezone: 'UTC';
    channel: 'release';
    weekly: WeeklyRow[];
    acquisition: SourceRow[];
    mature7DayCohort: { eligibleFirstLaunches: number; activatedWithin7Days: number; activationReceiptOrderGaps: number };
    notes: string[];
}

const API_URL = import.meta.env.PUBLIC_API_URL || 'https://api.unityide.app';
const isoDay = (date: Date) => date.toISOString().slice(0, 10);
const shiftDay = (day: string, amount: number) => isoDay(new Date(Date.parse(day) + amount * 86400000));
const percent = (count: number, total: number) => total > 0 ? `${(count / total * 100).toFixed(1)}%` : '—';
const count = (value: number) => value.toLocaleString();
const inputClass = 'rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary';
const buttonClass = 'rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50';

function exportCsv(report: AcquisitionReportResponse): void {
    const rows: (string | number | null)[][] = [
        ['section', 'from_utc_inclusive', 'to_utc_exclusive', 'week_start_utc', 'source', 'medium', 'landing_path', 'first_launches', 'activated_installs', 'identified_activated_users', 'unlinked_activated_installs', 'measurement_enrollments', 'mature_first_launches', 'reported_activation_within_7_days', 'note'],
        ...report.weekly.map((row) => ['weekly', report.from, report.to, row.weekStart, '', '', '', row.firstLaunches, row.activatedInstalls, row.identifiedActivatedUsers, row.unlinkedActivatedInstalls, row.measurementEnrollments, '', '', '']),
        ...report.acquisition.map((row) => ['acquisition', report.from, report.to, '', row.source, row.medium, row.landingPath, '', '', row.identifiedActivatedUsers, '', '', '', '', '']),
        ['mature_7_day_cohort', report.from, report.to, '', '', '', '', '', '', '', '', '', report.mature7DayCohort.eligibleFirstLaunches, report.mature7DayCohort.activatedWithin7Days, `Server receipt times; only fully elapsed seven-day cohorts; receipt order gaps: ${report.mature7DayCohort.activationReceiptOrderGaps}`],
        ...report.notes.map((note) => ['note', report.from, report.to, '', '', '', '', '', '', '', '', '', '', '', note]),
    ];
    const csv = rows.map((row) => row.map((value) => {
        let text = value == null ? '' : String(value);
        if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
        return `"${text.replaceAll('"', '""')}"`;
    }).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `unityide-acquisition-${report.from}-${shiftDay(report.to, -1)}.csv`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function AcquisitionReport({ token }: { token: string }) {
    const [range, setRange] = useState(() => {
        const through = isoDay(new Date());
        return { from: shiftDay(through, -27), through };
    });
    const [draft, setDraft] = useState(range);
    const [revision, setRevision] = useState(0);
    const [report, setReport] = useState<AcquisitionReportResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    useEffect(() => {
        const controller = new AbortController();
        setLoading(true);
        setError('');
        setReport(null);
        void (async () => {
            try {
                const params = new URLSearchParams({ from: range.from, to: shiftDay(range.through, 1) });
                const response = await fetch(`${API_URL}/v1/admin/acquisition-report?${params}`, {
                    headers: { Authorization: `Bearer ${token}` }, signal: controller.signal,
                });
                if (!response.ok) throw new Error(response.status === 401 || response.status === 403
                    ? 'Your admin session cannot access this report. Sign in again.'
                    : response.status === 400 ? 'Choose a valid date range of at most 366 days.'
                    : 'The report could not be loaded. Try again after the server is available.');
                const data = await response.json() as AcquisitionReportResponse;
                if (!Array.isArray(data.weekly) || !Array.isArray(data.acquisition) || !data.mature7DayCohort) {
                    throw new Error('The server returned an incomplete report. Try again.');
                }
                if (!controller.signal.aborted) setReport(data);
            } catch (err) {
                if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'The report could not be loaded.');
            } finally {
                if (!controller.signal.aborted) setLoading(false);
            }
        })();
        return () => controller.abort();
    }, [token, range, revision]);

    const totals = useMemo(() => {
        const total = { firstLaunches: 0, activatedInstalls: 0, identifiedActivatedUsers: 0, unlinkedActivatedInstalls: 0 };
        for (const row of report?.weekly ?? []) {
            total.firstLaunches += row.firstLaunches;
            total.activatedInstalls += row.activatedInstalls;
            total.identifiedActivatedUsers += row.identifiedActivatedUsers;
            total.unlinkedActivatedInstalls += row.unlinkedActivatedInstalls;
        }
        return total;
    }, [report]);
    const knownSourceUsers = report?.acquisition.filter((row) => row.source !== 'unattributed')
        .reduce((sum, row) => sum + row.identifiedActivatedUsers, 0) ?? 0;

    function applyRange(event: FormEvent) {
        event.preventDefault();
        if (!draft.from || !draft.through || draft.from > draft.through) {
            setError('The start date must be on or before the end date.');
            return;
        }
        setRange({ ...draft });
        setRevision((value) => value + 1);
    }

    return <section className="space-y-6">
        <div>
            <h2 className="text-lg font-semibold text-foreground">Acquisition & activation</h2>
            <p className="mt-1 text-sm text-muted-foreground">Follow first launches through a successful Unity project connection. Release channel only; all dates use UTC.</p>
        </div>
        <form onSubmit={applyRange} className="flex flex-wrap items-end gap-3">
            <label className="space-y-1 text-xs text-muted-foreground">From
                <input aria-label="Report start date" className={`${inputClass} block`} type="date" required value={draft.from} max={draft.through} onChange={(event) => setDraft({ ...draft, from: event.target.value })} />
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">Through (inclusive)
                <input aria-label="Report end date" className={`${inputClass} block`} type="date" required value={draft.through} min={draft.from} onChange={(event) => setDraft({ ...draft, through: event.target.value })} />
            </label>
            <button className={buttonClass} type="submit" disabled={loading}>{loading ? 'Loading…' : 'Update report'}</button>
            <button className={buttonClass} type="button" disabled={!report || loading} onClick={() => report && exportCsv(report)}>Export CSV</button>
        </form>
        {error && <p role="alert" className="rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">{error}</p>}
        {loading && <p role="status" className="text-sm text-muted-foreground">Loading acquisition data…</p>}
        {report && <>
            <p className="text-xs text-muted-foreground">Showing {report.from} through {shiftDay(report.to, -1)} UTC. The current day and boundary weeks may be partial.</p>
            <dl className="grid gap-4 border-y border-border py-5 sm:grid-cols-2 lg:grid-cols-4">
                {([
                    ['First launches', totals.firstLaunches], ['Activated installs', totals.activatedInstalls],
                    ['Identified activated users', totals.identifiedActivatedUsers], ['Unlinked activated installs', totals.unlinkedActivatedInstalls],
                ] as const).map(([label, value]) => <div key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 font-mono text-2xl font-semibold text-foreground">{count(value)}</dd></div>)}
            </dl>
            <div className="grid gap-5 md:grid-cols-2">
                <div>
                    <h3 className="text-sm font-semibold text-foreground">Reported activation within 7 days</h3>
                    <p className="mt-2 font-mono text-xl text-foreground">{percent(report.mature7DayCohort.activatedWithin7Days, report.mature7DayCohort.eligibleFirstLaunches)}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{count(report.mature7DayCohort.activatedWithin7Days)} of {count(report.mature7DayCohort.eligibleFirstLaunches)} first launches whose full seven-day window has elapsed. Younger cohorts are excluded. Use a start date after activation reporting shipped.</p>
                    {report.mature7DayCohort.activationReceiptOrderGaps > 0 && <p className="mt-2 text-xs text-amber-400">{count(report.mature7DayCohort.activationReceiptOrderGaps)} activation reports arrived before their delayed first-launch report. Their seven-day timing is unknown, so this receipt-based rate is incomplete.</p>}
                </div>
                <div>
                    <h3 className="text-sm font-semibold text-foreground">Acquisition coverage among identified users</h3>
                    <p className="mt-2 font-mono text-xl text-foreground">{percent(knownSourceUsers, totals.identifiedActivatedUsers)}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{count(knownSourceUsers)} with a saved source; {count(totals.identifiedActivatedUsers - knownSourceUsers)} unattributed. Unlinked installs have no account-level source and are shown separately.</p>
                </div>
            </div>
            <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-left text-sm">
                    <caption className="px-4 py-3 text-left font-semibold text-foreground">Weekly milestones</caption>
                    <thead className="bg-muted/30 text-xs text-muted-foreground"><tr>{['Week starting (UTC)', 'First launches', 'Activated installs', 'Identified users', 'Unlinked installs'].map((label) => <th className="whitespace-nowrap px-4 py-3 font-medium" scope="col" key={label}>{label}</th>)}</tr></thead>
                    <tbody>{report.weekly.map((row) => <tr key={row.weekStart} className="border-t border-border"><th scope="row" className="whitespace-nowrap px-4 py-3 font-normal">{row.weekStart}</th>{[row.firstLaunches, row.activatedInstalls, row.identifiedActivatedUsers, row.unlinkedActivatedInstalls].map((value, index) => <td className="px-4 py-3 font-mono" key={index}>{count(value)}</td>)}</tr>)}</tbody>
                </table>
                {!report.weekly.length && <p className="px-4 pb-4 text-sm text-muted-foreground">No reported milestones in this date range. Choose another range after reporting is deployed.</p>}
            </div>
            <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-left text-sm">
                    <caption className="px-4 py-3 text-left font-semibold text-foreground">Saved signup source of identified activated users</caption>
                    <thead className="bg-muted/30 text-xs text-muted-foreground"><tr>{['Source', 'Medium', 'Landing page', 'Users'].map((label) => <th className="px-4 py-3 font-medium" scope="col" key={label}>{label}</th>)}</tr></thead>
                    <tbody>{report.acquisition.map((row, index) => <tr key={`${row.source}-${row.medium}-${row.landingPath}-${index}`} className="border-t border-border"><th scope="row" className="px-4 py-3 font-normal">{row.source}</th><td className="px-4 py-3">{row.medium}</td><td className="break-all px-4 py-3 font-mono text-xs">{row.landingPath ?? 'Unknown'}</td><td className="px-4 py-3 font-mono">{count(row.identifiedActivatedUsers)}</td></tr>)}</tbody>
                </table>
                {!report.acquisition.length && <p className="px-4 pb-4 text-sm text-muted-foreground">No identified activated users in this range. Anonymous activation is still counted above.</p>}
            </div>
            <details className="text-xs text-muted-foreground" open>
                <summary className="cursor-pointer font-medium text-foreground">How to read these numbers</summary>
                <ul className="mt-3 list-disc space-y-2 pl-5">{report.notes.map((note) => <li key={note}>{note}</li>)}</ul>
                <p className="mt-3">Daily or weekly launches and activations are separate milestone counts, not a same-week conversion rate. Server receipt times can lag while an app is offline; later sign-in can revise older attribution. Unknown sources are never counted as organic.</p>
            </details>
        </>}
    </section>;
}
