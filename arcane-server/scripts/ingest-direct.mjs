#!/usr/bin/env node
// One-time, standalone ingest of the Unity API corpus straight into Cloudflare
// Vectorize + D1 — NO Worker route involved. Uses the Cloudflare REST API,
// reusing your existing `wrangler login` OAuth token (no new credential to
// create). Embeddings use the SAME model the search route uses at query time
// (@cf/baai/bge-small-en-v1.5, 384-dim) so index/query vectors are compatible.
//
// Usage:
//   node scripts/ingest-direct.mjs --version 6000.3 --api ./out/api-6000.3.json [--reset] [--resume] [--batch 64]
//
// Auth: reads CLOUDFLARE_API_TOKEN if set, else the oauth_token from
// ~/Library/Preferences/.wrangler/config/default.toml (run `npx wrangler login`
// first). If a run 401s mid-way (OAuth tokens last ~1h), run any wrangler command
// to refresh, then re-run with --resume.

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const args = parseArgs(process.argv.slice(2));
const VERSION = args.version || fail('Pass --version <major.minor>, e.g. --version 6000.3');
const API_PATH = args.api ?? `./out/api-${VERSION}.json`;
const BATCH = Number(args.batch ?? 64);          // ≤90 keeps D1 multi-row params < SQLite's 999 cap

const ACCOUNT_ID = args.account ?? '1420a69fe10a9c3d49ccb95c432b9412';
const D1_DATABASE_ID = args.d1 ?? 'fdc0556c-e622-44db-a189-1be9a55acb80';
const INDEX = args.index ?? 'unity-docs-v1';
const EMBED_MODEL = '@cf/baai/bge-small-en-v1.5';
const MAX_STORED_TEXT = 4000;

const CF = 'https://api.cloudflare.com/client/v4';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN || readWranglerToken() || fail('No token: set CLOUDFLARE_API_TOKEN or run `npx wrangler login`.');

const records = JSON.parse(readFileSync(API_PATH, 'utf8'));
console.log(`[direct] version=${VERSION}  records=${records.length}  batch=${BATCH}`);

const progressPath = join(dirname(API_PATH), `.direct-progress-${VERSION}.json`);
const progress = args.resume && existsSync(progressPath)
    ? JSON.parse(readFileSync(progressPath, 'utf8'))
    : { offset: 0 };

async function main() {
    if (args.reset && progress.offset === 0) {
        console.log('[direct] reset: DELETE existing rows for this version');
        await d1Query('DELETE FROM unity_api_signatures WHERE unity_version = ?', [VERSION]);
        // Vectorize has no delete-by-filter; deterministic ids make upsert idempotent.
    }

    let vectors = 0;
    for (let i = progress.offset; i < records.length; i += BATCH) {
        const batch = records.slice(i, i + BATCH).map((r) => ({ ...r, unityVersion: VERSION }));
        await ingestBatch(batch);
        vectors += batch.length;
        progress.offset = i + batch.length;
        writeFileSync(progressPath, JSON.stringify(progress));
        process.stdout.write(`\r[direct] ${progress.offset}/${records.length}  vectors≈${vectors}   `);
    }
    process.stdout.write('\n');
    console.log('[direct] done. Vectorize upserts are eventually-consistent — allow a few minutes before querying.');
}

