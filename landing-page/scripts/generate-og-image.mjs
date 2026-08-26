#!/usr/bin/env node
/**
 * Generates public/og-image.png — the social preview card — and downsizes the
 * nav/footer logo.
 *
 * Both exist for the same reason: the site had no og:image at all, so every
 * shared link rendered as a bare URL, and public/icon.png shipped at ~473KB
 * while being displayed at 36x36 in the navbar on every single page. On the one
 * page we most want to rank, that is a pure Core Web Vitals cost for no visual
 * gain.
 *
 * Committed rather than run at build time: the output is a static asset that
 * changes only when the wordmark or tagline does, and a build-time dependency
 * on sharp's native binary is a worse trade than a checked-in PNG. Re-run by
 * hand (`pnpm run og`) after changing the copy below.
 *
 * Colours are read off src/styles/global.css (--background 220 26% 14%,
 * --primary 35 95% 55%, --foreground 40 10% 92%).
 */
import sharp from 'sharp';
import { statSync } from 'node:fs';

const BG = '#1a1f2b';
const BG2 = '#12151d';
const PRIMARY = '#f9a23a';
const FG = '#eceae6';
const MUTED = '#8b93a1';

const kb = (p) => `${(statSync(p).size / 1024).toFixed(0)}KB`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${BG}"/><stop offset="100%" stop-color="${BG2}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.18" cy="0.22" r="0.5">
      <stop offset="0%" stop-color="${PRIMARY}" stop-opacity="0.20"/>
      <stop offset="100%" stop-color="${PRIMARY}" stop-opacity="0"/>
    </radialGradient>
    <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse">
      <path d="M48 0H0V48" fill="none" stroke="${FG}" stroke-opacity="0.045" stroke-width="1"/>
    </pattern>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect width="1200" height="630" fill="url(#grid)"/>
  <rect width="1200" height="630" fill="url(#glow)"/>
  <rect x="0" y="0" width="1200" height="6" fill="${PRIMARY}"/>
  <g font-family="Inter, Helvetica, Arial, sans-serif">
    <text x="96" y="250" font-size="112" font-weight="800" fill="${FG}" letter-spacing="-3">Unity<tspan fill="${PRIMARY}">IDE</tspan></text>
    <text x="96" y="342" font-size="46" font-weight="600" fill="${FG}" letter-spacing="-1">The IDE for Unity</text>
    <text x="96" y="404" font-size="28" font-weight="400" fill="${MUTED}">AI that reads your scenes, prefabs and C# — wired into the running Editor.</text>
    <text x="96" y="536" font-size="24" font-weight="500" fill="${MUTED}">unityide.app</text>
    <text x="96" y="576" font-size="20" font-weight="400" fill="${MUTED}" fill-opacity="0.7">macOS &amp; Windows · Free during beta</text>
  </g>
</svg>`;

await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile('public/og-image.png');
console.log(`og-image.png  1200x630  ${kb('public/og-image.png')}`);

// 128px covers a 36x36 render at 3x DPI with room to spare.
const before = kb('public/icon.png');
const buf = await sharp('public/icon.png')
  .resize(128, 128, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png({ compressionLevel: 9 })
  .toBuffer();
await sharp(buf).toFile('public/icon.png');
console.log(`icon.png      128x128   ${before} -> ${kb('public/icon.png')}`);
