import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '../../..');
const CSS = readFileSync(path.join(ROOT, 'src/App.css'), 'utf8');
const MAIN = readFileSync(path.join(ROOT, 'src/main.tsx'), 'utf8');

/**
 * `titleBarStyle: "Overlay"` and `hiddenTitle` are macOS-only Tauri options,
 * and `decorations` defaults to true — so on Windows and Linux the OS drew its
 * own title bar and the app drew a second one directly beneath it. Inside the
 * app's bar, 78px of left padding was reserved for macOS's close/minimize/zoom
 * buttons, which do not exist there, leaving a conspicuous dead band beside the
 * wordmark on every window.
 *
 * `isWindows()` already existed in utils/platform.ts for exactly this and had
 * zero callers.
 */
describe('title bar', () => {
  it('reserves the traffic-light gutter only on macOS', () => {
    const start = CSS.indexOf('.title-bar {');
    expect(start).toBeGreaterThan(-1);
    const rule = CSS.slice(start, start + 400);
    expect(rule).not.toMatch(/padding:[^;]*78px/);
  });

  it('scopes the gutter behind a macOS selector', () => {
    expect(CSS).toMatch(/\[data-os=['"]macos['"]\][^{]*\.title-bar/);
  });

  it('stamps the platform on the document so CSS can branch on it', () => {
    expect(MAIN).toMatch(/dataset\.os|setAttribute\(\s*['"]data-os['"]/);
  });
});
