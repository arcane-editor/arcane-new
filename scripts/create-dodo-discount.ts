/**
 * Create a Dodo discount code (default: 10% off the FIRST subscription cycle).
 *
 * Run from a shell that has the matching-mode key exported:
 *   export DODO_API_KEY='<test-mode key>'   # or DODO_TEST_API_KEY
 *   bun run scripts/create-dodo-discount.ts --dry-run
 *   bun run scripts/create-dodo-discount.ts                     # TEST mode
 *   export DODO_API_KEY='<live-mode key>'   # or DODO_LIVE_API_KEY
 *   bun run scripts/create-dodo-discount.ts --env live          # LIVE money
 *
 * Defaults to --env test on purpose: a live discount is redeemable by real
 * customers the moment it exists, so going live is an explicit act.
 *
 * Safe to re-run: discounts are matched by code. An existing code is reported
 * and left untouched — never silently rewritten.
 *
 * Flags:
 *   --env test|live     which Dodo host + key mode (default: test)
 *   --code CODE         the customer-facing code (default: WELCOME10)
 *   --percent N         percent off, converted to basis points (default: 10)
 *   --cycles N          billing cycles the discount applies to; 0 = forever
 *                       (default: 1 — first month discounted, renewals full price)
 *   --usage-limit N     max total redemptions across all customers (default: none)
 *   --expires ISO       expiry timestamp, e.g. 2026-12-31T23:59:59Z (default: none)
 *   --first-time-only   restrict to customers who have never purchased
 *   --product pdt_xxx   restrict to this product; repeatable. Overrides the
 *                       wrangler.toml / env-var defaults below.
 *   --all-products      no product restriction (also discounts top-up packs)
 *   --dry-run           print the plan; no key needed, no network call
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ARGV = process.argv.slice(2);
const has = (f: string) => ARGV.includes(f);
function opt(flag: string, fallback?: string): string | undefined {
    const i = ARGV.indexOf(flag);
    return i === -1 || i === ARGV.length - 1 ? fallback : ARGV[i + 1];
}
function optAll(flag: string): string[] {
    const out: string[] = [];
    ARGV.forEach((a, i) => { if (a === flag && ARGV[i + 1]) out.push(ARGV[i + 1]); });
    return out;
}

const DRY = has('--dry-run');
const ENV = (opt('--env', 'test') ?? 'test').toLowerCase();
if (ENV !== 'test' && ENV !== 'live') {
    console.error(`--env must be "test" or "live" (got "${ENV}").`);
    process.exit(1);
}
const LIVE = ENV === 'live';

// dodoApiBase() in arcane-server/src/lib/dodo.ts keys off ENVIRONMENT the same way.
const BASE = LIVE ? 'https://live.dodopayments.com' : 'https://test.dodopayments.com';
const KEY = process.env.DODO_API_KEY
    ?? (LIVE ? process.env.DODO_LIVE_API_KEY : process.env.DODO_TEST_API_KEY);

const CODE = (opt('--code', 'WELCOME10') ?? 'WELCOME10').toUpperCase();
const PERCENT = Number(opt('--percent', '10'));
const CYCLES = Number(opt('--cycles', '1'));
const USAGE_LIMIT = opt('--usage-limit');
const EXPIRES = opt('--expires');
const FIRST_TIME_ONLY = has('--first-time-only');

if (!Number.isFinite(PERCENT) || PERCENT <= 0 || PERCENT > 100) {
    console.error(`--percent must be a number in (0, 100] (got "${opt('--percent')}").`);
    process.exit(1);
}
if (!Number.isInteger(CYCLES) || CYCLES < 0) {
    console.error(`--cycles must be a non-negative integer (0 = forever).`);
    process.exit(1);
}
// Dodo takes percentages in BASIS POINTS: 1000 = 10%, not 10.
const AMOUNT_BP = Math.round(PERCENT * 100);

// ─── Which products the code may be redeemed against ─────────────────────────
// Subscription tiers only by default: a first-cycle discount is meaningless on
// the one-time top-up packs, where it would just be a flat 10% off credits.
const SUB_VARS = ['DODO_PRODUCT_STARTER', 'DODO_PRODUCT_PRO', 'DODO_PRODUCT_MAX'];
const HERE = dirname(fileURLToPath(import.meta.url));
const WRANGLER = resolve(HERE, '../arcane-server/wrangler.toml');

/** Prod subscription product ids live in the [vars] block of wrangler.toml —
 *  read them rather than retyping ids from memory. Dev's ids are deliberately
 *  NOT there (they are worker secrets), so test mode needs env vars or --product. */
