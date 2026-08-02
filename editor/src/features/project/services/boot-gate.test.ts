import { describe, it, expect } from 'bun:test';
import { initialBootSurface } from './boot-gate';

describe('initialBootSurface', () => {
  // The bug this guards: an editor window spawned by `openProjectInNewWindow`
  // carries `?path=<project>`, but App's restore runs in a mount effect —
  // i.e. AFTER the first paint. Rendering `<WelcomeScreen />` on that first
  // paint flashed "Open a folder to get started" (plus the RECENT list) for
  // a few hundred ms before the project appeared. On Windows, where webview
  // startup is slower, that read as the IDE blinking every time a folder was
  // opened.
  it('shows the restoring surface when the window was opened with ?path=', () => {
    expect(initialBootSurface('/proj/Assets', null)).toBe('restoring');
  });

  it('shows the restoring surface when a persisted workspace will be reopened', () => {
    expect(initialBootSurface(null, '/proj')).toBe('restoring');
  });

  it('prefers ?path= over the persisted path, matching the restore effect', () => {
    // Mirrors `urlPath ?? persisted?.workspacePath ?? null` in App.tsx — both
    // are truthy here, so a restore is attempted either way.
    expect(initialBootSurface('/from-url', '/from-disk')).toBe('restoring');
  });

  it('shows the welcome surface when there is nothing to restore', () => {
    expect(initialBootSurface(null, null)).toBe('welcome');
    expect(initialBootSurface(undefined, undefined)).toBe('welcome');
  });

  it('treats an empty ?path= as nothing to restore', () => {
    // `?path=` with no value yields '' from URLSearchParams.get, which is
    // falsy — App would not call setWorkspace, so a spinner would hang.
    expect(initialBootSurface('', null)).toBe('welcome');
  });

  it('falls back to the persisted path when ?path= is absent but empty-string persisted is not usable', () => {
    expect(initialBootSurface(null, '')).toBe('welcome');
  });
});
