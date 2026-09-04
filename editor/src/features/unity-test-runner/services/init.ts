import { listenScoped } from '../../../utils/tauri-listener';
import { useTestStore } from '../stores/test-store';
import type { TestRunCompletedPayload } from '../../../types/unity';

let initialized = false;
/**
 * Per-listener attachment flags. `initialized` alone is not enough to guard a
 * retry: if ONE of the two `listenScoped` calls below fails while the OTHER
 * succeeds, `initialized` flips back to false so a later `initTestRunner()`
 * call can retry — but without these, that retry re-registered the listener
 * that had ALREADY succeeded too, leaving `unity-test-event` (or the
 * completed push) double-wired (M5, task-11 fix round 1).
 */
let testEventAttached = false;
let testRunCompletedAttached = false;

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

  if (!testEventAttached) {
    listenScoped<Record<string, unknown>>('unity-test-event', (e) => {
      useTestStore.getState().applyEvent(e.payload);
    }).then(
      () => {
        testEventAttached = true;
      },
      () => {
        initialized = false;
      },
    );
  }

  if (!testRunCompletedAttached) {
    listenScoped<TestRunCompletedPayload>('unity-test-run-completed', (e) => {
      useTestStore.getState().applyRunCompleted(e.payload);
    }).then(
      () => {
        testRunCompletedAttached = true;
      },
      () => {
        initialized = false;
      },
    );
  }
}