function prodProductIds(): string[] {
    let toml: string;
    try {
        toml = readFileSync(WRANGLER, 'utf8');
    } catch {
        return [];
    }
    // Stop at the first named-env block so [env.dev.vars] can never leak in.
    const prodBlock = toml.split(/^\[env\./m)[0];
    const ids: string[] = [];
    for (const v of SUB_VARS) {
        const m = prodBlock.match(new RegExp(`^\\s*${v}\\s*=\\s*"([^"]+)"`, 'm'));
        if (m) ids.push(m[1]);
    }
    return ids;
}

let restrictedTo: string[] = [];
let restrictionSource = '';
const explicit = optAll('--product');
if (has('--all-products')) {
    restrictionSource = '--all-products (no restriction)';
} else if (explicit.length) {
    restrictedTo = explicit;
    restrictionSource = '--product flags';
} else if (LIVE) {
    restrictedTo = prodProductIds();
    restrictionSource = 'arcane-server/wrangler.toml [vars]';
} else {
    restrictedTo = SUB_VARS.map(v => process.env[v]).filter((v): v is string => !!v);
    restrictionSource = 'DODO_PRODUCT_* env vars';
}

const body: Record<string, unknown> = {
    code: CODE,
    type: 'percentage',
    amount: AMOUNT_BP,
    name: `${PERCENT}% off${CYCLES === 1 ? ' first month' : CYCLES ? ` first ${CYCLES} cycles` : ''}`,
};
if (CYCLES > 0) body.subscription_cycles = CYCLES;
if (restrictedTo.length) body.restricted_to = restrictedTo;
if (USAGE_LIMIT) body.usage_limit = Number(USAGE_LIMIT);
if (EXPIRES) body.expires_at = EXPIRES;
if (FIRST_TIME_ONLY) body.customer_eligibility = 'first_time';

console.log(`── ${LIVE ? 'LIVE' : 'TEST'} mode → ${BASE}`);
console.log(`   code             ${CODE}`);
console.log(`   discount         ${PERCENT}%  (amount=${AMOUNT_BP} basis points)`);
console.log(`   applies to       ${CYCLES === 0 ? 'EVERY billing cycle (forever)' : `the first ${CYCLES} billing cycle(s)`}`);
console.log(`   restricted_to    ${restrictedTo.length ? restrictedTo.join(', ') : 'ALL PRODUCTS (incl. top-up packs)'}  [${restrictionSource}]`);
if (USAGE_LIMIT) console.log(`   usage_limit      ${USAGE_LIMIT}`);
if (EXPIRES) console.log(`   expires_at       ${EXPIRES}`);
if (FIRST_TIME_ONLY) console.log(`   eligibility      first_time customers only`);
if (!restrictedTo.length && !has('--all-products')) {
    console.log(`   WARNING: no product ids resolved — the code would apply to EVERY product,`);
    console.log(`            including the one-time top-up packs. Pass --product pdt_xxx`);
    console.log(`            (or export DODO_PRODUCT_STARTER/PRO/MAX) to restrict it.`);
}
console.log('');

if (DRY) {
    console.log('POST /discounts body:');
    console.log(JSON.stringify(body, null, 2));
    console.log('\n--dry-run: no network call, no discount created.');
    process.exit(0);
}

if (!KEY) {
    console.error(`No API key. Export the ${LIVE ? 'LIVE' : 'TEST'}-mode key and re-run:`);
    console.error(`  export DODO_API_KEY='<${LIVE ? 'live' : 'test'}-mode key>'`);
    process.exit(1);
}

async function api(path: string, init?: RequestInit): Promise<any> {
    const res = await fetch(`${BASE}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status} ${text}`);
    return text ? JSON.parse(text) : null;
}

// Idempotency: a code is unique per mode, so an existing one is reported, not rewritten.
const listed = await api('/discounts?page_size=100');
const items: any[] = listed?.items ?? (Array.isArray(listed) ? listed : []);
console.log(`Authenticated against ${BASE} — ${items.length} existing discount(s).`);

const clash = items.find((d) => (d.code ?? '').toUpperCase() === CODE);
if (clash) {
    console.log(`\nSKIP  ${CODE} already exists as ${clash.discount_id ?? clash.id}:`);
    console.log(`      type=${clash.type} amount=${clash.amount} subscription_cycles=${clash.subscription_cycles ?? 'null'}`);
    console.log(`      Nothing was changed. Use --code to pick a different code, or edit`);
    console.log(`      this one in the Dodo dashboard.`);
    process.exit(0);
}

const created = await api('/discounts', { method: 'POST', body: JSON.stringify(body) });
console.log(`\nCREATE ${CODE} → ${created.discount_id ?? created.id}`);
console.log(`Customers can enter it at checkout — feature_flags.allow_discount_code`);
console.log(`defaults to true and createDodoCheckout() does not override it, so the`);
console.log(`discount input is already on the hosted checkout page.`);
