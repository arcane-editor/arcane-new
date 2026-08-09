import { saveLayoutSizes } from '../../utils/persistence';

/**
 * Trailing-edge debounce for layout persistence.
 *
 * Allotment's `onChange` fires once per mousemove frame during a sash drag,
 * and `saveLayoutSizes` reaches an `await store.save()` — a disk write per
 * frame. Only the last value of a drag is worth keeping.
 *
 * The writer is injected rather than imported so the timing can be tested
 * without pulling in the Tauri store, which does not exist under `bun test`.
 *
 * Safe to defer: nothing in-session reads persistence back. App holds the live
 * pane widths in refs and restores from those, so the persisted copy only
 * matters at next launch.
 *
 * `merge`, when given, combines a still-pending value with the next one
 * instead of last-write-wins replacing it. This matters because a caller can
 * persist a *partial* patch — `onLayoutChange` (App.tsx) only includes the
 * side panes currently visible — so two patches queued inside one debounce
 * window can carry different keys: drag both side panes, then hide one
 * before the timer fires, and a plain replace drops the hidden pane's
 * dragged width from ever reaching disk. `verticalPersister` below carries a
 * plain `number[]` with no keys to partially clobber, so it omits `merge`
 * and keeps the original last-write-wins behaviour.
 */
export function createLayoutPersister<T>(
  write: (value: T) => void | Promise<void>,
  delayMs = 250,
  merge?: (prev: T, next: T) => T,
): { persist(value: T): void; flush(): void | Promise<void>; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { value: T } | null = null;

  function clear(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return {
    persist(value: T): void {
      pending = { value: pending && merge ? merge(pending.value, value) : value };
      clear();
      timer = setTimeout(() => {
        timer = null;
        const p = pending;
        pending = null;
        if (p) write(p.value);
      }, delayMs);
    },

    /**
     * Write any pending value now — for teardown, before the window goes.
     * Cancels the pending timer first (not just an early fire), and returns
     * whatever `write` returns so a caller with an awaitable `write` (like
     * `saveLayoutSizes` below) can wait for the write to actually go out.
     */
    flush(): void | Promise<void> {
      clear();
      const p = pending;
      pending = null;
      if (p) return write(p.value);
    },

    cancel(): void {
      clear();
      pending = null;
    },
  };
}

/**
 * Module-level singletons, not per-render `useMemo` values.
 *
 * `<App/>` is never unmounted while its window is alive — closing a Tauri
 * window tears down that window's whole webview/JS context directly, without
 * routing through React's reconciler, so a `useEffect` cleanup on `<App/>`
 * never runs at quit (there is no `.unmount()` call anywhere in this repo).
 * A `useMemo`-scoped persister flushed only from such a cleanup is therefore
 * dead code — the debounced write is genuinely delayed, but nothing ever
 * forces it out at close time.
 *
 * The three flushes this app already relies on at close time —
 * `useAiStore`'s `flushSessionNow`, `useCheckpointsStore`'s
 * `flushCheckpointsNow`, `useEditReviewStore`'s `flushNow` — solve the same
 * problem the same way: state reachable from outside any component's render
 * scope (via `getState()`), driven from `useCloseGuard`'s
 * `onCloseRequested` (awaited, blocks the actual window close) and
 * `App.tsx`'s `beforeunload` handler (best-effort, for reload/navigation,
 * which can't await). These two persisters are wired into both the same way,
 * through `flushLayoutPersisters` below.
 *
 * Module scope here is already window-scoped, the same reason those three
 * stores never leak state between windows: each Tauri window
 * (`features/project/services/multi-window.ts`'s `new WebviewWindow(...)`)
 * boots its own copy of this JS bundle in its own webview, with its own
 * module registry. There is exactly one `layoutPersister`/`verticalPersister`
 * pair *per window*, not one shared across all open windows.
 */
export const layoutPersister = createLayoutPersister<Parameters<typeof saveLayoutSizes>[0]>(
  saveLayoutSizes,
  undefined,
  (prev, next) => ({ ...prev, ...next }),
);
export const verticalPersister = createLayoutPersister<number[]>((vertical) => saveLayoutSizes({ vertical }));

/**
 * Flushes both persisters and awaits `saveLayoutSizes`' underlying
 * `store.save()` call. This waits for the Tauri store plugin's own save()
 * to resolve — it does not, and cannot from here, guarantee an OS-level
 * fsync-to-disk beyond whatever that plugin itself provides.
 */
export async function flushLayoutPersisters(): Promise<void> {
  await Promise.all([layoutPersister.flush(), verticalPersister.flush()]);
}
