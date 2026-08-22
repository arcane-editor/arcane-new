/**
 * Create the five LIVE-mode Dodo products (Task 14 of the feature sprint).
 * Prices and credit grants are mirrored from arcane-server/src/config/tiers.ts
 * — do not retype them from memory.
 *
 * Run from a shell that has the live key exported:
 *   export DODO_LIVE_API_KEY='<live-mode key>'
 *   bun run scripts/create-live-dodo-products.ts
 *
 * Safe to re-run: products are matched by name + price + recurrence kind.
 * A name collision with a different price or recurrence is treated as a new
 * product and is created; the collision is noted in the output.
 * Add --dry-run to print the plan without needing the key or creating.
 */

const BASE = 'https://live.dodopayments.com';
const KEY = process.env.DODO_LIVE_API_KEY;
const DRY = process.argv.includes('--dry-run');

if (!KEY && !DRY) {
    console.error('DODO_LIVE_API_KEY is not set in this shell. Export the LIVE-mode key and re-run.');
    process.exit(1);
}

interface Spec {
    name: string;
    description: string;
    cents: number;
    recurring: boolean;
    /** The wrangler.toml [vars] entry this product id belongs in. */
    varName: string;
}

// Starter $5/387cr, Pro $25/2097cr, Max $50/4235cr (TIERS);
// top-ups $16/1333cr and $75/6250cr (TOPUP_PACKS).
// Names do not state credit counts (owner directive: users never see them).
const SPECS: Spec[] = [
    { name: 'Arcane Starter', description: 'Arcane Starter — 387 credits / month', cents: 500, recurring: true, varName: 'DODO_PRODUCT_STARTER' },
    { name: 'Arcane Pro', description: 'Arcane Pro — 2,097 credits / month', cents: 2500, recurring: true, varName: 'DODO_PRODUCT_PRO' },
    { name: 'Arcane Max', description: 'Arcane Max — 4,235 credits / month', cents: 5000, recurring: true, varName: 'DODO_PRODUCT_MAX' },
    { name: 'Arcane Usage Pack $16', description: 'One-time top-up of 1,333 credits', cents: 1600, recurring: false, varName: 'DODO_PRODUCT_TOPUP_16' },
    { name: 'Arcane Usage Pack $75', description: 'One-time top-up of 6,250 credits', cents: 7500, recurring: false, varName: 'DODO_PRODUCT_TOPUP_75' },
];

function priceBody(s: Spec): Record<string, unknown> {
    return s.recurring
        ? {
            type: 'recurring_price', price: s.cents, currency: 'USD',
            discount: 0, purchasing_power_parity: false, tax_inclusive: false,
            payment_frequency_count: 1, payment_frequency_interval: 'Month',
            subscription_period_count: 1, subscription_period_interval: 'Month',
        }
        : {
            type: 'one_time_price', price: s.cents, currency: 'USD',
            discount: 0, purchasing_power_parity: false, tax_inclusive: false,
        };
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

/** Extract the price in cents and recurrence kind from a Dodo GET /products response.
 * Dodo schema: is_recurring (boolean), price (number, cents), price_detail?.price (number).
 * If both price sources are undefined, returns 0 cents (non-matching). */
function extractPriceInfo(product: any): { cents: number; recurring: boolean } {
    const recurring = product.is_recurring ?? false;
    const cents = product.price ?? product.price_detail?.price ?? 0;
    return { cents, recurring };
}

let items: any[] = [];
if (DRY) {
    console.log(`--dry-run: would authenticate against ${BASE}`);
} else {
    // A live key is the ONLY thing that authenticates against live.dodopayments.com
    // — a test key 401s here, which is the live-mode check.
    const existing = await api('/products?page_size=100');
    items = existing.items ?? existing ?? [];
    console.log(`Authenticated against ${BASE} — ${items.length} existing product(s).`);
    if (items.length) {
        for (const p of items) {
            const { cents, recurring } = extractPriceInfo(p);
            console.log(`  existing: ${p.product_id}  ${p.name}  $${(cents / 100).toFixed(2)}  recurring=${recurring}`);
        }
    }
}
console.log('');

const results: { varName: string; id: string; status: string }[] = [];

for (const s of SPECS) {
    // Find existing product matching name + price + recurrence (idempotency key).
    let exactMatch: any = null;
    let nameCollision: any = null;
    for (const p of items) {
        if (p.name === s.name) {
            const { cents, recurring } = extractPriceInfo(p);
            if (cents === s.cents && recurring === s.recurring) {
                exactMatch = p;
                break;
            } else {
                nameCollision = p;
                break;
            }
        }
    }

    if (exactMatch) {
        console.log(`SKIP   ${s.name} — already exists as ${exactMatch.product_id}`);
        results.push({ varName: s.varName, id: exactMatch.product_id, status: 'existing' });
        continue;
    }

    if (nameCollision) {
        const { cents: existingCents, recurring: existingRecurring } = extractPriceInfo(nameCollision);
        console.log(`COLLISION  ${s.name}: existing product ${nameCollision.product_id} has $${(existingCents / 100).toFixed(2)} recurring=${existingRecurring}, but spec requires $${(s.cents / 100).toFixed(2)} recurring=${s.recurring}`);
    }

    if (DRY) {
        console.log(`WOULD CREATE  ${s.name}  $${(s.cents / 100).toFixed(2)}  recurring=${s.recurring}`);
        continue;
    }

    const p = await api('/products', {
        method: 'POST',
        body: JSON.stringify({
            name: s.name,
            description: s.description,
            tax_category: 'saas',
            price: priceBody(s),
        }),
    });
    console.log(`CREATE ${s.name} → ${p.product_id}`);
    results.push({ varName: s.varName, id: p.product_id, status: 'created' });
}

if (DRY) {
    console.log('\n─── five-product plan (--dry-run) ───');
    for (const s of SPECS) {
        console.log(`${s.varName} = "pdt_<id>"  # ${s.name}: $${(s.cents / 100).toFixed(2)} ${s.recurring ? 'recurring' : 'one-time'}`);
    }
    console.log('───────────────────────────────────────────────────────────────────');
    console.log('--dry-run: no network call, no products created.');
    process.exit(0);
}

console.log('\n─── paste into the PROD [vars] block of arcane-server/wrangler.toml ───');
for (const r of results) console.log(`${r.varName} = "${r.id}"`);
console.log('───────────────────────────────────────────────────────────────────────');
// The dev worker talks to test.dodopayments.com, not live.dodopayments.com —
// these LIVE-mode ids would 404 every checkout there. Do NOT paste them into
// [env.dev.vars]; DEV needs its own TEST-mode products, created separately
// with the test API key (owner checklist).
console.log('\n─── do NOT paste these into the DEV [env.dev.vars] block ───');
console.log('DEV uses TEST-mode products (dev worker talks to test.dodopayments.com;');
console.log('these are LIVE-mode ids — they would 404 every checkout there). Provision');
console.log('DEV\'s products separately with the TEST-mode API key (owner checklist).');
console.log('───────────────────────────────────────────────────────────────────────');
