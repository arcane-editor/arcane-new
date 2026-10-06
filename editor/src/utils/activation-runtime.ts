import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { API_URL } from '../config/api';
import { useAuthStore } from '../stores/auth';
import { detectChannel, detectOs } from './crash-report';
import { createActivationReporter } from './activation-report';

let reporter: Promise<ReturnType<typeof createActivationReporter>> | null = null;

function getReporter() {
  reporter ??= getVersion().then((appVersion) => {
    const instance = createActivationReporter({
      invoke, fetchImpl: fetch, baseUrl: API_URL,
      getToken: () => useAuthStore.getState().token,
      metadata: { appVersion, os: detectOs(), channel: detectChannel() },
      newId: () => crypto.randomUUID(),
    });
    useAuthStore.subscribe((state, previous) => {
      if (state.token !== previous.token) instance.wake();
    });
    window.addEventListener('online', () => instance.wake());
    instance.start();
    return instance;
  }).catch((error) => { reporter = null; throw error; });
  return reporter;
}

/** Runs in welcome and project windows so previously queued offline work can
 * finish even when the next launch does not open a Unity project. */
export function startActivationReporting(): void {
  void getReporter().catch(() => {});
}

/** Called only for a successfully opened Unity root. Native code independently
 * verifies a compatible, current bridge handshake for this exact local path. */
export function observeUnityActivation(workspacePath: string): void {
  void getReporter().then((instance) => instance.observe(workspacePath)).catch(() => {});
}
