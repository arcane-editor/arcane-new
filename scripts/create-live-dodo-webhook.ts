/**
 * Create the LIVE Dodo webhook endpoint for the prod worker and capture its
 * signing secret (Task 6 Step 3 of the v0.3 prod launch plan).
 *
 * Mirrors the dev endpoint: no filter_types, i.e. all events.
 *
 *   cd /Users/inno/Documents/experiments/arcane-editor
 *   DODO_LIVE_API_KEY='<live key>' bun run scripts/create-live-dodo-webhook.ts
 *
 * The signing secret is NEVER printed. It is written to a file (default
 * ./.dodo-webhook-secret.txt, which .gitignore covers) so it can be piped
 * straight into `wrangler secret put` without passing through a terminal
 * transcript. Delete that file once the secret is set.
 *
 * Safe to re-run: if an endpoint already points at the target URL it is
 * reused rather than duplicated, and its secret is re-read.
 */

const BASE = 'https://live.dodopayments.com';
const TARGET_URL = 'https://api.unityide.app/v1/billing/webhook';
const KEY = process.env.DODO_LIVE_API_KEY;

const outArg = process.argv.indexOf('--out');
const OUT = outArg >= 0 ? process.argv[outArg + 1]! : '.dodo-webhook-secret.txt';

if (!KEY) {
    console.error('DODO_LIVE_API_KEY is not set in this shell. Export the LIVE-mode key and re-run.');
    process.exit(1);
}

async function api(path: string, init?: RequestInit): Promise<any> {
    const res = await fetch(`${BASE}${path}`, {
        ...init,
        headers: {
            Authorization: `Bearer ${KEY}`,
            'Content-Type': 'application/json',
            ...(init?.headers ?? {}),
        },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status} ${text}`);
    return text ? JSON.parse(text) : null;
}

// A live key is the only thing that authenticates here — a test key 401s.
const listed = await api('/webhooks?limit=100');
const hooks: any[] = listed.items ?? listed.data ?? (Array.isArray(listed) ? listed : []);
console.log(`Authenticated against ${BASE} — ${hooks.length} existing webhook(s).`);
for (const h of hooks) console.log(`  existing: ${h.id}  ${h.url}`);

let hook = hooks.find((h) => h.url === TARGET_URL);
if (hook) {
    console.log(`\nREUSE  endpoint already points at ${TARGET_URL} → ${hook.id}`);
} else {
    hook = await api('/webhooks', {
        method: 'POST',
        body: JSON.stringify({ url: TARGET_URL, description: 'UnityIDE prod worker (arcane-server)' }),
    });
    console.log(`\nCREATE ${TARGET_URL} → ${hook.id}`);
}

const { secret } = await api(`/webhooks/${hook.id}/secret`);
if (!secret) throw new Error('No secret returned for the webhook endpoint.');

await Bun.write(OUT, secret);

console.log('\n─── endpoint ───');
console.log(`id:           ${hook.id}`);
console.log(`url:          ${hook.url}`);
console.log(`filter_types: ${JSON.stringify(hook.filter_types ?? null)}   (null = all events, matching dev)`);
console.log(`secret:       written to ${OUT} (${secret.length} chars, not printed)`);
console.log('\n─── next: set it on the prod worker, then delete the file ───');
console.log(`cd arcane-server && npx wrangler secret put DODO_WEBHOOK_SECRET < ../${OUT}`);
console.log(`rm ${OUT}`);
