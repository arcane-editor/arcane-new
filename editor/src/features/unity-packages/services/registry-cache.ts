import { invoke } from '@tauri-apps/api/core';
import { COMMON_UNITY_PACKAGES, type UnityPackageInfo } from '../data/common-packages';

// ── Registry cache ────────────────────────────────────────────────────────────
//
// Loads the Unity package registry index (best-effort, via the Rust
// `unity_fetch_registry_index` command) and merges it over the static seed list.
// The seed list is always available so completion/hover work fully offline; any
// fresher registry data simply augments or overrides a seed entry.
//
// The Rust command returns `"{}"` when no cached registry is available, so the
// merged result degrades gracefully to the seed list alone.

/** Merged, normalized package map: name → info. Seed list is the baseline. */
let mergedByName: Map<string, UnityPackageInfo> | null = null;
let loadPromise: Promise<void> | null = null;

function seedMap(): Map<string, UnityPackageInfo> {
  const m = new Map<string, UnityPackageInfo>();
  for (const pkg of COMMON_UNITY_PACKAGES) m.set(pkg.name, { ...pkg });
  return m;
}

/**
 * Parse the registry index JSON returned by the backend. We support a few common
 * shapes defensively, since the exact format depends on whatever the backend
 * eventually fetches:
 *
 *   1. npm-style `{ "_fetchedAt": ..., "<name>": { "dist-tags": { "latest": "x" },
 *        "versions": {...}, "description": "..." } }`
 *   2. flat `{ "<name>": "<latestVersion>" }`
 *   3. `{ "packages": [ { "name", "description"?, "version"|"latest"? }, ... ] }`
 *
 * Anything unrecognized is ignored — we never throw.
 */
function parseRegistry(raw: string): UnityPackageInfo[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!data || typeof data !== 'object') return [];

  const out: UnityPackageInfo[] = [];

  // Shape 3: { packages: [...] }
  const asObj = data as Record<string, unknown>;
  if (Array.isArray(asObj.packages)) {
    for (const entry of asObj.packages) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const name = typeof e.name === 'string' ? e.name : undefined;
      if (!name) continue;
      out.push({
        name,
        description: typeof e.description === 'string' ? e.description : undefined,
        latestVersion:
          typeof e.latest === 'string'
            ? e.latest
            : typeof e.version === 'string'
              ? e.version
              : undefined,
      });
    }
    return out;
  }

  // Shapes 1 & 2: top-level keys are package names.
  for (const [name, value] of Object.entries(asObj)) {
    if (name.startsWith('_')) continue; // skip metadata like `_fetchedAt`
    if (!name.includes('.')) continue; // package ids are dotted (com.unity.*)
    if (typeof value === 'string') {
      out.push({ name, latestVersion: value });
      continue;
    }
    if (value && typeof value === 'object') {
      const v = value as Record<string, unknown>;
      const distTags = v['dist-tags'];
      let latest: string | undefined;
      if (distTags && typeof distTags === 'object') {
        const lt = (distTags as Record<string, unknown>).latest;
        if (typeof lt === 'string') latest = lt;
      }
      if (!latest && typeof v.version === 'string') latest = v.version;
      if (!latest && typeof v.latest === 'string') latest = v.latest;
      out.push({
        name,
        description: typeof v.description === 'string' ? v.description : undefined,
        latestVersion: latest,
      });
    }
  }
  return out;
}

/** Compare two semver-ish strings. Returns >0 if `a` is newer than `b`. */
function compareVersions(a: string, b: string): number {
  const norm = (s: string) =>
    s
      .split(/[-+]/)[0] // drop prerelease / build metadata for the core compare
      .split('.')
      .map((n) => parseInt(n, 10))
      .map((n) => (Number.isFinite(n) ? n : 0));
  const pa = norm(a);
  const pb = norm(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

async function doLoad(): Promise<void> {
  const merged = seedMap();
  try {
    const raw = await invoke<string>('unity_fetch_registry_index');
    for (const pkg of parseRegistry(raw)) {
      const existing = merged.get(pkg.name);
      if (existing) {
        // Merge: prefer registry description/version when present.
        merged.set(pkg.name, {
          name: pkg.name,
          description: pkg.description ?? existing.description,
          latestVersion: pkg.latestVersion ?? existing.latestVersion,
        });
      } else {
        merged.set(pkg.name, pkg);
      }
    }
  } catch (err) {
    // Best-effort: the seed list stands alone.
    console.warn('[UnityPackages] registry fetch failed, using seed list only:', err);
  }
  mergedByName = merged;
}

/**
 * Ensure the registry is loaded (idempotent; the fetch happens at most once per
 * session unless `reload()` is called). Safe to await repeatedly.
 */
export function ensureLoaded(): Promise<void> {
  if (mergedByName) return Promise.resolve();
  if (!loadPromise) {
    loadPromise = doLoad().finally(() => {
      loadPromise = null;
    });
  }
  return loadPromise;
}

/** Force a refresh from the backend on next access. */
export function reset(): void {
  mergedByName = null;
  loadPromise = null;
}

/**
 * All known packages (seed ∪ registry). Synchronous: returns the seed list
 * immediately if the async load hasn't completed yet, and triggers a background
 * load so subsequent calls are enriched.
 */
export function getPackages(): UnityPackageInfo[] {
  if (!mergedByName) {
    void ensureLoaded();
    return COMMON_UNITY_PACKAGES.map((p) => ({ ...p }));
  }
  return [...mergedByName.values()];
}

/** Look up a single package by exact id. */
export function lookup(name: string): UnityPackageInfo | undefined {
  if (!mergedByName) {
    void ensureLoaded();
    return COMMON_UNITY_PACKAGES.find((p) => p.name === name);
  }
  return mergedByName.get(name);
}

/**
 * Return the known-latest version for a package if the registry/seed lists a
 * version strictly newer than `current`. Returns null when up-to-date, unknown,
 * or unparseable.
 */
export function newerVersionThan(name: string, current: string): string | null {
  const info = lookup(name);
  const latest = info?.latestVersion;
  if (!latest) return null;
  const c = current.trim();
  // Skip non-pinned dependency forms (git/file/local) — only compare plain semver.
  if (!/^\d+\.\d+/.test(c)) return null;
  try {
    return compareVersions(latest, c) > 0 ? latest : null;
  } catch {
    return null;
  }
}
