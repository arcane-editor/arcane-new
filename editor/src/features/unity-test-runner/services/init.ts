import { listen } from '@tauri-apps/api/event';
import { useTestStore } from '../stores/test-store';

let initialized = false;

/**
 * Wire the live `unity-test-event` stream (from the C# TestRunnerHandlers, and
 * the headless run emits the same shape) into the test store. Idempotent; call
 * once on app mount. Inert until events arrive, so it's safe for non-Unity
 * projects.
 */
export function initTestRunner(): void {
  if (initialized) return;
  initialized = true;
  listen<Record<string, unknown>>('unity-test-event', (e) => {
    useTestStore.getState().applyEvent(e.payload);
  }).catch(() => {
    initialized = false;
  });
}
