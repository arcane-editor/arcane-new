#!/usr/bin/env node
/**
 * Brand audit for the Arcane -> UnityIDE rename.
 *
 * The rename touches ~1,900 occurrences across four packages, and a handful of
 * lookalike tokens must survive it untouched: the D1 binding `arcane_db`, the
 * Cloudflare worker/bucket/gateway/Pages names, and the three Dodo metadata
 * keys that are round-tripped through a third party. A single over-broad
 * `s/arcane/unityide/` silently breaks any of them, and the failure surfaces at
 * runtime in production rather than in a test.
 *
 * So this script does two things on every commit of the rename:
 *   1. Asserts each allowlisted token still appears EXACTLY as often as it did
 *      at the start. A drift means a bulk edit reached something it shouldn't.
 *   2. Reports what brand tokens remain, so the tail is visible rather than
 *      discovered later.
 *
 * Driven off `git ls-files`, deliberately: it cannot see gitignored trees
 * (editor/unity-bridge, the sidecar build and dist dirs, node_modules, target),
 * so the whole class of "the sed ate a generated file" cannot happen here.
 *
 * Usage:
 *   node scripts/brand-audit.mjs            # report + allowlist drift check
 *   node scripts/brand-audit.mjs --strict   # additionally require zero remaining
 *   node scripts/brand-audit.mjs --baseline # print counts as a BASELINE literal
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Tokens that MUST survive the rename, with the count observed before it
 * started. Exact equality, not a floor: a count going UP is as suspicious as
 * one going down (it usually means a rename introduced a new lookalike).
 *
 * Ordered longest-prefix-first so `arcane-db` cannot swallow `arcane-db-dev`
 * before the more specific entry is tried. See `classify`.
 */
const ALLOWLIST = {
  'arcane-ai-gateway': 2,   // Cloudflare AI Gateway id (account-scoped resource)
  // Repo folder name, deliberately kept. Walked 20 -> 19 -> 16 -> 18: the UPM
  // Documentation~ file was renamed, then the three github.com/arcane-ide/
  // arcane-extension URLs left with the domain move, and then it went back UP
  // by two when stale "sibling `arcane` repo" prose was corrected to name the
  // actual in-tree directory. All 18 are genuine paths to it — CI working-dirs,
  // two .gitignores, the bridge sync script, AGENTS.md, SPEC.md.
  // 18 -> 17 when AGENTS.md was excluded (see EXCLUDE).
  //
  // 17 -> 22 for the dev-channel Unity package (2026-08-31). The extension now
  // ships once per release channel, and the packaging path names its source
  // directory in five new places: `deploy.sh`'s staging comment, one comment in
  // `sync-unity-bridge.mjs`, two lines in the new `unity-extension-dev` job in
  // dev-build.yml, and one comment in `scripts/unity-extension-channel.mjs`.
  // All five are genuine paths to the in-tree package, same as the other 17.
  //
  // Adjust this deliberately and say why; never edit it to silence a surprise.
  'arcane-extension': 22,
  // +2 (2026-08-31): the two R2 keys the dev-channel Unity package is published
  // under, in dev-build.yml's `unity-extension-dev` job.
  'arcane-releases': 27,   // +3: named in the cutover runbook    // R2 bucket name, deliberately kept
  'arcane-landing': 8,     // +2: named in the cutover runbook      // Cloudflare Pages project names
  'arcane-server': 80,      // worker name + JWT_ISSUER + OAUTH_COOKIE_ISSUER + user agent
  'arcane_user_id': 9,      // Dodo checkout metadata key (round-trips through Dodo)
  'arcane_kind': 6,         // Dodo checkout metadata key
  'arcane_ref': 6,          // Dodo checkout metadata key
  'arcane_db': 350,         // D1 binding name
  'arcane-db': 16,          // D1 database name
};

