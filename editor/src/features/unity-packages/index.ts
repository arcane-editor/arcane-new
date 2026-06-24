// Public API for the unity-packages feature.
//
// Provides Unity `Packages/manifest.json` intelligence (completion + hover for
// `com.unity.*` package ids and versions, plus "newer version available" info
// diagnostics) and a read-only banner for `Library/PackageCache/` files.
//
// Activation is Unity-gated and internally inert for non-Unity projects:
// nothing is registered, no diagnostics are published, no banner shows, and the
// registry index is never fetched unless the active workspace is a Unity project
// (and the `unity.packages.manifestIntelligence` setting is enabled).

import type { Monaco } from '@monaco-editor/react';
import { getMonaco } from '../editor';
import { useProjectContextStore } from '../../stores/project-context';
import {
  registerManifestProviders,
  disposeManifestProviders,
  startManifestDiagnostics,
  stopManifestDiagnostics,
} from './services/manifest-providers';

export { PackageCacheBanner, isPackageCachePath } from './components/PackageCacheBanner';

/**
 * Register the Monaco completion + hover providers for Unity package manifests.
 * Returns a disposer. The providers self-gate on `isUnityProject` + the setting
 * and on the model being a `Packages/manifest.json`, so registering them is
 * harmless even before a Unity project is known.
 */
export function registerUnityPackageProviders(monaco: Monaco): () => void {
  return registerManifestProviders(monaco);
}

// ── Feature activation (wired into App.tsx mount effect) ───────────────────────

let active = false;
let monacoPoll: ReturnType<typeof setInterval> | null = null;
let stopDiagnostics: (() => void) | null = null;

/**
 * Activate Unity package-manifest intelligence for the app lifetime. Idempotent.
 * Wires Monaco providers + manifest diagnostics once a Unity project is active,
 * and tears them down when leaving one. Returns a disposer (tests/teardown).
 */
export function initUnityPackagesFeature(): () => void {
  syncForCurrentProject();
  const unsub = useProjectContextStore.subscribe((state, prev) => {
    if (state.isUnityProject !== prev.isUnityProject) {
      syncForCurrentProject();
    }
  });

  return () => {
    unsub();
    teardown();
  };
}

function syncForCurrentProject(): void {
  if (useProjectContextStore.getState().isUnityProject) {
    activate();
  } else {
    teardown();
  }
}

function activate(): void {
  if (active) return;
  active = true;
  startWhenMonacoReady();
}

/**
 * Providers need a Monaco instance, which only exists once an editor has
 * mounted. Poll briefly until Monaco is available, then register. Bails if the
 * project flips to non-Unity while we wait.
 */
function startWhenMonacoReady(): void {
  if (monacoPoll) return;
  const tryStart = (): boolean => {
    if (!active || !useProjectContextStore.getState().isUnityProject) {
      return true; // stop polling
    }
    const monaco = getMonaco();
    if (monaco) {
      registerManifestProviders(monaco);
      stopDiagnostics = startManifestDiagnostics(monaco);
      return true;
    }
    return false;
  };
  if (tryStart()) return;
  monacoPoll = setInterval(() => {
    if (tryStart()) {
      if (monacoPoll) clearInterval(monacoPoll);
      monacoPoll = null;
    }
  }, 500);
}

function teardown(): void {
  if (monacoPoll) {
    clearInterval(monacoPoll);
    monacoPoll = null;
  }
  if (stopDiagnostics) {
    stopDiagnostics();
    stopDiagnostics = null;
  } else {
    stopManifestDiagnostics();
  }
  disposeManifestProviders();
  active = false;
}
