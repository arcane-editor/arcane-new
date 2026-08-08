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
 */
export function createLayoutPersister<T>(
  write: (value: T) => void,
  delayMs = 250,
): { persist(value: T): void; flush(): void; cancel(): void } {
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
      pending = { value };
      clear();
      timer = setTimeout(() => {
        timer = null;
        const p = pending;
        pending = null;
        if (p) write(p.value);
      }, delayMs);
    },

    /** Write any pending value now — for teardown, before the window goes. */
    flush(): void {
      clear();
      const p = pending;
      pending = null;
      if (p) write(p.value);
    },

    cancel(): void {
      clear();
      pending = null;
    },
  };
}