async function ingestBatch(batch) {
    // 1. Build embedding texts + per-record metadata.
    const texts = [];
    const meta = [];
    for (const r of batch) {
        const breadcrumb = `${r.namespace ?? ''}${r.namespace ? '.' : ''}${r.type}.${r.member}`;
        const text = `${breadcrumb} — ${r.signature}` +
            (r.deprecated ? ` (DEPRECATED${r.obsoleteMessage ? `: ${r.obsoleteMessage}` : ''})` : '');
        texts.push(text);
        meta.push({
            id: `a${hash64(`${VERSION}:${r.namespace ?? ''}.${r.type}.${r.member}:${r.kind}`)}`,
            metadata: {
                text: text.slice(0, MAX_STORED_TEXT),
                unityVersion: VERSION, docType: 'api',
                type: s(r.type), member: s(r.member), namespace: s(r.namespace), breadcrumb,
                renderPipeline: 'any', inputSystem: 'any',
                deprecated: r.deprecated ? 'true' : 'false', url: s(r.docUrl),
            },
        });
    }

    // 2. Embed (Workers AI REST) — sub-batch at 64 (model batch cap).
    const embeddings = await embed(texts);

    // 3. Upsert to Vectorize (NDJSON).
    const ndjson = embeddings.map((values, i) =>
        JSON.stringify({ id: meta[i].id, values, metadata: meta[i].metadata })).join('\n');
    await cf(`/accounts/${ACCOUNT_ID}/vectorize/v2/indexes/${INDEX}/upsert`, ndjson, 'application/x-ndjson');

    // 4. Insert signatures into D1. D1's REST query caps bound params at ~100, so
    // use safely-escaped inline VALUES (one INSERT for the whole batch instead).
    const cols = '(unity_version,namespace,type,member,kind,signature,overloads_json,assembly,deprecated,obsolete_message,doc_url)';
    const rows = batch.map((r) => '(' + [
        q(VERSION), q(r.namespace ?? ''), q(r.type), q(r.member), q(r.kind), q(r.signature),
        r.overloads?.length ? q(JSON.stringify(r.overloads)) : 'NULL',
        r.assembly ? q(r.assembly) : 'NULL',
        r.deprecated ? 1 : 0,
        r.obsoleteMessage ? q(r.obsoleteMessage) : 'NULL',
        r.docUrl ? q(r.docUrl) : 'NULL',
    ].join(',') + ')').join(',');
    await d1Query(`INSERT OR REPLACE INTO unity_api_signatures ${cols} VALUES ${rows}`);
}

/** SQLite single-quoted string literal with quote-escaping. */
function q(v) { return `'${String(v).replace(/'/g, "''")}'`; }

async function embed(texts) {
    const out = [];
    for (let i = 0; i < texts.length; i += 64) {
        const r = await cfJson(`/accounts/${ACCOUNT_ID}/ai/run/${EMBED_MODEL}`, { text: texts.slice(i, i + 64) });
        for (const v of r.result.data) out.push(v);
    }
    return out;
}

async function d1Query(sql, params) {
    const body = params ? { sql, params } : { sql };
    return cfJson(`/accounts/${ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query`, body);
}

// ── REST helpers with retry/backoff ───────────────────────────────────────────
async function cfJson(path, body, attempt = 0) {
    return cf(path, JSON.stringify(body), 'application/json', attempt);
}
async function cf(path, body, contentType, attempt = 0) {
    try {
        const res = await fetch(`${CF}${path}`, {
            method: 'POST',
            headers: { authorization: `Bearer ${TOKEN}`, 'content-type': contentType },
            body,
        });
        const text = await res.text();
        if (res.status === 401) fail('401 Unauthorized — token expired. Run `npx wrangler whoami`, then re-run with --resume.');
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        const json = JSON.parse(text);
        if (!json.success) throw new Error(`CF error: ${JSON.stringify(json.errors)?.slice(0, 300)}`);
        return json;
    } catch (err) {
        if (attempt >= 5) fail(`Giving up after retries: ${err.message}`);
        const backoff = 1000 * 2 ** attempt;
        process.stderr.write(`\n[direct] retry in ${backoff}ms (${err.message})\n`);
        await new Promise((r) => setTimeout(r, backoff));
        return cf(path, body, contentType, attempt + 1);
    }
}

// ── misc ──────────────────────────────────────────────────────────────────────
function hash64(str) {
    let h = 0xcbf29ce484222325n;
    const mask = 0xffffffffffffffffn;
    for (let i = 0; i < str.length; i++) { h ^= BigInt(str.charCodeAt(i)); h = (h * 0x100000001b3n) & mask; }
    return h.toString(16).padStart(16, '0');
}
function s(v) { return v == null ? '' : String(v); }
function readWranglerToken() {
    const candidates = [
        join(homedir(), 'Library/Preferences/.wrangler/config/default.toml'),
        join(homedir(), '.config/.wrangler/config/default.toml'),
        join(homedir(), '.wrangler/config/default.toml'),
    ];
    for (const p of candidates) {
        if (!existsSync(p)) continue;
        const m = readFileSync(p, 'utf8').match(/^oauth_token\s*=\s*"([^"]+)"/m);
        if (m) return m[1];
    }
    return null;
}
function fail(msg) { console.error(`\n[direct] ERROR: ${msg}`); process.exit(1); }
function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) { const k = a.slice(2); const n = argv[i + 1]; if (n && !n.startsWith('--')) { out[k] = n; i++; } else out[k] = true; }
    }
    return out;
}

main().catch((e) => fail(e.stack ?? e.message));