/** Dated decision records. Rewriting them would make them lie about the past. */
const EXCLUDE = [
  ':(exclude)docs/superpowers',
  ':(exclude)editor/docs/superpowers',
  ':(exclude)*.tgz',
  ':(exclude)*lock*',
  ':(exclude)scripts/brand-audit.mjs',
  // AGENTS.md documents this allowlist, so by construction it names every
  // protected token. Counting it means the baselines have to be edited every
  // time that section is reworded, which trains you to adjust them reflexively
  // — the one habit that makes this script useless.
  ':(exclude)AGENTS.md',
];

/**
 * A maximal identifier-ish run containing "arcane", in ANY casing.
 *
 * The `i` flag matters and was missing at first: written as `[Aa]rcane` this
 * silently ignored every SCREAMING_CASE occurrence, so the eight ARCANE_* build
 * and test env vars never appeared in the remaining count and the audit
 * reported no change across the commit that renamed them. A completeness gate
 * that cannot see a whole casing class is worse than none, because it reads as
 * reassurance.
 */
const TOKEN = /[A-Za-z0-9_.-]*arcane[A-Za-z0-9_.-]*/gi;

function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z', '--', '.', ...EXCLUDE], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\0').filter(Boolean);
}

/**
 * Which allowlist entry, if any, owns this token. Longest prefix wins so
 * `arcane-server-dev` is attributed to `arcane-server` rather than falling
 * through to the remaining bucket.
 */
function classify(token) {
  const lower = token.toLowerCase();
  let best = null;
  for (const key of Object.keys(ALLOWLIST)) {
    const at = lower.indexOf(key);
    if (at === -1) continue;
    if (best === null || key.length > best.length) best = key;
  }
  return best;
}

const files = trackedFiles();
const counts = Object.fromEntries(Object.keys(ALLOWLIST).map((k) => [k, 0]));
/** @type {Map<string, {count: number, files: Set<string>}>} */
const remaining = new Map();

for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue; // unreadable or binary; git already filtered most of these
  }
  if (text.includes('\0')) continue; // binary
  for (const [token] of text.matchAll(TOKEN)) {
    const owner = classify(token);
    if (owner) {
      counts[owner] += 1;
      continue;
    }
    const entry = remaining.get(token) ?? { count: 0, files: new Set() };
    entry.count += 1;
    entry.files.add(file);
    remaining.set(token, entry);
  }
}

if (process.argv.includes('--baseline')) {
  for (const [key, n] of Object.entries(counts)) console.log(`  '${key}': ${n},`);
  process.exit(0);
}

const drift = Object.entries(ALLOWLIST)
  .filter(([key, want]) => counts[key] !== want)
  .map(([key, want]) => `  ${key}: expected ${want}, found ${counts[key]}`);

const remainingTotal = [...remaining.values()].reduce((n, e) => n + e.count, 0);

console.log(`brand-audit — ${files.length} tracked files\n`);
console.log('ALLOWLISTED (must not change):');
for (const [key, want] of Object.entries(ALLOWLIST)) {
  const got = counts[key];
  console.log(`  ${got === want ? 'ok  ' : 'DRIFT'} ${key.padEnd(20)} ${got}/${want}`);
}

console.log(`\nREMAINING brand tokens: ${remainingTotal} (${remaining.size} distinct)`);
const top = [...remaining.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 25);
for (const [token, e] of top) {
  console.log(`  ${String(e.count).padStart(5)}  ${token}   (${e.files.size} files)`);
}
if (remaining.size > top.length) {
  console.log(`  ... ${remaining.size - top.length} more distinct tokens`);
}

if (drift.length > 0) {
  console.error('\nFAIL — an allowlisted token changed count. A bulk edit reached');
  console.error('something it must not touch. Review before committing:\n');
  console.error(drift.join('\n'));
  process.exit(1);
}

if (process.argv.includes('--strict') && remainingTotal > 0) {
  console.error(`\nFAIL (--strict) — ${remainingTotal} brand tokens still present.`);
  process.exit(1);
}

console.log('\nOK');
