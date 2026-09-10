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

/**
 * The project-management window (`WelcomeApp`, label `welcome`) is a second
 * shell with its own title strip, and it was never given the same treatment.
 * `lib.rs` turns its decorations off off-macOS — for the same doubled-bar
 * reason as the project window — but nothing drew the minimize / maximize /
 * close it then owes the user, so on Windows and Linux the manager had no
 * window controls at all, while macOS's overlaid traffic lights (and the 80px
 * gutter reserved for them, unconditionally) were the only chrome present.
 */
describe('project-management window', () => {
  const WELCOME = readFileSync(path.join(ROOT, 'src/WelcomeApp.tsx'), 'utf8');
  const MULTI_WINDOW = readFileSync(
    path.join(ROOT, 'src/features/project/services/multi-window.ts'),
    'utf8',
  );

  it('draws its own window controls where the OS draws none', () => {
    expect(WELCOME).toMatch(/!isMac\(\)\s*&&\s*<WindowControls\s*\/>/);
  });

  it('reserves the traffic-light gutter only on macOS', () => {
    const gutters = WELCOME.match(/paddingLeft:[^,}\n]*/g) ?? [];
    expect(gutters.length).toBeGreaterThan(0);
    for (const gutter of gutters) expect(gutter).toMatch(/isMac\(\)/);
  });

  it('turns decorations off off-macOS when it spawns the window itself', () => {
    const start = MULTI_WINDOW.indexOf("new WebviewWindow('welcome'");
    expect(start).toBeGreaterThan(-1);
    expect(MULTI_WINDOW.slice(start, start + 1000)).toMatch(/decorations:\s*isMac\(\)/);
  });
});
