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
 * Colours are read off src/styles/global.css, which now derives from the
 * desktop app's own theme: --void #08070C, --primary (candle gold) #D4B062,
 * --foreground #E2E0DA, --muted-foreground #7E7B86.
 */
import sharp from 'sharp';
import { statSync } from 'node:fs';

const BG = '#0B0A10';
const BG2 = '#08070C';
const PRIMARY = '#D4B062';
const FG = '#E2E0DA';
const MUTED = '#7E7B86';

const kb = (p) => `${(statSync(p).size / 1024).toFixed(0)}KB`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${BG}"/><stop offset="100%" stop-color="${BG2}"/>
    </linearGradient>
    <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse">
      <path d="M48 0H0V48" fill="none" stroke="${FG}" stroke-opacity="0.045" stroke-width="1"/>
    </pattern>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect width="1200" height="630" fill="url(#grid)"/>
  <rect x="0" y="0" width="1200" height="6" fill="${PRIMARY}"/>
  <g font-family="Instrument Sans, Helvetica, Arial, sans-serif">
    <text x="96" y="250" font-size="112" font-weight="800" fill="${FG}" letter-spacing="-3">Unity<tspan fill="${PRIMARY}">IDE</tspan></text>
    <text x="96" y="342" font-size="38" font-weight="600" fill="${FG}" letter-spacing="-1">We wanted a better IDE for Unity. So we built one.</text>
    <text x="96" y="404" font-size="28" font-weight="400" fill="${MUTED}">Every panel exists because something in Unity cost us a day.</text>
    <text x="96" y="536" font-size="24" font-weight="500" fill="${MUTED}">unityide.app</text>
    <text x="96" y="576" font-size="20" font-weight="400" fill="${MUTED}" fill-opacity="0.7">The IDE for Unity. Windows and macOS.</text>
  </g>
</svg>`;

await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile('public/og-image.png');
console.log(`og-image.png  1200x630  ${kb('public/og-image.png')}`);

// 128px covers a 36x36 render at 3x DPI with room to spare. Skip when the file
// has already been downsized, so re-running for the OG card does not produce a
// pointless binary diff on the icon.
const { width: iconWidth } = await sharp('public/icon.png').metadata();
if (iconWidth <= 128) {
  console.log(`icon.png      ${iconWidth}x${iconWidth}   already downsized, skipped`);
  process.exit(0);
}
const before = kb('public/icon.png');
const buf = await sharp('public/icon.png')
  .resize(128, 128, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png({ compressionLevel: 9 })
  .toBuffer();
await sharp(buf).toFile('public/icon.png');
console.log(`icon.png      128x128   ${before} -> ${kb('public/icon.png')}`);
