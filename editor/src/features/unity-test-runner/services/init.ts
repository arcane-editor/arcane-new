import { listenScoped } from '../../../utils/tauri-listener';
import { useTestStore } from '../stores/test-store';
import type { TestRunCompletedPayload } from '../../../types/unity';

let initialized = false;

/**
 * Wire the live `unity-test-event` stream (from the C# TestRunnerHandlers, and
 * the headless run emits the same shape) and the `unity-test-run-completed`
 * push (a queued `runTests`' real completion — see `services/test-run-wait-core.ts`)
 * into the test store. Idempotent; call once on app mount. Inert until events
 * arrive, so it's safe for non-Unity projects.
 */
export function initTestRunner(): void {
  if (initialized) return;
  initialized = true;
  listenScoped<Record<string, unknown>>('unity-test-event', (e) => {
    useTestStore.getState().applyEvent(e.payload);
  }).catch(() => {
    initialized = false;
  });
  listenScoped<TestRunCompletedPayload>('unity-test-run-completed', (e) => {
    useTestStore.getState().applyRunCompleted(e.payload);
  }).catch(() => {
    initialized = false;
  });
}
