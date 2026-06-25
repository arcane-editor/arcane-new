#!/usr/bin/env node
// Parse a Unity OFFLINE documentation bundle (the per-version HTML archive that
// covers both ScriptReference and the Manual) into doc-prose chunks for
// Vectorize. Dependency-free HTML→text extraction tuned for Unity's docs markup.
//
// Where to get the bundle: each Unity version ships an offline docs download
// (Unity Hub → Downloads, or docs.unity3d.com/<version>/Documentation/...).
// Point --docs-root at the extracted ".../Documentation/en" directory, which
// contains ScriptReference/ and Manual/ subfolders of .html files.
//
// Usage:
//   node scripts/parse-unity-docs.mjs \
//     --docs-root "/path/to/UnityDocumentation/en" \
//     --version 6000.0 --out ./out/docs-6000.0.jsonl
//
// Output: one DocChunk JSON object per line:
//   { id, text, title, breadcrumb, docType, type?, member?, url }

import { readdirSync, readFileSync, writeFileSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';

const args = parseArgs(process.argv.slice(2));
const root = args['docs-root'];
const version = args.version;
const outPath = args.out ?? `./out/docs-${version}.jsonl`;
const MANUAL_CHUNK_CHARS = 2200;   // ~500-600 tokens
const MANUAL_OVERLAP_CHARS = 300;

if (!root || !version) fail('Usage: --docs-root <.../Documentation/en> --version <major.minor> [--out file]');

const docBase = `https://docs.unity3d.com/${version}/Documentation`;
const out = [];

const scriptRefDir = findDir(root, 'ScriptReference');
const manualDir = findDir(root, 'Manual');
if (!scriptRefDir && !manualDir) fail(`No ScriptReference/ or Manual/ under ${root}`);

if (scriptRefDir) {
    console.log(`[docs] parsing ScriptReference: ${scriptRefDir}`);
    for (const file of htmlFiles(scriptRefDir)) parseScriptRef(file);
}
if (manualDir) {
    console.log(`[docs] parsing Manual: ${manualDir}`);
    for (const file of htmlFiles(manualDir)) parseManual(file);
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, out.map((o) => JSON.stringify(o)).join('\n') + '\n');
console.log(`[docs] wrote ${out.length} chunks → ${outPath}`);

// ── ScriptReference: one chunk per member page ────────────────────────────────
function parseScriptRef(file) {
    const name = basename(file, '.html');
    // Skip index/listing/operator pages — keep real API pages.
    if (/^(index|null|30_search|docdata)/i.test(name) || name.includes('-ctor') && name.split('.').length < 2) {
        // keep ctor pages that look like Type-ctor
    }
    const html = readFileSync(file, 'utf8');
    const text = htmlToText(html);
    if (!text || text.length < 40) return;

    // `UnityEngine.Rigidbody.AddForce` / `Rigidbody.AddForce` / `Rigidbody`
    const parts = name.split('.');
    let type, member;
    if (parts.length >= 2) { member = parts[parts.length - 1]; type = parts[parts.length - 2]; }
    else { type = parts[0]; }
    const breadcrumb = name.replace(/-/g, '.');

    out.push({
        id: `scriptref:${version}:${name}`,
        text: clip(text, MANUAL_CHUNK_CHARS * 2),
        title: name,
        breadcrumb,
        docType: 'scriptref',
        type,
        member,
        url: `${docBase}/ScriptReference/${name}.html`,
    });
}

// ── Manual: split each page by length into overlapping chunks ─────────────────
function parseManual(file) {
    const name = basename(file, '.html');
    if (/^(index|30_search|docdata|UnityManual)$/i.test(name)) return;
    const html = readFileSync(file, 'utf8');
    const title = extractTitle(html) ?? name;
    const text = htmlToText(html);
    if (!text || text.length < 80) return;

    const chunks = chunkText(text, MANUAL_CHUNK_CHARS, MANUAL_OVERLAP_CHARS);
    chunks.forEach((chunk, i) => {
        out.push({
            id: `manual:${version}:${name}#${i}`,
            text: chunk,
            title,
            breadcrumb: title,
            docType: 'manual',
            url: `${docBase}/Manual/${name}.html`,
        });
    });
}

// ── HTML → text (dependency-free, tuned for Unity docs) ───────────────────────
function htmlToText(html) {
    let s = html;
    // Prefer the main content container Unity uses; fall back to <body>.
    const content = s.match(/<div[^>]*class="[^"]*\bcontent\b[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i)
        ?? s.match(/<div[^>]*id="content-wrap"[^>]*>([\s\S]*?)<footer/i)
        ?? s.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (content) s = content[1];
    s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        // keep code blocks readable
        .replace(/<\/(p|div|li|tr|h[1-6]|pre|br)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ');
    return decodeEntities(s).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function extractTitle(html) {
    const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (h1) return decodeEntities(h1[1].replace(/<[^>]+>/g, '')).trim();
    const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return t ? decodeEntities(t[1]).replace(/\s*-\s*Unity.*$/i, '').trim() : null;
}

function decodeEntities(s) {
    return s
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function chunkText(text, size, overlap) {
    if (text.length <= size) return [text];
    const chunks = [];
    let i = 0;
    while (i < text.length) {
        let end = Math.min(i + size, text.length);
        // Prefer to break on a paragraph/sentence boundary near the end.
        if (end < text.length) {
            const slice = text.slice(i, end);
            const br = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('. '));
            if (br > size * 0.5) end = i + br + 1;
        }
        chunks.push(text.slice(i, end).trim());
        if (end >= text.length) break;
        i = end - overlap;
    }
    return chunks.filter(Boolean);
}

function clip(s, max) { return s.length > max ? s.slice(0, max) : s; }

function findDir(base, name) {
    const direct = join(base, name);
    if (existsSync(direct) && statSync(direct).isDirectory()) return direct;
    // search one level down
    for (const e of readdirSync(base)) {
        const p = join(base, e, name);
        if (existsSync(p) && statSync(p).isDirectory()) return p;
    }
    return null;
}

function* htmlFiles(dir) {
    for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        const st = statSync(p);
        if (st.isDirectory()) yield* htmlFiles(p);
        else if (e.endsWith('.html')) yield p;
    }
}

function fail(msg) { console.error(`[docs] ERROR: ${msg}`); process.exit(1); }
function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const key = a.slice(2);
            const next = argv[i + 1];
            if (next && !next.startsWith('--')) { out[key] = next; i++; }
            else out[key] = true;
        }
    }
    return out;
}
