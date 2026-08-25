#!/usr/bin/env node
// Usage:
//   node editor/scripts/write-update-manifest.mjs \
//     --platform darwin-aarch64 --version 0.3.2 \
//     --url https://releases.arcaneai.org/v0.3.2/Arcane.app.tar.gz \
//     --sig dist-release/Arcane.app.tar.gz.sig \
//     --out dist-release/darwin-aarch64.json
import { readFileSync, writeFileSync } from 'node:fs';
import { buildManifest } from './update-manifest.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => {
    if (arg.startsWith('--')) pairs.push([arg.slice(2), all[i + 1]]);
    return pairs;
  }, []),
);

const manifest = buildManifest({
  platform: args.platform,
  version: args.version,
  url: args.url,
  signature: readFileSync(args.sig, 'utf8'),
  pubDate: new Date().toISOString(),
});

writeFileSync(args.out, JSON.stringify(manifest, null, 2));
console.log(`wrote ${args.out}: ${manifest.version} -> ${manifest.platforms[args.platform].url}`);
